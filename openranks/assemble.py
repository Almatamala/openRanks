"""Ensamblador L1: los clips listos y su unión en un solo vídeo vertical (§12).

Secuencia: medir → validar → normalizar cada clip (dos pasadas de ``loudnorm``) →
unir en corte seco → verificar → manifiesto. Todo automático: no hay pasos manuales
(ADR-8).

Con ``edit=True`` encadena además **L2** (la edición del estándar) sobre el
``union.mp4``: es la conveniencia del panel, pero L2 vive en su propio módulo y
solo lee archivos + manifiesto (contrato entre capas, §12).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import TOOL_VERSION
from .core import ffmpeg as ff
from .core.binding import Binding
from .core.config import Config
from .core.manifest import build_manifest, sha256_file, utc_now, write_manifest
from .core.media import MediaInfo, probe, validate_normalized, validate_ready_clip
from .core.plan import AssemblyPlan, build_plan
from .core.progress import SPAN_FULL, Progress, ProgressCallback
from .core.runner import run, tail_lines, version_of
from .overlay import OverlayResult, render as render_overlay

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
            lines.append(
                f"   edición: {self.overlay.ranking.name}"
                + ("" if self.overlay.cover is None else f" + {self.overlay.cover.name}")
            )
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
    # Sin elección explícita manda la configuración (`contain` por defecto: no
    # recorta los clips, el operador asume que ya vienen bien).
    fit = fit or cfg.fit
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = ff.resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    out_dir = Path(out_dir)
    clips_dir = out_dir / "clips"
    work_dir = out_dir / "work"
    clips_dir.mkdir(parents=True, exist_ok=True)
    work_dir.mkdir(parents=True, exist_ok=True)

    started_at = utc_now()

    # 1) Medir y validar las fuentes: un clip que no vale no se ensambla a medias.
    track.preparing(f"Midiendo los {len(binding.items)} clips")
    say(f"midiendo {len(binding.items)} clips de entrada")
    infos: dict[int, MediaInfo] = {}
    source_entries: list[dict] = []
    source_errors: list[str] = []
    for item in sorted(binding.items, key=lambda entry: entry.position, reverse=True):
        info = probe(ffprobe_bin, item.path)
        infos[item.position] = info
        check = validate_ready_clip(info, cfg)
        for warning in check.warnings:
            say(f"  aviso #{item.position}: {warning}")
        for error in check.errors:
            source_errors.append(f"#{item.position}: {error}")
        source_entries.append(info.to_source_entry(position=item.position, sha256=sha256_file(item.path)))
    if source_errors:
        raise AssemblyError("hay clips de entrada que no cumplen el contrato de L1", tuple(source_errors))

    # 2) Plan: orden #5 → #1, cold open opcional y duración real (corte seco).
    plan = build_plan(binding, infos, config=cfg, cold_open_s=cold_open_s)
    for warning in plan.warnings:
        say(f"  aviso: {warning}")

    # 3) Normalizar cada tramo a 1080x1920 / 30 fps / yuv420p, audio a −14 LUFS.
    normalized: list[Path] = []
    outputs: list[dict] = []
    collected: list[str] = []
    for index, segment in enumerate(plan.segments):
        where = "el adelanto del #1" if segment.is_cold_open else f"el clip #{segment.position}"
        track.normalizing(index, len(plan.segments), f"Preparando {where} ({index + 1} de {len(plan.segments)})")
        destination = (work_dir if segment.is_cold_open else clips_dir) / segment.output_name
        info = probe(ffprobe_bin, segment.source)
        measured = None
        if info.has_audio:
            say(f"  #{segment.position}: midiendo loudness")
            measured = _measure_loudness(ffmpeg_bin, segment.source, cfg)
        say(f"  #{segment.position}: normalizando -> {destination.relative_to(out_dir).as_posix()}")
        limit = segment.duration_s if segment.is_cold_open else None
        completed = run(
            ff.normalize_argv(
                ffmpeg_bin,
                segment.source,
                destination,
                config=cfg,
                has_audio=info.has_audio,
                fit=fit,
                measured=measured,
                limit_s=limit,
                duration_s=segment.duration_s,
            )
        )
        collected.extend(_tool_warnings(completed.stderr, where=f"#{segment.position}"))
        check = validate_normalized(probe(ffprobe_bin, destination), cfg)
        if not check.ok:
            raise AssemblyError(f"el clip normalizado #{segment.position} no cumple el formato", check.errors)
        collected.extend(f"#{segment.position}: {warning}" for warning in check.warnings)
        normalized.append(destination)
        if not segment.is_cold_open:
            outputs.append(_output_entry(ffprobe_bin, destination, kind="clip"))

    # 4) Unión de corte seco: los tramos ya comparten formato exacto, así que se pegan
    # por copia de streams, sin recodificar.
    union = out_dir / "union.mp4"
    track.joining(f"Uniendo los {len(normalized)} clips en vertical")
    say(f"uniendo {len(normalized)} tramos por copia de streams")
    list_file = work_dir / "concat.txt"
    list_file.write_text(ff.concat_list_text(normalized), encoding="utf-8")
    completed = run(ff.concat_copy_argv(ffmpeg_bin, list_file, union))
    collected.extend(_tool_warnings(completed.stderr, where="unión"))

    # 5) Verificar la unión contra el criterio de salida.
    union_info = probe(ffprobe_bin, union)
    union_check = validate_normalized(union_info, cfg)
    if not union_check.ok:
        raise AssemblyError("la unión no cumple el formato de salida", union_check.errors)
    collected.extend(f"unión: {warning}" for warning in union_check.warnings)
    collected.extend(_output_warnings(info=union_info, plan=plan, config=cfg))
    for warning in collected:
        say(f"  aviso: {warning}")
    outputs.append(_output_entry(ffprobe_bin, union, kind="union"))

    loudness = _measure_loudness(ffmpeg_bin, union, cfg) or {}

    # 6) Manifiesto.
    payload = build_manifest(
        plan=plan,
        sources=source_entries,
        outputs=outputs,
        ffmpeg_version=version_of(ffmpeg_bin),
        tool_version=TOOL_VERSION,
        config=cfg,
        started_at=started_at,
        finished_at=utc_now(),
        total_measured_s=union_info.duration_s,
        loudness_measured=loudness,
    )
    payload["measured"]["warnings"] = list(collected)
    manifest_path = write_manifest(out_dir / "manifest.json", payload)

    # 7) L2 (opcional): la edición del estándar sobre la unión recién hecha.
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
        clips=tuple(clips_dir / segment.output_name for segment in plan.segments if not segment.is_cold_open),
        union=union,
        manifest_path=manifest_path,
        plan=plan,
        total_measured_s=union_info.duration_s,
        loudness=loudness,
        extra_warnings=tuple(collected),
        overlay=overlay_result,
    )


def _tool_warnings(stderr: str | None, *, where: str) -> list[str]:
    """Lo que FFmpeg avisó y no impidió el trabajo no se tira: se registra.

    Hay un aviso **esperado** en la unión por copia: el grid de tramas AAC de cada
    segmento no encadena exacto y FFmpeg reetiqueta el DTS él solo (+1 tick). Se marca
    como benigno en vez de repetirlo tres veces, pero se reporta igual.
    """
    text = stderr or ""
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    benign = [line for line in lines if "Non-monotonic DTS" in line]
    other = [line for line in lines if "Non-monotonic DTS" not in line]
    warnings: list[str] = []
    if benign:
        warnings.append(
            f"{where}: {len(benign)} avisos benignos de ffmpeg (DTS no monótono al unir AAC por copia; "
            "ffmpeg lo reetiqueta y la unión queda monótona)"
        )
    if other:
        warnings.append(f"{where}: ffmpeg avisó -> {tail_lines(chr(10).join(other), 3)}")
    return warnings


def _measure_loudness(ffmpeg_bin: str, path: Path, cfg: Config) -> dict | None:
    """Primera pasada de ``loudnorm``: mide y no escribe salida."""
    completed = run(ff.measure_loudness_argv(ffmpeg_bin, path, cfg), check=False)
    return ff.parse_loudnorm_json(completed.stderr or "")


def _output_entry(ffprobe_bin: str, path: Path, *, kind: str) -> dict:
    info = probe(ffprobe_bin, path)
    return {
        "kind": kind,
        "file": path.name,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "duration_s": round(info.duration_s, 3),
        "width": info.width,
        "height": info.height,
        "fps": None if info.fps is None else round(info.fps, 3),
        "nominal_fps": None if info.nominal_fps is None else round(info.nominal_fps, 3),
        "nb_frames": info.nb_frames,
        "pix_fmt": info.pix_fmt,
        "has_audio": info.has_audio,
    }


def _output_warnings(*, info: MediaInfo, plan: AssemblyPlan, config: Config) -> tuple[str, ...]:
    """Verificación de la unión: fotogramas esperados y duración planificada.

    El recuento de fotogramas es la comprobación exacta (la duración del contenedor
    puede arrastrar redondeos), así que se revisa primero. Nada de esto sustituye al
    contrato de formato, que ya se validó como error.
    """
    warnings: list[str] = []

    # El montaje es de corte seco, así que no se pierde ningún fotograma: la expectativa
    # es la duración del plan (la suma de los tramos) por los fps.
    expected_frames = round(plan.total_duration_s * config.fps)
    if info.nb_frames is not None and info.nb_frames != expected_frames:
        warnings.append(f"la unión tiene {info.nb_frames} fotogramas y el plan esperaba {expected_frames}")

    expected = plan.total_duration_s
    tolerance = max(0.2, expected * 0.01)
    if abs(info.duration_s - expected) > tolerance:
        warnings.append(
            f"la unión dura {info.duration_s:.2f}s y el plan decía {expected:.2f}s "
            f"(tolerancia {tolerance:.2f}s): revisa las fuentes"
        )
    return tuple(warnings)
