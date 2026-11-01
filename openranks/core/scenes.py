"""Segmentación en escenas (F3 · P3-3): de la curva de score a tramos de 1-30 s.

Núcleo **puro**: no toca FFmpeg ni disco. Recibe la serie de puntuaciones de `scdet`, la
luminancia media de `signalstats` y los negros de `blackdetect`, y devuelve los
candidatos ya filtrados por la banda del producto (§3 del RPD):

* el corte se decide con un **umbral adaptativo** al score local (`scene_k` sobre la
  mediana de la ventana) y un suelo absoluto `scene_floor`, no con una constante para
  todo el vídeo;
* un **destello** (dos cortes más juntos que `flash_max_s`) no parte la escena: se
  descartan los dos cortes y el fogonazo se queda con su vecino;
* un **fundido** oscuro (luminancia media por debajo de `fade_luma` y rodeado de imagen
  clara) aporta sus dos bordes como cortes, y el tramo oscuro no se propone;
* los tramos de menos de 1 s se fusionan con su vecino y los de más de 30 s se parten;
* cada tramo empieza **exactamente** en el fotograma del cambio, sin margen.

El **único** criterio de corte es la imagen: el audio no se analiza y no puede mover un
corte ni crear un clip. El resultado es determinista: las mismas series y los mismos
umbrales dan los mismos candidatos, sin solapes y ordenados.
"""

from __future__ import annotations

import math
import os
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from statistics import median

# Valores de partida del preset del extractor (RPD §16, decisión 13): se calibran por
# tipo de contenido con las variables de entorno de `Thresholds.from_env`.
#
# `scene_floor` va en la escala de `scdet` (MAFD, parecida a 0-255), no en la 0-1 de
# `select='gt(scene,X)'`: 10 es el umbral por defecto del filtro y 8-14 el rango que
# documenta FFmpeg para imagen real.
SCENE_FLOOR = 10.0
# Cuántas veces la mediana local tiene que superar un fotograma para cortar.
SCENE_K = 3.0
# Dos cortes más juntos que esto son un destello, no dos escenas.
FLASH_MAX_S = 0.5
# Luminancia media (0-255) por debajo de la cual un fotograma es "de fundido".
FADE_LUMA = 24.0
# Lo que tiene que durar la caída de luminancia para contar como fundido.
FADE_MIN_S = 0.1
# Cuánto se mira hacia cada lado del hueco oscuro para comprobar que hay imagen clara.
FADE_LOOKAROUND_S = 1.0
BLACK_MIN_S = 0.4
MIN_CLIP_S = 1.0
MAX_CLIP_S = 30.0

# Un tramo que es más de esto negro (o de fundido) no se propone: no hay nada que montar.
DARK_OVERLAP_LIMIT = 0.5

# Ventana de la mediana local del umbral adaptativo.
ADAPTIVE_WINDOW_S = 2.0


def _env_number(env: dict[str, str], name: str, default: float, *, positive: bool) -> float:
    raw = env.get(name)
    if raw in (None, ""):
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    if positive and value <= 0:
        return default
    return value


@dataclass(frozen=True)
class Thresholds:
    """Umbrales del análisis, todos ajustables por entorno sin tocar código."""

    scene_floor: float = SCENE_FLOOR
    scene_k: float = SCENE_K
    flash_max_s: float = FLASH_MAX_S
    fade_luma: float = FADE_LUMA
    fade_min_s: float = FADE_MIN_S
    black_min_s: float = BLACK_MIN_S
    min_clip_s: float = MIN_CLIP_S
    max_clip_s: float = MAX_CLIP_S

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Thresholds":
        source = dict(os.environ) if env is None else env
        return cls(
            scene_floor=_env_number(source, "OPENRANKS_SCENE_FLOOR", cls.scene_floor, positive=True),
            scene_k=_env_number(source, "OPENRANKS_SCENE_K", cls.scene_k, positive=True),
            flash_max_s=_env_number(source, "OPENRANKS_FLASH_MAX_SECONDS", cls.flash_max_s, positive=True),
            fade_luma=_env_number(source, "OPENRANKS_FADE_LUMA", cls.fade_luma, positive=True),
            fade_min_s=_env_number(source, "OPENRANKS_FADE_MIN_SECONDS", cls.fade_min_s, positive=True),
            black_min_s=_env_number(source, "OPENRANKS_BLACK_MIN_S", cls.black_min_s, positive=True),
            min_clip_s=_env_number(source, "OPENRANKS_MIN_CLIP_SECONDS", cls.min_clip_s, positive=True),
            max_clip_s=_env_number(source, "OPENRANKS_MAX_CLIP_SECONDS", cls.max_clip_s, positive=True),
        )

    def to_manifest(self) -> dict:
        return {
            "scene_floor": round(self.scene_floor, 3),
            "scene_k": round(self.scene_k, 3),
            "flash_max_s": round(self.flash_max_s, 3),
            "fade_luma": round(self.fade_luma, 2),
            "fade_min_s": round(self.fade_min_s, 2),
            "black_min_s": round(self.black_min_s, 2),
            "min_clip_s": round(self.min_clip_s, 2),
            "max_clip_s": round(self.max_clip_s, 2),
        }


