"""Plan de la unión a partir de los clips ya preparados (sin FFmpeg).

El panel prepara cada puesto al subirlo y solo une cuando están todos los ticks. Este
módulo fija el contrato de esa unión: orden de reproducción (#5 → #1), nombres estables
y textos en el manifiesto.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core.config import Config
from openranks.core.plan import PlanError, PreparedInput, plan_from_prepared, prepared_name
from openranks.prepare import metadata_path, prepared_file


def _inputs(count: int = 5) -> list[PreparedInput]:
    return [
        PreparedInput(position=position, path=Path(f"{position:02d}.mp4"), label=f"PUESTO {position}", duration_s=2.0)
        for position in range(1, count + 1)
    ]


def test_the_prepared_name_depends_only_on_the_position():
    # El rótulo se escribe después de preparar: si el nombre cambiara, la unión
    # tendría que renombrar archivos (o volver a normalizar).
    assert prepared_name(5) == "05.mp4"
    assert prepared_name(10) == "10.mp4"
    assert prepared_file("job", 3).as_posix() == "job/prepared/03.mp4"
    assert metadata_path("job", 3).as_posix() == "job/prepared/03.json"


def test_the_plan_plays_the_last_position_first():
    plan = plan_from_prepared(_inputs(), title="TOP 5 PRUEBAS", config=Config())
    assert [segment.position for segment in plan.segments] == [5, 4, 3, 2, 1]
    assert [segment.output_name for segment in plan.segments] == ["05.mp4", "04.mp4", "03.mp4", "02.mp4", "01.mp4"]
    assert plan.total_duration_s == pytest.approx(10.0)
    assert plan.clip_count == 5
    assert plan.title == "TOP 5 PRUEBAS"


def test_missing_positions_are_reported_before_touching_ffmpeg():
    with pytest.raises(PlanError, match="faltan los clips preparados"):
        plan_from_prepared(_inputs()[1:], config=Config())


def test_positions_outside_the_ranking_are_rejected():
    extra = [*_inputs(), PreparedInput(position=9, path=Path("09.mp4"), label="SOBRA", duration_s=2.0)]
    with pytest.raises(PlanError, match="puestos que no existen"):
        plan_from_prepared(extra, config=Config())


def test_the_manifest_keeps_the_editable_texts():
    plan = plan_from_prepared(
        _inputs(), title="TOP 5 GATOS", subtitle="LOS MÁS LOCOS", config=Config()
    )
    payload = plan.to_manifest()
    assert payload["title"] == "TOP 5 GATOS"
    assert payload["subtitle"] == "LOS MÁS LOCOS"
    assert [segment["label"] for segment in payload["segments"]] == [
        "PUESTO 5",
        "PUESTO 4",
        "PUESTO 3",
        "PUESTO 2",
        "PUESTO 1",
    ]
