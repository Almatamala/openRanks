"""El plan de ensamblado: orden #5→#1, duración real de corte seco y cold open."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core.binding import Binding, ClipItem
from openranks.core.config import Config
from openranks.core.media import MediaInfo
from openranks.core.plan import PlanError, build_plan, output_name_for


def _info(duration_s: float) -> MediaInfo:
    return MediaInfo(
        path=Path("fuente.mp4"),
        duration_s=duration_s,
        width=1080,
        height=1920,
        fps=30.0,
        video_codec="h264",
        pix_fmt="yuv420p",
        audio_codec="aac",
        sample_rate=48000,
        channels=2,
        size_bytes=1,
    )


def _binding() -> Binding:
    items = tuple(
        ClipItem(position=index, path=Path(f"clip-{index}.mp4"), label=f"PUESTO {index}") for index in range(1, 6)
    )
    return Binding(title="TOP 5 GATOS", items=items)


def _infos(duration_s: float = 6.0) -> dict[int, MediaInfo]:
    return {position: _info(duration_s) for position in range(1, 6)}


def test_segments_are_ordered_from_position_five_to_one():
    plan = build_plan(_binding(), _infos(), config=Config())
    assert [segment.position for segment in plan.segments] == [5, 4, 3, 2, 1]


def test_total_is_the_sum_of_the_segments():
    # Corte seco: los tramos no se solapan, así que el total es la suma exacta.
    plan = build_plan(_binding(), _infos(6.0), config=Config())
    assert plan.total_duration_s == pytest.approx(30.0)


def test_short_total_only_warns():
    plan = build_plan(_binding(), _infos(4.0), config=Config())
    assert any("por debajo del objetivo" in warning for warning in plan.warnings)


def test_long_total_only_warns_up_to_the_hard_ceiling():
    plan = build_plan(_binding(), _infos(12.0), config=Config())
    assert any("por encima del objetivo" in warning for warning in plan.warnings)


def test_total_over_the_hard_ceiling_is_an_error():
    with pytest.raises(PlanError, match="techo duro"):
        build_plan(_binding(), _infos(13.0), config=Config())


def test_cold_open_prepends_a_teaser_of_the_best_clip():
    plan = build_plan(_binding(), _infos(6.0), config=Config(), cold_open_s=2.0)
    first = plan.segments[0]
    assert first.position == 0 and first.is_cold_open
    assert first.source == Path("clip-1.mp4")  # el #1
    assert first.duration_s == pytest.approx(2.0)
    assert plan.total_duration_s == pytest.approx(32.0)
    assert plan.clip_count == 5


def test_cold_open_longer_than_the_best_clip_is_clamped_and_warned():
    plan = build_plan(_binding(), _infos(6.0), config=Config(), cold_open_s=99.0)
    assert plan.segments[0].duration_s == pytest.approx(6.0)
    assert any("cold open" in warning for warning in plan.warnings)


def test_negative_cold_open_is_an_error():
    with pytest.raises(PlanError, match="cold open"):
        build_plan(_binding(), _infos(6.0), config=Config(), cold_open_s=-1.0)


def test_missing_media_is_an_error():
    infos = _infos(6.0)
    del infos[2]
    with pytest.raises(PlanError, match="faltan los medios"):
        build_plan(_binding(), infos, config=Config())


@pytest.mark.parametrize(
    ("position", "label", "expected"),
    [(5, "GATO VOLADOR", "05-gato-volador.mp4"), (1, "¡¡CAOS!!", "01-caos.mp4"), (0, "X", "00-cold-open.mp4")],
)
def test_output_names(position, label, expected):
    assert output_name_for(position, label) == expected


def test_manifest_payload_lists_the_segments_in_playback_order():
    plan = build_plan(_binding(), _infos(6.0), config=Config())
    payload = plan.to_manifest()
    assert [segment["position"] for segment in payload["segments"]] == [5, 4, 3, 2, 1]
    assert payload["total_duration_s"] == pytest.approx(30.0)
    assert payload["clip_count"] == 5
    # El manifiesto ya no habla de transiciones: el montaje es de corte seco.
    assert "transition" not in payload and "overlaps_s" not in payload
