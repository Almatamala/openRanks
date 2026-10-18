"""Decisión de encuadre de L1: ¿el clip ya es vertical o hay que aislar el área útil?

Función pura y testeable sin FFmpeg (§7.6). El análisis real de fotogramas vive en
``openranks/framing.py``; aquí solo se decide, a partir de fotogramas en gris ya
extraídos, qué recorte hay que aplicar.

El caso que resuelve: un vídeo horizontal que contiene un clip vertical centrado,
rodeado de un fondo borroso (pillarbox desenfocado) y, a veces, una marca de agua en
esa zona. Se detecta el tramo de columnas nítidas que contiene el centro y se recorta;
si no hay evidencia suficiente, **no se recorta** y se rellena con negro.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from statistics import median
from typing import Sequence

# Un área útil fuera de esta banda no se acepta: o es un recorte absurdo o es el
# cuadro entero (que se trata como «sin fondo borroso»).
MIN_USEFUL_RATIO = 0.25
MAX_USEFUL_RATIO = 0.95
# Cuánto se permite que el centro del área útil se desvíe del centro del cuadro.
CENTER_TOLERANCE = 0.05
# Confianza mínima para aplicar un crop. Por debajo, se rellena con negro.
CONFIDENCE_MIN = 0.60
# Píxeles que se recortan hacia adentro para no arrastrar el halo del desenfoque.
INSET_PX = 3
# Salto mínimo entre la nitidez de dentro y la de fuera del área útil.
STEP_MIN = 1.8
# Con menos fotogramas, la decisión es más frágil: se limita la confianza.
MIN_FRAMES = 3


class FramingError(ValueError):
    """El encuadre no se puede decidir con los datos recibidos."""


@dataclass(frozen=True)
class GrayFrame:
    """Un fotograma en escala de grises, fila por fila, sin cabecera."""

    width: int
    height: int
    pixels: bytes

    def __post_init__(self) -> None:
        if self.width <= 2 or self.height <= 2:
            raise ValueError(f"fotograma demasiado pequeño: {self.width}x{self.height}")
        if len(self.pixels) != self.width * self.height:
            raise ValueError(
                f"el fotograma mide {self.width}x{self.height} y trae {len(self.pixels)} bytes"
            )


@dataclass(frozen=True)
class Crop:
    """Recorte en píxeles de la imagen **visible** (después de la rotación)."""

    w: int
    h: int
    x: int
    y: int

    def __post_init__(self) -> None:
        if self.w <= 0 or self.h <= 0:
            raise ValueError(f"recorte sin superficie: {self.w}x{self.h}")
        if self.x < 0 or self.y < 0:
            raise ValueError(f"recorte fuera del cuadro: ({self.x},{self.y})")

    @property
    def right(self) -> int:
        return self.x + self.w

    @property
    def bottom(self) -> int:
        return self.y + self.h

    def to_json(self) -> dict:
        return {"w": self.w, "h": self.h, "x": self.x, "y": self.y}


@dataclass(frozen=True)
class FramingDecision:
    """Qué hacer con un clip de entrada, con su motivo y su confianza."""

    classification: str  # "A" (requiere conversión) | "B" (ya es vertical)
    reason: str
    input_size: tuple[int, int]
    visible_size: tuple[int, int]
    rotation: int
    crop: Crop | None
    confidence: float
    fit: str  # "contain" (relleno negro) | "sin_cambios"
    warnings: tuple[str, ...] = ()
    signals: dict = field(default_factory=dict)

    def to_json(self, *, command: str | None = None) -> dict:
        """Contrato de salida del comando ``openranks fit``."""
        return {
            "version": 1,
            "clasificacion": self.classification,
            "motivo": self.reason,
            "resolucion_entrada": f"{self.input_size[0]}x{self.input_size[1]}",
            "resolucion_visible": f"{self.visible_size[0]}x{self.visible_size[1]}",
            "rotacion": self.rotation,
            "crop": None if self.crop is None else self.crop.to_json(),
            "encaje": self.fit,
            "confianza": round(float(self.confidence), 3),
            "senales": dict(self.signals),
            "comando_ffmpeg": command,
            "advertencias": list(self.warnings),
        }

    def to_manifest(self) -> dict:
        """Lo que se guarda en el manifiesto: sin rutas ni comando de host."""
        payload = self.to_json()
        payload.pop("comando_ffmpeg", None)
        payload.pop("version", None)
        return payload


def _median(values: Sequence[float]) -> float:
    return float(median(values)) if values else 0.0


def _p95(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1)))))
    return float(ordered[index])


def _normalise(values: Sequence[float], scale: float) -> list[float]:
    if scale <= 0:
        return [0.0] * len(values)
    return [float(value) / scale for value in values]


def _smooth(values: Sequence[float], window: int) -> list[float]:
    """Media móvil: el contenido puede tener columnas planas entre detalles."""
    if window <= 1 or not values:
        return list(values)
    radius = max(1, window // 2)
    count = len(values)
    smoothed: list[float] = []
    for index in range(count):
        start = max(0, index - radius)
        end = min(count, index + radius + 1)
        smoothed.append(sum(values[start:end]) / (end - start))
    return smoothed


def _even(value: int) -> int:
    return int(value) - (int(value) % 2)


def _even_floor(value: int) -> int:
    return max(0, value - (value % 2))


def classify_size(visible_size: tuple[int, int], target: tuple[int, int] = (1080, 1920)) -> tuple[str, str, str]:
    """Clasifica sin mirar píxeles: exacto, vertical u horizontal/cuadrado.

    Devuelve ``(clasificación, motivo, encaje)``. Un clip vertical de cualquier
    resolución se deja como está (solo escala y relleno); uno horizontal o cuadrado
    necesita analizar el área útil.
    """
    width, height = visible_size
    if width <= 0 or height <= 0:
        raise FramingError(f"resolución visible inválida: {width}x{height}")
    if (width, height) == target:
        return "B", f"ya es el tamaño de salida ({width}x{height}); no se recorta", "sin_cambios"
    if height > width:
        return "B", f"ya es vertical ({width}x{height}); solo se escala y se rellena", "contain"
    return "A", "horizontal o cuadrado: se analiza el área útil", "contain"


def needs_analysis(visible_size: tuple[int, int], target: tuple[int, int] = (1080, 1920)) -> bool:
    """Solo los cuadros horizontales o cuadrados pasan por el análisis de píxeles."""
    width, height = visible_size
    return width > 0 and height > 0 and width >= height


def decision_without_analysis(
    *,
    input_size: tuple[int, int],
    visible_size: tuple[int, int],
    rotation: int,
    target: tuple[int, int] = (1080, 1920),
) -> FramingDecision:
    """Decisión para un clip que ya es vertical: no hay crop ni análisis."""
    classification, reason, fit = classify_size(visible_size, target)
    return FramingDecision(
        classification=classification,
        reason=reason,
        input_size=input_size,
        visible_size=visible_size,
        rotation=rotation,
        crop=None,
        confidence=1.0,
        fit=fit,
        signals={"analizado": False},
    )


def fallback_decision(
    *,
    input_size: tuple[int, int],
    visible_size: tuple[int, int],
    rotation: int,
    reason: str,
    warning: str,
) -> FramingDecision:
    """Decisión conservadora cuando el análisis falla: no recortar y rellenar."""
    return FramingDecision(
        classification="A",
        reason=reason,
        input_size=input_size,
        visible_size=visible_size,
        rotation=rotation,
        crop=None,
        confidence=0.0,
        fit="contain",
        warnings=(warning,),
        signals={"analizado": False},
    )


def _column_scores(frames: Sequence[GrayFrame]) -> list[float]:
    """Nitidez por columna: mediana entre fotogramas de |gradiente horizontal|."""
    width, height = frames[0].width, frames[0].height
    per_frame: list[list[float]] = []
    for frame in frames:
        scores = [0.0] * width
        pixels = frame.pixels
        for y in range(1, height - 1):
            base = y * width
            for x in range(1, width - 1):
                index = base + x
                # Laplaciano: mide detalle en las dos direcciones. El gradiente
                # horizontal solo fallaba en columnas planas dentro del clip nítido.
                scores[x] += abs(
                    pixels[index - 1] + pixels[index + 1] + pixels[index - width] + pixels[index + width] - 4 * pixels[index]
                )
        # Los bordes heredan del vecino: no hay gradiente fuera del cuadro.
        scores[0] = scores[1]
        scores[-1] = scores[-2]
        per_frame.append(_normalise(scores, _p95(scores)))
    return [_median([frame_scores[x] for frame_scores in per_frame]) for x in range(width)]


def _temporal_column_scores(frames: Sequence[GrayFrame]) -> list[float]:
    """Variación temporal por columna: desempata cuando la nitidez es ambigua.

    No sustituye a la nitidez: un fondo borroso también cambia. Se usa con un peso
    bajo para no romper clips estáticos.
    """
    width, height = frames[0].width, frames[0].height
    if len(frames) < 2:
        return [0.0] * width
    per_pair: list[list[float]] = []
    for previous, current in zip(frames, frames[1:]):
        scores = [0.0] * width
        for y in range(0, height, 2):  # media resolución vertical: sobra para desempatar
            base = y * width
            for x in range(1, width - 1):
                index = base + x
                scores[x] += abs(previous.pixels[index] - current.pixels[index])
        scores[0] = scores[1]
        scores[-1] = scores[-2]
        per_pair.append(_normalise(scores, _p95(scores)))
    return [_median([pair[x] for pair in per_pair]) for x in range(width)]


def _row_scores(frames: Sequence[GrayFrame], x0: int, x1: int) -> list[float]:
    """Nitidez por fila dentro del tramo horizontal ya elegido."""
    width, height = frames[0].width, frames[0].height
    x0 = max(1, min(width - 2, x0))
    x1 = max(x0 + 1, min(width - 1, x1))
    per_frame: list[list[float]] = []
    for frame in frames:
        scores = [0.0] * height
        pixels = frame.pixels
        for y in range(1, height - 1):
            base = y * width
            for x in range(x0, x1):
                index = base + x
                scores[y] += abs(
                    pixels[index - 1] + pixels[index + 1] + pixels[index - width] + pixels[index + width] - 4 * pixels[index]
                )
        scores[0] = scores[1]
        scores[-1] = scores[-2]
        per_frame.append(_normalise(scores, _p95(scores)))
    return [_median([frame_scores[y] for frame_scores in per_frame]) for y in range(height)]


def _threshold(scores: Sequence[float]) -> tuple[float, float, float]:
    """Umbral adaptativo: parte de la zona central y respeta el ruido de los bordes."""
    count = len(scores)
    edge = max(2, count // 20)
    center_lo = max(edge, int(count * 0.40))
    center_hi = min(count - edge, int(count * 0.60))
    center = _median(scores[center_lo:center_hi]) if center_hi > center_lo else _median(scores)
    noise = _median(list(scores[:edge]) + list(scores[-edge:]))
    return max(0.28 * center, 2.5 * noise, 1e-6), center, noise


def _runs(
    scores: Sequence[float],
    threshold: float,
    *,
    max_gap: int = 0,
) -> list[tuple[int, int]]:
    """Tramos por encima del umbral; con ``max_gap`` cierra huecos internos.

    Un clip nítido puede tener columnas planas (cielo, pared) que caen por debajo del
    umbral y partirían el área útil en trozos. Cerrar huecos cortos mantiene el tramo
    unido sin puentear una marca de agua separada del clip.
    """
    mask = [value >= threshold for value in scores]
    if max_gap > 0:
        count = len(mask)
        index = 0
        while index < count:
            if mask[index]:
                index += 1
                continue
            end = index
            while end < count and not mask[end]:
                end += 1
            if index > 0 and end < count and end - index <= max_gap:
                for fill in range(index, end):
                    mask[fill] = True
            index = end

    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, is_useful in enumerate(mask):
        if is_useful:
            if start is None:
                start = index
        elif start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def _choose_run(runs: Sequence[tuple[int, int]], count: int) -> tuple[int, int] | None:
    if not runs:
        return None
    center = count // 2
    containing = [run for run in runs if run[0] <= center < run[1]]
    if containing:
        return max(containing, key=lambda run: run[1] - run[0])
    return max(runs, key=lambda run: run[1] - run[0])


def refine_edge(scores: Sequence[float], expected: int, *, rising: bool, radius: int) -> int:
    """Busca el salto más fuerte cerca de ``expected`` (borde de transición)."""
    if not scores:
        return expected
    low = max(1, expected - max(1, radius))
    high = min(len(scores) - 1, expected + max(1, radius) + 1)
    best = max(1, min(len(scores) - 1, expected))
    best_step = -1.0
    for index in range(low, high):
        step = (scores[index] - scores[index - 1]) if rising else (scores[index - 1] - scores[index])
        if step > best_step:
            best_step = step
            best = index
    return best


def _run_quality(scores: Sequence[float], run: tuple[int, int]) -> tuple[float, float]:
    start, end = run
    inside_values = scores[start + 2 : end - 2] if end - start >= 8 else scores[start:end]
    inside = _median(inside_values)
    pad = max(2, len(scores) // 50)
    outside_values = list(scores[max(0, start - pad) : start]) + list(scores[end : min(len(scores), end + pad)])
    outside = _median(outside_values)
    return inside, outside


def _crop_from_run(
    run: tuple[int, int],
    scores: Sequence[float],
    source_size: tuple[int, int],
    *,
    axis: str,
) -> tuple[int, int, float] | None:
    """Convierte un tramo de puntuaciones en píxeles de origen.

    Devuelve ``(inicio, tamaño, confianza)`` o ``None`` si el tramo no es creíble.
    """
    count = len(scores)
    inside, outside = _run_quality(scores, run)
    step = inside / max(outside, 1e-6)
    if step < STEP_MIN:
        return None

    radius = max(2, count // 40)
    # El área nítida empieza subiendo (fondo → contenido) y termina bajando
    # (contenido → fondo). Invertir esto desplazaba el borde al lado contrario.
    left = refine_edge(scores, run[0], rising=True, radius=radius)
    right = refine_edge(scores, run[1], rising=False, radius=radius)
    scale = source_size[0] / count if axis == "x" else source_size[1] / count
    start = int(round(left * scale))
    end = int(round(right * scale))
    if end - start < 8:
        return None

    # Hacia adentro para no comerse el halo del desenfoque.
    start += INSET_PX
    end -= INSET_PX
    if end - start < 8:
        return None

    start = _even_floor(start)
    size = _even(end - start)
    if size <= 0:
        return None

    limit = source_size[0] if axis == "x" else source_size[1]
    if start + size > limit:
        start = _even_floor(limit - size)
    if start < 0:
        return None
    if size < limit * MIN_USEFUL_RATIO or size > limit * MAX_USEFUL_RATIO:
        return None

    center = start + size / 2
    offset_ratio = abs(center - limit / 2) / limit
    if offset_ratio > CENTER_TOLERANCE:
        return None

    step_score = min(1.0, max(0.0, (step - 1.0) / 2.5))
    center_score = max(0.0, 1.0 - offset_ratio / CENTER_TOLERANCE)
    confidence = 0.55 * step_score + 0.30 * center_score + 0.15
    return start, size, confidence


def _detached_islands(scores: Sequence[float], threshold: float, chosen: tuple[int, int]) -> list[tuple[int, int]]:
    """Tramos nítidos separados del área útil: candidatos a marca de agua."""
    islands = []
    for run in _runs(scores, threshold):
        # Los tramos que caen **dentro** del área elegida no son islas: el área se
        # cerró sobre huecos internos (columnas planas), y esos fragmentos no son
        # una marca de agua. Solo se avisa de lo que quedó fuera.
        if run == chosen or (run[1] > chosen[0] and run[0] < chosen[1]):
            continue
        width = run[1] - run[0]
        if width < max(4, len(scores) // 48) or width > len(scores) * 0.15:
            continue
        # Solo avisa de islas realmente nítidas: los restos del fondo borroso (y el
        # halo del borde del clip) no deben llenar la interfaz de avisos falsos.
        if _median(scores[run[0] : run[1]]) >= 1.5 * threshold:
            islands.append(run)
    return islands


def analyze_frames(
    frames: Sequence[GrayFrame],
    *,
    input_size: tuple[int, int],
    visible_size: tuple[int, int],
    rotation: int = 0,
    target: tuple[int, int] = (1080, 1920),
) -> FramingDecision:
    """Decide el crop a partir de fotogramas en gris ya extraídos.

    ``input_size`` es el tamaño codificado (sin rotación) y ``visible_size`` el que
    ve el reproductor. Las coordenadas del crop siempre están en ``visible_size``.
    """
    if not needs_analysis(visible_size, target):
        return decision_without_analysis(
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            target=target,
        )
    if not frames:
        raise FramingError("no hay fotogramas para analizar")

    width, height = frames[0].width, frames[0].height
    sharpness = _column_scores(frames)
    temporal = _temporal_column_scores(frames)
    raw = [0.85 * sharp + 0.15 * change for sharp, change in zip(sharpness, temporal)]
    combined = _smooth(raw, max(3, (len(raw) // 64) * 2 + 1))

    if max(combined) <= 1e-5:
        return FramingDecision(
            classification="A",
            reason="no se pudo medir nitidez: fotogramas oscuros o sin detalle",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.15,
            fit="contain",
            warnings=("no se pudo medir nitidez; se rellena con negro sin recortar",),
            signals={"analizado": True, "frames": len(frames)},
        )

    # Un cuadro entero nítido no tiene fondo que aislar. Sin esta comprobación, el
    # ruido de los bordes (que aquí es alto, porque también es contenido) elevaba el
    # umbral por encima de la señal y no se encontraba ningún tramo.
    ordered = sorted(combined)
    p10 = ordered[max(0, int(round(0.10 * (len(ordered) - 1))))]
    p90 = ordered[max(0, int(round(0.90 * (len(ordered) - 1))))]
    if p90 > 0.05 and p10 >= 0.45 * p90:
        return FramingDecision(
            classification="A",
            reason="no se detecta fondo borroso: la nitidez es uniforme en todo el cuadro",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.85,
            fit="contain",
            warnings=("sin fondo borroso: se escala y se rellena con negro",),
            signals={"analizado": True, "frames": len(frames)},
        )

    threshold, _center, _noise = _threshold(combined)
    runs = _runs(combined, threshold, max_gap=max(2, width // 32))
    chosen = _choose_run(runs, width)
    warnings: list[str] = []
    if chosen is None:
        return FramingDecision(
            classification="A",
            reason="no se encontró un área nítida continua",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.20,
            fit="contain",
            warnings=("no se encontró un área nítida continua; se rellena con negro sin recortar",),
            signals={"analizado": True, "frames": len(frames)},
        )

    chosen_width = chosen[1] - chosen[0]
    if chosen_width >= width * MAX_USEFUL_RATIO:
        # El cuadro entero es nítido: no hay fondo borroso que aislar.
        return FramingDecision(
            classification="A",
            reason="no se detecta fondo borroso: el contenido ocupa todo el cuadro",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.85,
            fit="contain",
            warnings=("sin fondo borroso: se escala y se rellena con negro",),
            signals={
                "analizado": True,
                "frames": len(frames),
                "ancho_util_pct": round(chosen_width / width * 100, 1),
            },
        )

    islands = _detached_islands(combined, threshold, chosen)
    if islands:
        warnings.append("se ignoraron zonas nítidas aisladas en el fondo (posible marca de agua)")

    horizontal = _crop_from_run(chosen, combined, visible_size, axis="x")
    if horizontal is None:
        return FramingDecision(
            classification="A",
            reason="el área útil horizontal no es concluyente",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.30,
            fit="contain",
            warnings=(*warnings, "el área útil no es concluyente; se rellena con negro sin recortar"),
            signals={"analizado": True, "frames": len(frames)},
        )

    x, crop_w, confidence = horizontal
    # Las filas se miden dentro del tramo horizontal: así el fondo lateral no diluye
    # la señal de una banda borrosa arriba o abajo.
    score_scale = width / visible_size[0]
    row_x0 = max(1, int(round(x * score_scale)))
    row_x1 = max(row_x0 + 1, int(round((x + crop_w) * score_scale)))
    row_scores = _row_scores(frames, row_x0, row_x1)
    rows = _smooth(row_scores, max(3, (len(row_scores) // 64) * 2 + 1))
    row_threshold, _row_center, _row_noise = _threshold(rows)
    row_run = _choose_run(_runs(rows, row_threshold, max_gap=max(2, height // 32)), height)

    crop_y, crop_h = 0, visible_size[1]
    if row_run is not None:
        row_width = row_run[1] - row_run[0]
        if row_width < height * MAX_USEFUL_RATIO:
            vertical = _crop_from_run(row_run, rows, (visible_size[0], visible_size[1]), axis="y")
            if vertical is not None:
                crop_y, crop_h, _row_confidence = vertical
            else:
                warnings.append("no se pudo acotar el alto; se mantiene el cuadro completo")

    crop = Crop(w=crop_w, h=crop_h, x=x, y=crop_y)
    if crop.right > visible_size[0] or crop.bottom > visible_size[1]:
        return FramingDecision(
            classification="A",
            reason="el recorte calculado se sale del cuadro",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=0.25,
            fit="contain",
            warnings=(*warnings, "el recorte calculado se sale del cuadro; se rellena con negro"),
            signals={"analizado": True, "frames": len(frames)},
        )

    if len(frames) < MIN_FRAMES:
        warnings.append(f"solo {len(frames)} fotogramas analizados: confianza limitada")
        confidence = min(confidence, 0.70)

    if crop.w / crop.h > (target[0] / target[1]) * 1.05:
        warnings.append("el área útil es más ancha que 9:16; quedará con barras arriba y abajo")

    if confidence < CONFIDENCE_MIN:
        return FramingDecision(
            classification="A",
            reason="el recorte no alcanza la confianza mínima",
            input_size=input_size,
            visible_size=visible_size,
            rotation=rotation,
            crop=None,
            confidence=confidence,
            fit="contain",
            warnings=(*warnings, "confianza baja en el encuadre; se rellena con negro sin recortar"),
            signals={
                "analizado": True,
                "frames": len(frames),
                "ancho_util_pct": round(crop.w / visible_size[0] * 100, 1),
            },
        )

    inside, outside = _run_quality(combined, chosen)
    return FramingDecision(
        classification="A",
        reason=f"se detectó un área útil de {crop.w}x{crop.h} en ({crop.x},{crop.y})",
        input_size=input_size,
        visible_size=visible_size,
        rotation=rotation,
        crop=crop,
        confidence=confidence,
        fit="contain",
        warnings=tuple(warnings),
        signals={
            "analizado": True,
            "frames": len(frames),
            "ancho_util_pct": round(crop.w / visible_size[0] * 100, 1),
            "alto_util_pct": round(crop.h / visible_size[1] * 100, 1),
            "centrado_px": round(crop.x + crop.w / 2 - visible_size[0] / 2, 1),
            "salto_borde": round(inside / max(outside, 1e-6), 2),
        },
    )
