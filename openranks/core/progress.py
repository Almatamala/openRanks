"""Eventos de progreso del montaje (§RF-9.3).

El operador no ve un *spinner* mudo: ve una fase con nombre humano y **cuánto
lleva de verdad**. Este módulo traduce el trabajo en un porcentaje, repartiendo el
100 % entre las fases según lo que cuesta cada una — las dos pasadas de `loudnorm`
de cada clip se llevan la mayor parte, y el overlay (que solo recodifica una
generación de vídeo) mucho menos.

El porcentaje es lo único que necesita el panel para calcular el tiempo restante
estimado, así que la estimación sale de datos reales y no de un temporizador
inventado. Módulo **puro** (§7.6 del RPD): no ejecuta nada ni toca FFmpeg.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

# Reparto del trabajo en el montaje completo (L1 + L2).
#
# Son una **estimación de partida**, medida sobre el material de prueba: normalizar
# cinco clips se lleva la mayor parte (dos pasadas de `loudnorm` cada uno); la unión
# en corte seco es una **copia de streams** (casi instantánea) y la edición (L2)
# recodifica una sola generación. El porcentaje sigue siendo real (no se inventa el
# avance); lo único estimado es cuánto del total le toca a cada tramo, y el panel
# corrige solo cuando se desvía.
SPAN_FULL: dict[str, tuple[float, float]] = {
    "preparing": (0.0, 5.0),
    "normalizing": (5.0, 70.0),
    "joining": (70.0, 74.0),
    "editing": (74.0, 96.0),
    "finishing": (96.0, 100.0),
}

# Reparto cuando solo se rehace la edición (`openranks render`): no hay clips que
# normalizar, así que el overlay ocupa casi toda la barra.
SPAN_EDIT_ONLY: dict[str, tuple[float, float]] = {
    "editing": (0.0, 88.0),
    "finishing": (88.0, 100.0),
}

PHASES = ("preparing", "normalizing", "joining", "editing", "finishing")

# Las líneas de progreso van por **stderr** con este prefijo, para no mezclarse con
# el JSON final (stdout) ni con los avisos de FFmpeg.
PROGRESS_PREFIX = "OPENRANKS_PROGRESS "


@dataclass(frozen=True)
class ProgressEvent:
    """Un punto del avance. ``step``/``total`` solo tienen sentido en las fases por lotes."""

    percent: float
    phase: str
    label: str
    step: int | None = None
    total: int | None = None

    def to_json(self) -> dict:
        payload: dict = {"percent": self.percent, "phase": self.phase, "label": self.label}
        if self.step is not None:
            payload["step"] = self.step
        if self.total is not None:
            payload["total"] = self.total
        return payload


ProgressCallback = Callable[[ProgressEvent], None]


class Progress:
    """Traduce fases a porcentaje y avisa por el callback.

    Se puede compartir entre el ensamblador y el overlay para que el porcentaje del
    panel no dé un salto atrás cuando L1 encadena L2.
    """

    def __init__(self, emit: ProgressCallback | None = None, *, span: dict[str, tuple[float, float]] | None = None) -> None:
        self._emit: ProgressCallback = emit or (lambda _event: None)
        self._span = span or SPAN_FULL
        self.last: ProgressEvent | None = None

    def _send(self, phase: str, label: str, fraction: float, *, step: int | None = None, total: int | None = None) -> ProgressEvent:
        if phase not in self._span:
            raise KeyError(f"fase desconocida para esta barra: {phase!r}")
        low, high = self._span[phase]
        clamped = max(0.0, min(1.0, fraction))
        event = ProgressEvent(
            percent=round(low + (high - low) * clamped, 1),
            phase=phase,
            label=label,
            step=step,
            total=total,
        )
        self.last = event
        self._emit(event)
        return event

    # --- fases del montaje completo -------------------------------------------------
    def preparing(self, label: str) -> ProgressEvent:
        return self._send("preparing", label, 1.0)

    def normalizing(self, done: int, total: int, label: str) -> ProgressEvent:
        """``done`` es cuántos clips se han terminado ya (0 antes del primero)."""
        fraction = 1.0 if total <= 0 else done / total
        return self._send("normalizing", label, fraction, step=done, total=total)

    def joining(self, label: str) -> ProgressEvent:
        return self._send("joining", label, 0.5)

    # --- L2 ------------------------------------------------------------------------
    def editing_step(self, fraction: float, label: str) -> ProgressEvent:
        """Dentro de la edición: 0 = empieza el overlay, 1 = overlay y portada hechos."""
        return self._send("editing", label, fraction)

    def finishing(self, label: str = "Cerrando el montaje") -> ProgressEvent:
        return self._send("finishing", label, 1.0)


def parse_event(line: str, *, prefix: str = PROGRESS_PREFIX) -> dict | None:
    """Extrae el evento de una línea del motor. Devuelve ``None`` si no lo es.

    Vive aquí, y no en el panel, para que el formato de la línea tenga una sola
    definición (y se pueda testear sin Node).
    """
    if not line.startswith(prefix):
        return None

    try:
        payload = json.loads(line[len(prefix) :])
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or "percent" not in payload:
        return None
    return payload
