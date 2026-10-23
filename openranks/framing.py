"""Análisis del encuadre de un clip de entrada con FFmpeg.

El núcleo puro (``openranks/core/framing.py``) decide a partir de fotogramas en
gris; este módulo los extrae y afina los bordes a resolución completa. No ejecuta el
montaje: el preparador usa la geometría resultante y construye su propio ``argv`` con
``normalize_argv``.
"""

from __future__ import annotations

import subprocess
from dataclasses import replace
from pathlib import Path
from statistics import median

from .core.config import Config
from .core.framing import (
    CENTER_TOLERANCE,
    INSET_PX,
    MAX_USEFUL_RATIO,
    MIN_FRAMES,
    MIN_USEFUL_RATIO,
    Crop,
    FramingDecision,
    FramingError,
    GrayFrame,
    analyze_frames,
    decision_without_analysis,
    even_floor,
    needs_analysis,
    normalise,
    p95,
    refine_edge,
)
from .core.media import MediaInfo

# Ancho del muestreo. 192 px da ~10 px de origen por columna en un 1080p; el borde
# fino se afina después a resolución completa, así que no hace falta más.
ANALYSIS_WIDTH = 192
ANALYSIS_FRAMES = 12
REFINE_FRAMES = 2
REFINE_RADIUS = 64


class AnalysisError(FramingError):
    """No se pudieron extraer fotogramas para analizar el encuadre."""


def _even(value: int) -> int:
    return max(2, int(round(float(value) / 2.0)) * 2)


def visible_size(info: MediaInfo) -> tuple[int, int]:
    """Tamaño que ve el reproductor (con la rotación ya aplicada)."""
    width = info.display_width or info.width
    height = info.display_height or info.height
    if not width or not height:
        raise AnalysisError(f"no se pudo leer la resolución de {info.path.name}")
    return int(width), int(height)


def sample_window(duration_s: float) -> tuple[float, float, int]:
    """Ventana de muestreo: evita los extremos y reparte los fotogramas."""
    duration = max(0.05, float(duration_s or 0.0))
    if duration <= 0.6:
        return 0.0, duration, max(MIN_FRAMES, 6)
    start = min(0.2, duration * 0.10)
    end = max(start + 0.1, duration - 0.2)
    return start, end - start, ANALYSIS_FRAMES


def frame_argv(
    ffmpeg: str,
    src: Path,
    *,
    width: int,
    height: int,
    count: int,
    start_s: float,
    span_s: float,
) -> list[str]:
    """Un solo pase de FFmpeg: fotogramas en gris, sin audio ni metadatos."""
    width = _even(width)
    height = _even(height)
    fps = max(0.1, float(count) / max(0.05, span_s))
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, float(start_s)):.3f}",
        "-i",
        str(src),
        "-t",
        f"{max(0.05, float(span_s)):.3f}",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        f"fps={fps:.6f},scale={width}:{height}:flags=area,format=gray",
        "-frames:v",
        str(max(1, int(count))),
        "-f",
        "rawvideo",
        "-",
    ]


def _read_frames(raw: bytes, *, width: int, height: int, count: int) -> list[GrayFrame]:
    size = width * height
    available = len(raw) // size
    if available <= 0:
        raise AnalysisError("FFmpeg no devolvió ningún fotograma para analizar")
    return [
        GrayFrame(width=width, height=height, pixels=raw[index * size : (index + 1) * size])
        for index in range(min(int(count), available))
    ]


