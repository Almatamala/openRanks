"""Resultado del score de un clip (F3 · P3-11 y P3-12).

Solo lo produce el LLM al puntuar **la galería**: valor 0-100, un título corto para el
puesto y el modelo que lo calculó. No hay razones, ni cálculo heurístico, ni respaldo
local: el divisor de escenas no puntúa y sin clave no hay score.
"""

from __future__ import annotations

from dataclasses import dataclass

# Ancho del rótulo del puesto (RPD §9.5): el título del LLM no puede pasarse de aquí.
TITLE_MAX_CHARS = 24

# Fuente del score tal y como la enseña el panel (RF-18.1).
SOURCE = "llm"


@dataclass(frozen=True)
class Score:
    """Score listo para la galería y para el panel."""

    value: int
    title: str = ""
    source: str = SOURCE
    model_version: str = ""

    def to_manifest(self) -> dict:
        document = {
            "value": int(self.value),
            "source": self.source,
            "model_version": self.model_version,
        }
        if self.title:
            document["title"] = self.title
        return document