@dataclass(frozen=True)
class Segment:
    """Un tramo candidato, en segundos y sobre la fuente original."""

    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    def to_manifest(self, index: int) -> dict:
        return {
            "index": index,
            "start_s": round(self.start_s, 3),
            "end_s": round(self.end_s, 3),
            "duration_s": round(self.duration_s, 3),
        }


def clean_cuts(cuts, duration_s: float) -> list[float]:
    """Cortes válidos y ordenados: dentro del vídeo, sin duplicados y sin extremos."""
    result: list[float] = []
    for raw in cuts:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(value) or value <= 0 or value >= duration_s:
            continue
        result.append(value)
    result.sort()
    deduped: list[float] = []
    for value in result:
        if not deduped or value - deduped[-1] > 1e-6:
            deduped.append(value)
    return deduped


def adaptive_cuts(scores, thresholds: Thresholds | None = None) -> list[float]:
    """Cortes a partir del score de **cada** fotograma, umbral adaptativo.

    `scores` son pares ``(segundos, score)``. Un fotograma corta cuando su score supera
    ``scene_k`` veces la mediana de la ventana que lo rodea (±2 s, sin contarse a sí
    mismo) y, además, el suelo absoluto ``scene_floor``. Así un plano con mucho movimiento
    exige un cambio mayor y una escena tranquila no se parte por un pico pequeño.
    """
    limits = thresholds or Thresholds()
    series: list[tuple[float, float]] = []
    for raw_time, raw_value in scores:
        try:
            when, value = float(raw_time), float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(when) and math.isfinite(value):
            series.append((when, value))
    series.sort()
    if len(series) < 3:
        return []

    times = [when for when, _ in series]
    values = [value for _, value in series]
    cuts: list[float] = []

    for index, (when, value) in enumerate(series):
        if value <= 0:
            continue
        window_start = bisect_left(times, when - ADAPTIVE_WINDOW_S)
        window_end = bisect_right(times, when + ADAPTIVE_WINDOW_S)
        neighbours = values[window_start:index] + values[index + 1 : window_end]
        if not neighbours:
            continue
        threshold = max(limits.scene_floor, limits.scene_k * median(neighbours))
        if value < threshold:
            continue
        cuts.append(when)

    return cuts


def drop_flash_cuts(cuts, max_flash_s: float = FLASH_MAX_S) -> list[float]:
    """Quita los destellos: dos cortes más juntos que `max_flash_s` no son dos escenas.

    Un fogonazo o un flash de la cámara produce un corte al encenderse y otro al
    apagarse. Los dos se descartan y el destello se queda dentro de la escena vecina, que
    es lo que el operador quiere ver en la parrilla.
    """
    ordered = sorted(float(value) for value in cuts)
    kept: list[float] = []
    index = 0
    while index < len(ordered):
        current = ordered[index]
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        if following is not None and following - current < max_flash_s:
            index += 2
            continue
        kept.append(current)
        index += 1
    return kept


def merge_spans(spans, gap_s: float = 0.0) -> list[tuple[float, float]]:
    """Une tramos oscuros que se tocan (un negro dentro de un fundido es un solo hueco)."""
    ordered = sorted(
        (start, end)
        for start, end in ((float(a), float(b)) for a, b in spans)
        if end > start
    )
    merged: list[tuple[float, float]] = []
    for start, end in ordered:
        if merged and start <= merged[-1][1] + gap_s:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def span_edges(spans) -> list[float]:
    """Los dos bordes de cada tramo oscuro, como cortes: ahí acaba y vuelve la imagen."""
    return sorted(value for start, end in spans for value in (start, end))