def extract_frames(
    ffmpeg: str,
    src: Path,
    *,
    width: int,
    height: int,
    count: int,
    start_s: float,
    span_s: float,
    timeout_s: int = 120,
) -> list[GrayFrame]:
    argv = frame_argv(
        ffmpeg,
        src,
        width=width,
        height=height,
        count=count,
        start_s=start_s,
        span_s=span_s,
    )
    try:
        completed = subprocess.run(  # noqa: S603 - argv sin shell, binario resuelto por el llamador
            argv,
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AnalysisError(f"FFmpeg tardó demasiado en muestrear {src.name}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()[:400]
        raise AnalysisError(f"FFmpeg no pudo muestrear {src.name}: {detail}")
    return _read_frames(
        completed.stdout,
        width=_even(width),
        height=_even(height),
        count=count,
    )


def analysis_size(visible: tuple[int, int]) -> tuple[int, int]:
    width, height = visible
    target_width = max(16, min(ANALYSIS_WIDTH, _even(width)))
    target_height = max(16, _even(round(height * target_width / max(1, width))))
    return target_width, target_height


def _strip_column_scores(frames: list[GrayFrame], x0: int, x1: int) -> list[float]:
    """Nitidez por columna dentro de una franja vertical de la imagen completa."""
    width, height = frames[0].width, frames[0].height
    x0 = max(0, min(width - 2, x0))
    x1 = max(x0 + 2, min(width, x1))
    per_frame: list[list[float]] = []
    for frame in frames:
        local = [0.0] * (x1 - x0)
        pixels = frame.pixels
        for y in range(1, height - 1):
            base = y * width
            for x in range(max(1, x0), min(width - 1, x1)):
                local[x - x0] += abs(pixels[base + x + 1] - pixels[base + x - 1])
        local[0] = local[1]
        local[-1] = local[-2]
        per_frame.append(normalise(local, p95(local)))
    return [median([frame[x] for frame in per_frame]) for x in range(x1 - x0)]


def _strip_row_scores(frames: list[GrayFrame], y0: int, y1: int, x0: int, x1: int) -> list[float]:
    """Nitidez por fila dentro de una franja horizontal de la imagen completa."""
    width, height = frames[0].width, frames[0].height
    y0 = max(0, min(height - 2, y0))
    y1 = max(y0 + 2, min(height, y1))
    x0 = max(1, min(width - 2, x0))
    x1 = max(x0 + 1, min(width - 1, x1))
    per_frame: list[list[float]] = []
    for frame in frames:
        local = [0.0] * (y1 - y0)
        pixels = frame.pixels
        for y in range(max(1, y0), min(height - 1, y1)):
            base = y * width
            for x in range(x0, x1):
                local[y - y0] += abs(pixels[base + x + width] - pixels[base + x - width])
        local[0] = local[1]
        local[-1] = local[-2]
        per_frame.append(normalise(local, p95(local)))
    return [median([frame[y] for frame in per_frame]) for y in range(y1 - y0)]


def refine_crop(crop: Crop, frames: list[GrayFrame], visible: tuple[int, int]) -> tuple[Crop, tuple[str, ...]]:
    """Afina los cuatro bordes a resolución completa.

    El muestreo reducido decide **dónde** está el área útil; este paso busca el salto
    exacto de nitidez en una franja de ±32 px y recorta 3 px hacia adentro.
    """
    width, height = visible
    warnings: list[str] = []
    half = REFINE_RADIUS

    left, right = crop.x, crop.right
    left_refined = right_refined = False
    lx0, lx1 = max(0, crop.x - half), min(width, crop.x + half)
    if lx1 - lx0 >= 8:
        scores = _strip_column_scores(frames, lx0, lx1)
        left = lx0 + refine_edge(scores, crop.x - lx0, rising=True, radius=half)
        left_refined = True
    rx0, rx1 = max(0, crop.right - half), min(width, crop.right + half)
    if rx1 - rx0 >= 8:
        scores = _strip_column_scores(frames, rx0, rx1)
        right = rx0 + refine_edge(scores, crop.right - rx0, rising=False, radius=half)
        right_refined = True

    top, bottom = crop.y, crop.bottom
    row_refined = False
    if crop.h < height * MAX_USEFUL_RATIO:
        row_refined = True
        ty0, ty1 = max(0, crop.y - half), min(height, crop.y + half)
        if ty1 - ty0 >= 8:
            scores = _strip_row_scores(frames, ty0, ty1, left, right)
            top = ty0 + refine_edge(scores, crop.y - ty0, rising=True, radius=half)
        by0, by1 = max(0, crop.bottom - half), min(height, crop.bottom + half)
        if by1 - by0 >= 8:
            scores = _strip_row_scores(frames, by0, by1, left, right)
            bottom = by0 + refine_edge(scores, crop.bottom - by0, rising=False, radius=half)

    # Solo se recorta hacia adentro el borde que se acaba de afinar; si no, un borde
    # que se quedó en el valor grueso perdería 3 px por segunda vez.
    if left_refined:
        left += INSET_PX
    if right_refined:
        right -= INSET_PX
    if row_refined:
        top += INSET_PX
        bottom -= INSET_PX
    if right - left < 16 or bottom - top < 16:
        return crop, warnings

    left, top = even_floor(left), even_floor(top)
    new_width, new_height = _even(right - left), _even(bottom - top)
    if left + new_width > width:
        left = even_floor(width - new_width)
    if top + new_height > height:
        top = even_floor(height - new_height)
    if left < 0 or top < 0 or new_width <= 0 or new_height <= 0:
        return crop, warnings

    if new_width < width * MIN_USEFUL_RATIO or new_width > width * MAX_USEFUL_RATIO:
        return crop, (*warnings, "el refino del ancho no es creíble; se usa el recorte grueso")
    if abs(left + new_width / 2 - width / 2) / width > CENTER_TOLERANCE:
        return crop, (*warnings, "el refino descentró el área útil; se usa el recorte grueso")

    return Crop(w=new_width, h=new_height, x=left, y=top), warnings


def _with_crop(
    decision: FramingDecision,
    crop: Crop,
    warnings: tuple[str, ...],
    *,
    target: tuple[int, int],
) -> FramingDecision:
    signals = dict(decision.signals)
    signals.update(
        {
            "ancho_util_pct": round(crop.w / decision.visible_size[0] * 100, 1),
            "alto_util_pct": round(crop.h / decision.visible_size[1] * 100, 1),
            "centrado_px": round(crop.x + crop.w / 2 - decision.visible_size[0] / 2, 1),
        }
    )
    # El aviso de aspecto se recalcula con el crop ya afinado: el grueso podía ser
    # 20 px más ancho y dejar un aviso que ya no correspondía.
    kept = tuple(warning for warning in decision.warnings if "más ancha que 9:16" not in warning)
    ratio = crop.w / crop.h
    wanted = target[0] / target[1]
    if ratio > wanted * 1.05:
        kept += ("el área útil es más ancha que 9:16; quedará con barras arriba y abajo",)
    elif ratio < wanted / 1.05:
        kept += ("el área útil es más alta que 9:16; quedará con barras a los lados",)
    return replace(
        decision,
        crop=crop,
        reason=f"se detectó un área útil de {crop.w}x{crop.h} en ({crop.x},{crop.y})",
        warnings=kept + tuple(warnings),
        signals=signals,
    )


def analyze(
    ffmpeg: str,
    src: Path,
    info: MediaInfo,
    *,
    config: Config | None = None,
    refine: bool = True,
) -> FramingDecision:
    """Clasifica un clip y, si hace falta, calcula y afina su recorte."""
    cfg = config or Config.from_env()
    visible = visible_size(info)
    input_size = (int(info.width or visible[0]), int(info.height or visible[1]))
    if not needs_analysis(visible, cfg.total):
        return decision_without_analysis(
            input_size=input_size,
            visible_size=visible,
            rotation=info.rotation,
            target=cfg.total,
        )

    start, span, count = sample_window(info.usable_duration_s)
    low_width, low_height = analysis_size(visible)
    frames = extract_frames(
        ffmpeg,
        src,
        width=low_width,
        height=low_height,
        count=count,
        start_s=start,
        span_s=span,
    )
    decision = analyze_frames(
        frames,
        input_size=input_size,
        visible_size=visible,
        rotation=info.rotation,
        target=cfg.total,
    )
    if decision.crop is None or not refine:
        return decision

    # Para 8K el muestreo completo serían cientos de MB: se usa el recorte grueso.
    if visible[0] * visible[1] > 50_000_000:
        return replace(
            decision,
            warnings=decision.warnings + ("clip demasiado grande para afinar el borde; se usa el recorte grueso",),
        )

    try:
        full_frames = extract_frames(
            ffmpeg,
            src,
            width=visible[0],
            height=visible[1],
            count=min(REFINE_FRAMES, count),
            start_s=start,
            span_s=span,
        )
    except (AnalysisError, subprocess.TimeoutExpired) as exc:
        return replace(
            decision,
            warnings=decision.warnings + (f"no se pudo afinar el borde a resolución completa: {exc}",),
        )

    refined, warnings = refine_crop(decision.crop, full_frames, visible)
    return _with_crop(decision, refined, warnings, target=cfg.total)
