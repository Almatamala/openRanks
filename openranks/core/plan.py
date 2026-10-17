"""Plan de ensamblado: qué clip va dónde y cuánto dura la unión.

Función pura y testeable sin FFmpeg (§7.6). El montaje es **siempre de corte seco**:
los tramos se pegan uno tras otro sin solape, así que la duración total es la suma
exacta de los tramos y la unión se hace por copia de streams (sin recodificar).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .binding import Binding, slugify
from .config import Config
from .media import MediaInfo


class PlanError(ValueError):
    """El plan no se puede ejecutar (no es solo un aviso)."""


@dataclass(frozen=True)
class SegmentPlan:
    """Un tramo del vídeo final. ``position == 0`` es el cold open."""

    position: int
    source: Path
    label: str
    duration_s: float
    output_name: str

    @property
    def is_cold_open(self) -> bool:
        return self.position == 0


@dataclass(frozen=True)
class AssemblyPlan:
    title: str
    segments: tuple[SegmentPlan, ...]
    cold_open_s: float
    warnings: tuple[str, ...] = ()

    @property
    def clip_count(self) -> int:
        """Puestos del ranking (sin contar el cold open)."""
        return sum(1 for segment in self.segments if not segment.is_cold_open)

    @property
    def total_duration_s(self) -> float:
        """Duración real: la suma de los tramos (el montaje es de corte seco)."""
        return sum(segment.duration_s for segment in self.segments)

    @property
    def outputs(self) -> tuple[Path, ...]:
        return tuple(Path(segment.output_name) for segment in self.segments)

    def to_manifest(self) -> dict:
        return {
            "title": self.title,
            "clip_count": self.clip_count,
            "cold_open_s": self.cold_open_s,
            "total_duration_s": round(self.total_duration_s, 3),
            "warnings": list(self.warnings),
            "segments": [
                {
                    "position": segment.position,
                    "kind": "cold_open" if segment.is_cold_open else "ranking",
                    "label": segment.label,
                    "duration_s": round(segment.duration_s, 3),
                    "output": segment.output_name,
                }
                for segment in self.segments
            ],
        }


def output_name_for(position: int, label: str) -> str:
    """``5`` + ``"GATO VOLADOR"`` → ``05-gato-volador.mp4``."""
    if position == 0:
        return "00-cold-open.mp4"
    return f"{position:02d}-{slugify(label, fallback=f'puesto-{position}')}.mp4"


def build_plan(
    binding: Binding,
    infos: dict[int, MediaInfo],
    *,
    config: Config | None = None,
    cold_open_s: float = 0.0,
) -> AssemblyPlan:
    """Construye el plan de ensamblado a partir del binding y los medios medidos.

    L1 une **siempre** con corte seco (sin solape), lo que permite pegar los tramos
    por copia de streams sin recodificar el vídeo.
    """
    cfg = config or Config()
    errors: list[str] = []
    warnings: list[str] = []

    missing = [position for position in range(1, cfg.items + 1) if position not in infos]
    if missing:
        raise PlanError(f"faltan los medios de los puestos: {missing}")

    segments: list[SegmentPlan] = []

    # Cold open: un adelanto del #1 al principio, sin rótulo de posición.
    if cold_open_s > 0:
        best = binding.best
        best_info = infos[best.position]
        teaser = min(cold_open_s, best_info.usable_duration_s)
        if teaser < cold_open_s:
            warnings.append(
                f"el cold open pedía {cold_open_s}s y el #1 dura {best_info.usable_duration_s:.2f}s: se usan {teaser:.2f}s"
            )
        segments.append(
            SegmentPlan(
                position=0,
                source=best.path,
                label=best.label,
                duration_s=teaser,
                output_name=output_name_for(0, best.label),
            )
        )
    elif cold_open_s < 0:
        errors.append("el cold open no puede ser negativo")

    for item in binding.ordered:
        info = infos[item.position]
        segments.append(
            SegmentPlan(
                position=item.position,
                source=item.path,
                label=item.label,
                # La duración del vídeo, no la del contenedor: es la que da los fotogramas.
                duration_s=info.usable_duration_s,
                output_name=output_name_for(item.position, item.label),
            )
        )

    plan = AssemblyPlan(
        title=binding.title,
        segments=tuple(segments),
        cold_open_s=cold_open_s,
        warnings=(),  # se rellena abajo con los avisos de duración
    )

    total = plan.total_duration_s
    if total > cfg.hard_max_total_seconds:
        errors.append(
            f"el vídeo unido duraría {total:.2f}s; el techo duro es {cfg.hard_max_total_seconds}s"
        )
    elif total > cfg.max_total_seconds:
        warnings.append(
            f"el vídeo unido dura {total:.2f}s, por encima del objetivo {cfg.max_total_seconds:.0f}s"
        )
    elif total < cfg.min_total_seconds:
        warnings.append(
            f"el vídeo unido dura {total:.2f}s, por debajo del objetivo {cfg.min_total_seconds:.0f}s"
        )

    if errors:
        raise PlanError("; ".join(errors))

    return AssemblyPlan(
        title=plan.title,
        segments=plan.segments,
        cold_open_s=plan.cold_open_s,
        warnings=tuple(warnings),
    )