def luma_spans(luma, thresholds: Thresholds | None = None) -> list[tuple[float, float]]:
    """Fundidos: tramos donde la luminancia media cae por debajo de `fade_luma`.

    `luma` son pares ``(segundos, YAVG)`` de `signalstats`. Se exige que el tramo dure
    `fade_min_s` y que **alrededor** haya imagen claramente más luminosa: así una escena
    nocturna entera, que también está oscura, no se toma por un fundido.
    """
    limits = thresholds or Thresholds()
    samples: list[tuple[float, float]] = []
    for raw_time, raw_value in luma:
        try:
            when, value = float(raw_time), float(raw_value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(when) and math.isfinite(value):
            samples.append((when, value))
    samples.sort()
    if len(samples) < 3:
        return []
    times = [when for when, _ in samples]

    runs: list[tuple[int, int]] = []
    start_index: int | None = None
    for index, (_, value) in enumerate(samples):
        dark = value <= limits.fade_luma
        if dark and start_index is None:
            start_index = index
        elif not dark and start_index is not None:
            runs.append((start_index, index - 1))
            start_index = None
    if start_index is not None:
        runs.append((start_index, len(samples) - 1))

    spans: list[tuple[float, float]] = []
    for first, last in runs:
        start, end = samples[first][0], samples[last][0]
        if end - start < limits.fade_min_s:
            continue
        # El contraste se mide en el segundo anterior y posterior al hueco, no en el
        # fotograma pegado a él: justo al cruzar el umbral la imagen sigue oscura, y un
        # plano de color poco luminoso (azul, Y≈41) nunca llegaría al doble del umbral.
        window_start = bisect_left(times, start - FADE_LOOKAROUND_S)
        window_end = bisect_right(times, end + FADE_LOOKAROUND_S)
        surroundings = [
            samples[index][1]
            for index in range(window_start, window_end)
            if index < first or index > last
        ]
        if not surroundings or max(surroundings) < limits.fade_luma * 2:
            continue
        spans.append((start, end))
    return spans


def span_overlap(segment: Segment, spans) -> float:
    """Segundos del tramo que caen dentro de un negro o un fundido."""
    overlap = 0.0
    for start, end in spans:
        low = max(segment.start_s, float(start))
        high = min(segment.end_s, float(end))
        if high > low:
            overlap += high - low
    return overlap


def build_segments(
    cuts,
    duration_s: float,
    thresholds: Thresholds | None = None,
    *,
    dark_spans=(),
) -> list[Segment]:
    """Candidatos dentro de la banda: descarte de oscuros, fusión, partición y corte exacto.

    Los tramos que son casi todo negro o fundido (`dark_spans`) se descartan **antes** de
    fusionar: así un fundido a negro no alarga el clip anterior con una cola oscura.
    """
    limits = thresholds or Thresholds()
    duration = float(duration_s)
    if not math.isfinite(duration) or duration <= 0:
        return []

    points = [0.0] + clean_cuts(cuts, duration) + [duration]
    raw: list[Segment] = []
    for start, end in zip(points, points[1:]):
        if end - start <= 1e-6:
            continue
        # Sin margen: el tramo empieza en el fotograma exacto del cambio de imagen.
        segment = Segment(start, end)
        if dark_spans and span_overlap(segment, dark_spans) / segment.duration_s >= DARK_OVERLAP_LIMIT:
            continue
        raw.append(segment)

    # Fusionar los tramos demasiado cortos con el vecino anterior (el primero, con el
    # siguiente). Se repite hasta que ninguno quede por debajo del mínimo.
    merged: list[Segment] = []
    for segment in raw:
        # Solo se fusiona con el vecino si son contiguos: un fundido descartado en medio
        # no debe arrastrar su cola oscura al clip anterior.
        if (
            segment.duration_s < limits.min_clip_s
            and merged
            and segment.start_s <= merged[-1].end_s + 1e-6
        ):
            merged[-1] = Segment(merged[-1].start_s, segment.end_s)
            continue
        merged.append(segment)
    while (
        len(merged) > 1
        and merged[0].duration_s < limits.min_clip_s
        and merged[1].start_s <= merged[0].end_s + 1e-6
    ):
        merged[1] = Segment(merged[0].start_s, merged[1].end_s)
        merged.pop(0)

    # Un tramo corto que no pudo fusionarse hacia atrás se fusiona con el siguiente.
    index = 0
    while index < len(merged) - 1:
        if (
            merged[index].duration_s < limits.min_clip_s
            and merged[index + 1].start_s <= merged[index].end_s + 1e-6
        ):
            merged[index + 1] = Segment(merged[index].start_s, merged[index + 1].end_s)
            merged.pop(index)
            continue
        index += 1

    # Partir los tramos por encima del máximo en trozos iguales (sin solapes).
    split: list[Segment] = []
    for segment in merged:
        if segment.duration_s <= limits.max_clip_s + 1e-9:
            split.append(segment)
            continue
        parts = max(2, math.ceil(segment.duration_s / limits.max_clip_s))
        size = segment.duration_s / parts
        for index in range(parts):
            start = segment.start_s + index * size
            end = segment.end_s if index == parts - 1 else start + size
            split.append(Segment(start, end))

    final: list[Segment] = []
    for segment in split:
        start = round(max(0.0, min(duration, segment.start_s)), 3)
        end = round(max(0.0, min(duration, segment.end_s)), 3)
        if end - start <= 1e-6:
            continue
        final.append(Segment(start, end))
    return final
