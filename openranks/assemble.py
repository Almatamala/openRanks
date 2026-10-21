"""Ensamblador L1 completo: los clips listos y su unión en un solo vídeo vertical (§12).

Secuencia: medir → validar → preparar cada clip (dos pasadas de ``loudnorm``) → unir
en corte seco → verificar → manifiesto. Todo automático: no hay pasos manuales (ADR-8).

Las dos piezas caras viven en sus módulos (``prepare.prepare_clip`` y
``join.join_clips``) porque el panel las ejecuta **por separado**: prepara cada clip al
subirlo y deja la unión hecha antes de que el operador pulse «Montar». Aquí solo se
encadenan, para que por CLI siga habiendo un comando que lo hace todo.

Con ``edit=True`` encadena además **L2** (la edición del estándar) sobre el
``union.mp4``: es la conveniencia del panel, pero L2 vive en su propio módulo y
solo lee archivos + manifiesto (contrato entre capas, §12).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .core import ffmpeg as ff
from .core.binding import Binding
from .core.config import Config
from .core.framing import FramingDecision, FramingError, fallback_decision
from .core.manifest import sha256_file
from .core.media import MediaInfo, probe, validate_ready_clip
from .core.plan import AssemblyPlan, build_plan
from .core.progress import SPAN_FULL, Progress, ProgressCallback
from .framing import analyze
from .join import JoinResult, join_clips, staged_from_prepared
from .overlay import OverlayResult, render as render_overlay
from .prepare import PreparedClip, PrepareError, prepare_clip

Logger = Callable[[str], None]


class AssemblyError(RuntimeError):
    """El ensamblado no puede continuar."""

    def __init__(self, message: str, reasons: tuple[str, ...] = ()) -> None:
        self.reasons = reasons
        detail = "" if not reasons else ": " + "; ".join(reasons)
        super().__init__(message + detail)


@dataclass
class AssemblyResult:
    out_dir: Path
    clips: tuple[Path, ...]
    union: Path
    manifest_path: Path
    plan: AssemblyPlan
    total_measured_s: float | None = None
    loudness: dict = field(default_factory=dict)
    extra_warnings: tuple[str, ...] = ()
    overlay: OverlayResult | None = None

    @property
    def warnings(self) -> tuple[str, ...]:
        """Avisos del plan más los que aparecieron al ejecutarlo (nunca se descartan)."""
        return self.plan.warnings + self.extra_warnings

    def summary(self, *, prefix: str = "OK") -> str:
        lines = [
            f"{prefix} {self.out_dir}",
            f"   {len(self.clips)} clips listos + union.mp4",
            f"   duración planificada {self.plan.total_duration_s:.2f}s"
            + (
                ""
                if self.total_measured_s is None
                else f" · medida {self.total_measured_s:.2f}s"
            ),
        ]
        if self.loudness.get("input_i"):
            lines.append(f"   loudness medida {self.loudness['input_i']} LUFS")
        for segment in self.plan.segments:
            lines.append(f"   #{segment.position:<2} {segment.output_name} ({segment.label})")
        if self.overlay is not None:
            lines.append(f"   edición: {self.overlay.ranking.name}")
        for warning in self.warnings:
            lines.append(f"   aviso: {warning}")
        return "\n".join(lines)


def _noop(_: str) -> None:
    return None


def assemble(
    binding: Binding,
    out_dir: str | Path,
    *,
    config: Config | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    fit: str | None = None,
    cold_open_s: float = 0.0,
    edit: bool = False,
    style_overrides: dict | None = None,
    log: Logger | None = None,
    progress: ProgressCallback | None = None,
) -> AssemblyResult:
    """Ejecuta L1 completo y, con ``edit=True``, también L2 sobre la unión.

    ``progress`` recibe el avance en porcentaje real (§RF-9.3): el panel lo usa para
    la barra y para estimar el tiempo restante. Es opcional: sin callback, el
    ensamblado se comporta igual.
    """
    say = log or _noop
    track = Progress(progress, span=SPAN_FULL)
    cfg = config or Config.from_env()
    # Sin elección explícita manda la configuración (`auto` por defecto: detecta el
    # área útil y, si no hay confianza, rellena con negro sin recortar).
    fit = fit or cfg.fit
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = ff.resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    out_dir = Path(out_dir)
    clips_dir = out_dir / "clips"
    work_dir = out_dir / "work"
    clips_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    # 1) Medir y validar las fuentes: un clip que no vale no se ensambla a medias.
    track.preparing(f"Midiendo los {len(binding.items)} clips")
    say(f"midiendo {len(binding.items)} clips de entrada")
    infos: dict[int, MediaInfo] = {}
    source_entries: list[dict] = []
    source_errors: list[str] = []
    decisions: dict[Path, FramingDecision] = {}
    for item in sorted(binding.items, key=lambda entry: entry.position, reverse=True):
        info = probe(ffprobe_bin, item.path)
        infos[item.position] = info
        check = validate_ready_clip(info, cfg)
        for warning in check.warnings:
            say(f"  aviso #{item.position}: {warning}")
        for error in check.errors:
            source_errors.append(f"#{item.position}: {error}")

        entry = info.to_source_entry(position=item.position, sha256=sha256_file(item.path))
        if fit == "auto" and check.ok:
            decision = decisions.get(item.path)
            if decision is None:
                try:
                    decision = analyze(ffmpeg_bin, item.path, info, config=cfg)
                except (FramingError, OSError) as exc:
                    visible = (info.display_width or info.width or 0, info.display_height or info.height or 0)
                    decision = fallback_decision(
                        input_size=(info.width or 0, info.height or 0),
                        visible_size=visible,
                        rotation=info.rotation,
                        reason="no se pudo analizar el encuadre",
                        warning=f"no se pudo analizar el encuadre ({exc}); se rellena con negro sin recortar",
                    )
                decisions[item.path] = decision
                say(f"  #{item.position}: {decision.reason} (confianza {decision.confidence:.2f})")
                for warning in decision.warnings:
                    say(f"  aviso #{item.position}: {warning}")
            entry["framing"] = decision.to_manifest()
        source_entries.append(entry)
    if source_errors:
        raise AssemblyError("hay clips de entrada que no cumplen el contrato de L1", tuple(source_errors))

    # 2) Plan: orden #5 → #1, cold open opcional y duración real (corte seco).
    plan = build_plan(binding, infos, config=cfg, cold_open_s=cold_open_s)
    for warning in plan.warnings:
        say(f"  aviso: {warning}")

    # 3) Preparar cada tramo: encuadre, 1080x1920 / 30 fps / yuv420p y audio a −14 LUFS.
    # El cold open reutiliza la fuente del #1 y solo se recorta al final, así que se
    # prepara después del clip completo.
    prepared: dict[int, PreparedClip] = {}
    total_steps = len(plan.segments)
    done = 0
    for segment in plan.segments:
        if segment.is_cold_open:
            continue
        where = f"Preparando el clip #{segment.position} ({done + 1} de {total_steps})"
        track.normalizing(done, total_steps, where)
        info = infos[segment.position]
        try:
            clip = prepare_clip(
                segment.source,
                clips_dir / segment.output_name,
                position=segment.position,
                config=cfg,
                ffmpeg=ffmpeg_bin,
                ffprobe=ffprobe_bin,
                fit=fit,
                info=info,
                decision=decisions.get(segment.source),
                log=say,
            )
        except PrepareError as exc:
            raise AssemblyError(f"no se pudo preparar el clip #{segment.position}", exc.reasons) from exc
        prepared[segment.position] = clip
        done += 1

    for segment in plan.segments:
        if not segment.is_cold_open:
            continue
        track.normalizing(done, total_steps, "Preparando el adelanto del #1")
        info = infos[binding.best.position]
        try:
            prepared[0] = prepare_clip(
                segment.source,
                work_dir / segment.output_name,
                position=0,
                config=cfg,
                ffmpeg=ffmpeg_bin,
                ffprobe=ffprobe_bin,
                fit=fit,
                limit_s=segment.duration_s,
                info=info,
                decision=decisions.get(segment.source),
                log=say,
            )
        except PrepareError as exc:
            raise AssemblyError("no se pudo preparar el adelanto del #1", exc.reasons) from exc
        done += 1

    # 4) Unión por copia de streams + verificación + manifiesto.
    staged = [
        staged_from_prepared(prepared[segment.position])
        for segment in plan.segments
    ]
    try:
        joined: JoinResult = join_clips(
            plan,
            staged,
            out_dir,
            config=cfg,
            ffmpeg=ffmpeg_bin,
            ffprobe=ffprobe_bin,
            source_entries=source_entries,
            track=track,
            log=say,
        )
    except Exception as exc:
        if isinstance(exc, AssemblyError):
            raise
        raise AssemblyError("no se pudo unir el vídeo", (str(exc),)) from exc

    # 5) L2 (opcional): la edición del estándar sobre la unión recién hecha.
    overlay_result: OverlayResult | None = None
    if edit:
        say("añadiendo la edición (L2)")
        overlay_result = render_overlay(
            out_dir,
            style_overrides=style_overrides,
            config=cfg,
            ffmpeg=ffmpeg_bin,
            ffprobe=ffprobe_bin,
            log=say,
            track=track,
        )
        for warning in overlay_result.warnings:
            say(f"  aviso: {warning}")

    track.finishing("Listo")

    return AssemblyResult(
        out_dir=out_dir,
        clips=tuple(prepared[segment.position].output for segment in plan.segments if not segment.is_cold_open),
        union=joined.union,
        manifest_path=joined.manifest_path,
        plan=plan,
        total_measured_s=joined.total_measured_s,
        loudness=joined.loudness,
        extra_warnings=joined.warnings,
        overlay=overlay_result,
    )
