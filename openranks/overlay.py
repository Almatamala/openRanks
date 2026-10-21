"""L2 — la edición del estándar sobre el ``union.mp4`` que produjo L1 (§12).

Sobre el vídeo ya unido se añade **toda la edición del formato**: título con el
número destacado, la escalera de rangos (``#5`` abajo → ``#1`` arriba) y el rótulo
de cada puesto. La salida es ``ranking.mp4`` + ``spec.json``.

Contrato entre capas (§12): L2 **solo** lee ``union.mp4`` y el ``manifest.json`` de
L1, nunca llama a L1. Y como el estilo está bloqueado (ADR-8), cambiar solo un texto
se resuelve **re-renderizando el overlay**, no volviendo a montar el vídeo.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import TOOL_VERSION
from .core import ffmpeg as ff
from .core.config import Config
from .core.media import probe, validate_normalized
from .core.manifest import sha256_file, utc_now, write_manifest
from .core.overlay import build_ass, cover_argv, get_style, overlay_argv, preview_argv
from .core.progress import SPAN_EDIT_ONLY, Progress, ProgressCallback
from .core.runner import run, stderr_warnings
from .core.specs import SpecError, build_spec, labels_from_segments

Logger = Callable[[str], None]


class OverlayError(RuntimeError):
    """El render del overlay no puede continuar."""

    def __init__(self, message: str, reasons: tuple[str, ...] = ()) -> None:
        self.reasons = reasons
        detail = "" if not reasons else ": " + "; ".join(reasons)
        super().__init__(message + detail)


@dataclass
class OverlayResult:
    out_dir: Path
    ranking: Path
    cover: Path | None
    spec_path: Path
    spec: dict
    render_ms: int | None = None
    extra_warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def warnings(self) -> tuple[str, ...]:
        return self.extra_warnings

    def summary(self, *, prefix: str = "OK") -> str:
        lines = [
            f"{prefix} {self.ranking.relative_to(self.out_dir).as_posix()}",
            f"   {self.spec['total_duration_s']:.2f}s · "
            f"{len(self.spec['rank_ladder']['slots'])} puestos editados",
            f"   spec: {self.spec_path.name}",
        ]
        if self.cover is not None:
            lines.append(f"   portada: {self.cover.name}")
        for warning in self.warnings:
            lines.append(f"   aviso: {warning}")
        return "\n".join(lines)


def _noop(_: str) -> None:
    return None


# Duración sintética de cada tramo en la vista previa: no hay clips, solo hace
# falta que la línea temporal tenga un tamaño razonable para dibujar el overlay.
PREVIEW_SEGMENT_S = 6.0


@dataclass
class PreviewResult:
    """Fotograma del overlay sobre negro: cómo se ve el preset antes de montar."""

    path: Path
    at_s: float
    spec: dict

    def summary(self, *, prefix: str = "OK") -> str:
        return f"{prefix} {self.path}\n   vista previa del preset a {self.at_s:.2f}s ({self.path.name})"


def preview(
    dst: str | Path,
    *,
    title: str = "",
    subtitle: str = "",
    labels: dict[int, str] | None = None,
    style_overrides: dict | None = None,
    font: str | None = None,
    at_s: float | None = None,
    config: Config | None = None,
    ffmpeg: str | None = None,
) -> PreviewResult:
    """Dibuja el preset sobre **negro** en un PNG, sin clips y sin montar nada.

    Reutiliza el **mismo** `build_ass` que el render final sobre una línea temporal
    sintética con tantos puestos como el ranking (`config.items`, de 5 a 10), así que lo
    que se ve aquí es lo que saldrá en el vídeo.
    """
    cfg = config or Config.from_env()
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    style = get_style(style_overrides)
    if font:
        style["font"] = font

    count = max(1, int(cfg.items))
    segments = [
        {"position": position, "label": f"PUESTO {position}", "duration_s": PREVIEW_SEGMENT_S}
        for position in range(count, 0, -1)
    ]
    final_labels = {position: f"PUESTO {position}" for position in range(1, count + 1)}
    if labels:
        final_labels.update({int(position): text for position, text in labels.items()})

    try:
        spec = build_spec(
            title=title,
            subtitle=subtitle,
            labels=final_labels,
            segments=segments,
            cold_open_s=0.0,
            style=style,
            config=cfg,
        )
    except SpecError as exc:
        raise OverlayError("no se pudo construir el spec de la vista previa", (str(exc),)) from exc

    total = spec["total_duration_s"]
    at = float(at_s) if at_s is not None else max(0.0, total - 0.3)

    destination = Path(dst)
    destination.parent.mkdir(parents=True, exist_ok=True)
    work_dir = destination.parent / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    ass_file = work_dir / "preview.ass"
    ass_file.write_text(build_ass(spec, style, cfg), encoding="utf-8")
    run(preview_argv(ffmpeg_bin, destination, ass_file=ass_file, at_s=at, config=cfg))
    return PreviewResult(path=destination, at_s=round(at, 3), spec=spec)


def _load_plan(out_dir: Path) -> dict:
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.is_file():
        raise OverlayError(f"falta el manifiesto de L1 en {out_dir.name}: ejecuta `assemble` primero")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise OverlayError("el manifiesto de L1 no es JSON válido") from exc
    plan = payload.get("plan")
    if not isinstance(plan, dict) or not plan.get("segments"):
        raise OverlayError("el manifiesto de L1 no trae plan de ensamblado")
    return {"manifest": payload, "plan": plan, "path": manifest_path}


def render(
    out_dir: str | Path,
    *,
    title: str | None = None,
    subtitle: str | None = None,
    labels: dict[int, str] | None = None,
    style_overrides: dict | None = None,
    font: str | None = None,
    config: Config | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    log: Logger | None = None,
    track: Progress | None = None,
    progress: ProgressCallback | None = None,
) -> OverlayResult:
    """Compone el overlay sobre ``out_dir/union.mp4`` y escribe ``ranking.mp4``.

    ``title``, ``subtitle`` y ``labels`` son los **únicos** campos editables (ADR-8); si no
    se pasan, se toman los del manifiesto de L1.

    ``track`` permite compartir la barra con el ensamblador para que el porcentaje
    no dé un salto atrás; en solitario (`openranks render`) se crea una barra propia.
    """
    say = log or _noop
    tracker = track or Progress(progress, span=SPAN_EDIT_ONLY)
    cfg = config or Config.from_env()
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = ff.resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    out_dir = Path(out_dir)
    union = out_dir / "union.mp4"
    if not union.is_file():
        raise OverlayError("falta union.mp4: L2 se compone sobre la salida de L1")

    loaded = _load_plan(out_dir)
    plan = loaded["plan"]
    segments = plan["segments"]
    cold_open_s = float(plan.get("cold_open_s") or 0.0)

    # `get_style` ya resuelve `OPENRANKS_FONT`; aquí solo manda un `--font` explícito.
    style = get_style(style_overrides)
    if font:
        style["font"] = font
    final_title = (title if title is not None else plan.get("title", "")).strip()
    # El subtítulo es opcional y viaja con el plan (L1 → manifiesto → L2), igual que el
    # título. `--subtitle ""` lo quita sin volver a montar.
    final_subtitle = (subtitle if subtitle is not None else plan.get("subtitle", "")).strip()
    final_labels = dict(labels_from_segments(segments))
    if labels:
        final_labels.update({int(position): text for position, text in labels.items()})

    started_at = utc_now()
    try:
        spec = build_spec(
            title=final_title,
            subtitle=final_subtitle,
            labels=final_labels,
            segments=segments,
            cold_open_s=cold_open_s,
            style=style,
            config=cfg,
        )
    except SpecError as exc:
        raise OverlayError("no se pudo construir el spec del overlay", (str(exc),)) from exc

    work_dir = out_dir / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    ass_file = work_dir / "overlay.ass"
    tracker.editing_step(0.08, "Preparando la edición")
    ass_file.write_text(build_ass(spec, style, cfg), encoding="utf-8")

    tracker.editing_step(0.25, "Dibujando el título, la escalera y los rótulos")
    say(f"componiendo la edición sobre {union.name} ({spec['total_duration_s']:.2f}s)")
    ranking = out_dir / "ranking.mp4"
    if ranking.exists():
        ranking.unlink()  # si no, ffmpeg puede mezclar la salida anterior
    completed = run(overlay_argv(ffmpeg_bin, union, ranking, ass_file=ass_file, config=cfg))
    warnings = stderr_warnings(completed.stderr, where="overlay")

    info = probe(ffprobe_bin, ranking)
    check = validate_normalized(info, cfg)
    if not check.ok:
        raise OverlayError("el ranking renderizado no cumple el formato de salida", check.errors)
    warnings.extend(f"ranking: {warning}" for warning in check.warnings)

    cover: Path | None = None
    if info.duration_s > 0:
        tracker.editing_step(0.9, "Sacando la portada")
        cover = out_dir / "cover.jpg"
        run(cover_argv(ffmpeg_bin, ranking, cover, at_s=max(0.0, info.duration_s - 0.4)))

    spec_path = write_manifest(out_dir / "spec.json", spec)

    payload = loaded["manifest"]
    payload["render"] = {
        "layer": "L2",
        "tool_version": TOOL_VERSION,
        "started_at": started_at,
        "finished_at": utc_now(),
        "preset": style.get("theme"),
        "spec": spec_path.name,
        "ranking": {"file": ranking.name, "sha256": sha256_file(ranking), "bytes": ranking.stat().st_size},
        "cover": None if cover is None else cover.name,
        "measured": {
            "duration_s": round(info.duration_s, 3),
            "width": info.width,
            "height": info.height,
            "fps": None if info.fps is None else round(info.fps, 3),
            "nb_frames": info.nb_frames,
            "pix_fmt": info.pix_fmt,
        },
        "edit": {
            "title": final_title,
            "subtitle": final_subtitle,
            "labels": {str(position): text for position, text in sorted(final_labels.items(), reverse=True)},
            "note": "(ADR-8) solo el título, el subtítulo opcional y los nombres de los puestos son editables",
        },
        "warnings": list(warnings),
    }
    write_manifest(loaded["path"], payload)
    tracker.finishing("Edición lista")

    return OverlayResult(
        out_dir=out_dir,
        ranking=ranking,
        cover=cover,
        spec_path=spec_path,
        spec=spec,
        extra_warnings=tuple(warnings),
    )
