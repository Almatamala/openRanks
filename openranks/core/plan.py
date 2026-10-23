"""Plan de ensamblado: qué clip va dónde y cuánto dura la unión.

Función pura y testeable sin FFmpeg (§7.6 del RPD). El montaje es **siempre de corte seco**:
los tramos se pegan uno tras otro sin solape, así que la duración total es la suma
exacta de los tramos y la unión se hace por copia de streams (sin recodificar).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Sequence

from .config import Config


class PlanError(ValueError):
    """El plan no se puede ejecutar (no es solo un aviso)."""


@dataclass(frozen=True)
class SegmentPlan:
    """Un tramo del vídeo final."""

    position: int
    label: str
    duration_s: float
    output_name: str


@dataclass(frozen=True)
class PreparedInput:
    """Un clip ya preparado (normalizado) que solo espera la unión.

    El nombre del archivo es **estable y depende solo del puesto** (``05.mp4``): el
    rótulo se puede escribir después de preparar el clip y renombrar no hace falta.
    """

    position: int
    path: Path
    label: str
    duration_s: float


@dataclass(frozen=True)
class AssemblyPlan:
    title: str
    segments: tuple[SegmentPlan, ...]
    warnings: tuple[str, ...] = ()
    subtitle: str = ""

    @property
    def clip_count(self) -> int:
        """Puestos del ranking."""
        return len(self.segments)

    @property
    def total_duration_s(self) -> float:
        """Duración real: la suma de los tramos (el montaje es de corte seco)."""
        return sum(segment.duration_s for segment in self.segments)

    def to_manifest(self) -> dict:
        return {
            "title": self.title,
            "subtitle": self.subtitle,
            "clip_count": self.clip_count,
            "total_duration_s": round(self.total_duration_s, 3),
            "warnings": list(self.warnings),
            "segments": [
                {
                    "position": segment.position,
                    "label": segment.label,
                    "duration_s": round(segment.duration_s, 3),
                    "output": segment.output_name,
                }
                for segment in self.segments
            ],
        }


def prepared_name(position: int) -> str:
    """Nombre estable de un clip preparado: ``05.mp4`` (sin el rótulo, que aún no existe)."""
    return f"{position:02d}.mp4"


def plan_from_prepared(
    clips: Sequence[PreparedInput],
    *,
    title: str = "",
    subtitle: str = "",
    config: Config | None = None,
) -> AssemblyPlan:
    """Plan de la unión a partir de los clips **ya preparados**.

    Es el camino del panel: cada clip se normaliza al entrar y aquí solo se ordena
    (#5 → #1) y se comprueba que estén todos y que el total quepa en el formato.
    """
    cfg = config or Config()
    errors: list[str] = []
    warnings: list[str] = []

    positions = sorted(clip.position for clip in clips)
    expected = list(range(1, cfg.items + 1))
    if positions != expected:
        missing = [position for position in expected if position not in positions]
        extra = [position for position in positions if position not in expected]
        if missing:
            errors.append(f"faltan los clips preparados de los puestos: {missing}")
        if extra:
            errors.append(f"hay clips preparados de puestos que no existen: {extra}")

    segments = [
        SegmentPlan(
            position=clip.position,
            label=clip.label,
            duration_s=clip.duration_s,
            output_name=prepared_name(clip.position),
        )
        for clip in sorted(clips, key=lambda entry: entry.position, reverse=True)
    ]

    return _finalise(
        title=title,
        subtitle=subtitle,
        segments=segments,
        config=cfg,
        errors=errors,
        warnings=warnings,
    )


def _finalise(
    *,
    title: str,
    subtitle: str,
    segments: Sequence[SegmentPlan],
    config: Config,
    errors: list[str],
    warnings: list[str],
) -> AssemblyPlan:
    """Cierra el plan: comprueba la duración total y devuelve el objeto inmutable."""
    plan = AssemblyPlan(
        title=title,
        segments=tuple(segments),
        subtitle=subtitle,
    )

    total = plan.total_duration_s
    if total > config.hard_max_total_seconds:
        errors.append(
            f"el vídeo unido duraría {total:.2f}s; el techo duro es {config.hard_max_total_seconds}s"
        )
    elif total > config.max_total_seconds:
        warnings.append(
            f"el vídeo unido dura {total:.2f}s, por encima del objetivo {config.max_total_seconds:.0f}s"
        )
    elif total < config.min_total_seconds:
        warnings.append(
            f"el vídeo unido dura {total:.2f}s, por debajo del objetivo {config.min_total_seconds:.0f}s"
        )

    if errors:
        raise PlanError("; ".join(errors))

    return replace(plan, warnings=tuple(warnings))
