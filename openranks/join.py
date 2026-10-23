"""Unión de los clips ya preparados en el ``union.mp4`` (§12).

Es el paso barato del montaje: los clips ya comparten formato exacto, así que se pegan
por **copia de streams** (sin recodificar). Con los clips preparados de antemano, el
panel puede dejar la unión hecha antes de que el operador pulse «Montar»: así ese botón
solo compone la edición (L2).

Dos caminos comparten este módulo:

* ``join`` — el del panel: lee ``prepared/NN.json`` y solo une.
* ``join_clips`` — la pieza que también usa el ensamblador completo (``assemble``),
  para no tener dos uniones distintas.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

from . import TOOL_VERSION
from .core import ffmpeg as ff
from .core.config import Config
from .core.manifest import build_manifest, sha256_file, utc_now, write_manifest
from .core.media import MediaInfo, probe, validate_normalized
from .core.plan import AssemblyPlan, PlanError, PreparedInput, plan_from_prepared
from .core.progress import SPAN_JOIN, Progress, ProgressCallback
from .core.runner import run, stderr_warnings, version_of
from .prepare import PrepareError, prepared_file, read_metadata

Logger = Callable[[str], None]


class JoinError(RuntimeError):
    """La unión no puede continuar (faltan clips preparados o el formato no cuadra)."""

    def __init__(self, message: str, reasons: tuple[str, ...] = ()) -> None:
        self.reasons = reasons
        detail = "" if not reasons else ": " + "; ".join(reasons)
        super().__init__(message + detail)


@dataclass(frozen=True)
class StagedInput:
    """Un tramo listo para la unión: el archivo normalizado y su trazabilidad."""

    position: int
    path: Path
    source_entry: dict
    output_entry: dict
    warnings: tuple[str, ...] = ()


@dataclass
class JoinResult:
    union: Path
    manifest_path: Path
    plan: AssemblyPlan
    total_measured_s: float | None = None
    loudness: dict = field(default_factory=dict)
    warnings: tuple[str, ...] = ()

    def summary(self, *, prefix: str = "OK") -> str:
        lines = [
            f"{prefix} {self.union}",
            f"   {self.plan.clip_count} puestos · "
            f"{self.plan.total_duration_s:.2f}s"
            + ("" if self.total_measured_s is None else f" · medida {self.total_measured_s:.2f}s"),
            "   listo para montar la edición",
        ]
        for warning in self.warnings:
            lines.append(f"   aviso: {warning}")
        return "\n".join(lines)


def _noop(_: str) -> None:
    return None


def _output_entry(path: Path, info: MediaInfo, *, kind: str) -> dict:
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


def join_clips(
    plan: AssemblyPlan,
    staged: Sequence[StagedInput],
    out_dir: str | Path,
    *,
    config: Config,
    ffmpeg: str,
    ffprobe: str,
    track: Progress | None = None,
    log: Logger | None = None,
) -> JoinResult:
    """Pega los tramos por copia de streams y escribe el manifiesto de L1.

    ``plan.segments`` da el orden (#5 → #1) y ``staged`` aporta los archivos ya
    normalizados.
    """
    say = log or _noop
    tracker = track or Progress()
    out_dir = Path(out_dir)
    work_dir = out_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)

    by_position = {entry.position: entry for entry in staged}
    files: list[Path] = []
    for segment in plan.segments:
        entry = by_position.get(segment.position)
        if entry is None:
            raise JoinError(f"falta el clip preparado del puesto #{segment.position}")
        if not entry.path.is_file():
            raise JoinError(f"no existe el clip preparado del puesto #{segment.position}: {entry.path.name}")
        files.append(entry.path)

    started_at = utc_now()
    collected: list[str] = [warning for entry in staged for warning in entry.warnings]

    union = out_dir / "union.mp4"
    tracker.joining(f"Uniendo los {len(files)} clips en vertical")
    say(f"uniendo {len(files)} tramos por copia de streams")
    list_file = work_dir / "concat.txt"
    list_file.write_text(ff.concat_list_text(files), encoding="utf-8")
    completed = run(ff.concat_copy_argv(ffmpeg, list_file, union))
    collected.extend(stderr_warnings(completed.stderr, where="unión"))

    # Verificar la unión contra el criterio de salida.
    union_info = probe(ffprobe, union)
    union_check = validate_normalized(union_info, config)
    if not union_check.ok:
        raise JoinError("la unión no cumple el formato de salida", tuple(union_check.errors))
    collected.extend(f"unión: {warning}" for warning in union_check.warnings)
    collected.extend(_output_warnings(info=union_info, plan=plan, config=config))

    # La medición de la unión es informativa (los clips ya entraron a −14 LUFS): se
    # aprovecha que la unión es una copia, pero no bloquea si no se puede medir.
    loudness = _measure_loudness(ffmpeg, union, config) or {}

    for warning in collected:
        say(f"  aviso: {warning}")

    outputs = [entry.output_entry for entry in staged]
    outputs.append(_output_entry(union, union_info, kind="union"))

    payload = build_manifest(
        plan=plan,
        sources=[entry.source_entry for entry in staged],
        outputs=outputs,
        ffmpeg_version=version_of(ffmpeg),
        tool_version=TOOL_VERSION,
        config=config,
        started_at=started_at,
        finished_at=utc_now(),
        total_measured_s=union_info.duration_s,
        loudness_measured=loudness,
    )
    payload["measured"]["warnings"] = list(collected)
    manifest_path = write_manifest(out_dir / "manifest.json", payload)

    return JoinResult(
        union=union,
        manifest_path=manifest_path,
        plan=plan,
        total_measured_s=union_info.duration_s,
        loudness=loudness,
        warnings=tuple(collected),
    )


def join(
    out_dir: str | Path,
    *,
    title: str = "",
    subtitle: str = "",
    labels: dict[int, str] | None = None,
    positions: int | None = None,
    config: Config | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    log: Logger | None = None,
    progress: ProgressCallback | None = None,
    track: Progress | None = None,
) -> JoinResult:
    """Une los clips que ya están preparados en ``<salida>/prepared/``.

    No normaliza nada ni mira los videos originales: si un puesto no tiene su tick, la
    unión falla con un mensaje que el panel puede enseñar tal cual.
    """
    say = log or _noop
    cfg = config or Config.from_env()
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = ff.resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")
    out_dir = Path(out_dir)
    tracker = track or Progress(progress, span=SPAN_JOIN)

    count = int(positions or cfg.items)
    missing: list[int] = []
    inputs: list[PreparedInput] = []
    staged: list[StagedInput] = []
    for position in range(1, count + 1):
        try:
            payload = read_metadata(out_dir, position)
        except PrepareError:
            missing.append(position)
            continue
        path = prepared_file(out_dir, position)
        if not path.is_file():
            missing.append(position)
            continue
        source = payload.get("source") or {}
        clip = payload.get("clip") or {}
        label = (labels or {}).get(position, "")
        inputs.append(
            PreparedInput(
                position=position,
                path=path,
                label=label,
                duration_s=float(source.get("duration_s") or 0.0),
            )
        )
        staged.append(
            StagedInput(
                position=position,
                path=path,
                source_entry=source,
                output_entry={**clip, "kind": "clip", "file": f"prepared/{clip.get('file', path.name)}"},
                warnings=tuple(payload.get("warnings") or ()),
            )
        )

    if missing:
        raise JoinError(f"faltan los clips preparados de los puestos: {missing}")

    try:
        plan = plan_from_prepared(inputs, title=title, subtitle=subtitle, config=cfg)
    except PlanError as exc:
        raise JoinError("no se pudo planificar la unión", (str(exc),)) from exc

    # La unión anterior ya no vale: la edición que hubiera encima tampoco.
    for stale in ("ranking.mp4", "spec.json"):
        (out_dir / stale).unlink(missing_ok=True)

    result = join_clips(
        plan,
        staged,
        out_dir,
        config=cfg,
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
        track=tracker,
        log=say,
    )
    tracker.finishing("Unión lista")
    return result


def _measure_loudness(ffmpeg_bin: str, path: Path, cfg: Config) -> dict | None:
    """Primera pasada de ``loudnorm`` sobre la unión: mide y no escribe salida."""
    completed = run(ff.measure_loudness_argv(ffmpeg_bin, path, cfg), check=False)
    return ff.parse_loudnorm_json(completed.stderr or "")
