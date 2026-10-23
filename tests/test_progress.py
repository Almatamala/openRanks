"""Progreso del montaje sin FFmpeg: el porcentaje que alimenta la barra y el ETA (§RF-9.3)."""

from __future__ import annotations

import pytest

from openranks.core.progress import PHASES, SPAN_EDIT_ONLY, SPAN_FULL, Progress


def _collect() -> tuple[list, Progress]:
    events: list = []
    return events, Progress(events.append)


def test_the_full_bar_covers_zero_to_a_hundred_in_order():
    spans = [SPAN_FULL[phase] for phase in PHASES]
    assert spans[0][0] == 0.0
    assert spans[-1][1] == 100.0
    for (_, high), (low, _) in zip(spans, spans[1:]):
        assert high == low, "los tramos tienen que encadenarse sin huecos"


def test_edit_only_bar_is_a_full_bar_of_its_own():
    assert SPAN_EDIT_ONLY["editing"][0] == 0.0
    assert SPAN_EDIT_ONLY["finishing"][1] == 100.0


def test_normalizing_spreads_the_batch_across_its_span():
    # Normalizar se lleva la mayor parte de la barra: la unión en corte seco es una copia
    # de streams y ya no compite por el porcentaje.
    events, track = _collect()
    track.normalizing(0, 5, "clip 1")
    track.normalizing(1, 5, "clip 2")
    track.normalizing(5, 5, "último")
    assert [event.percent for event in events] == [5.0, 18.0, 70.0]
    assert events[1].step == 1 and events[1].total == 5


def test_the_percentage_never_goes_backwards_across_a_full_run():
    events, track = _collect()
    track.preparing("Midiendo los 5 clips")
    for done in range(6):
        track.normalizing(done, 5, f"clip {done}")
    track.joining("Uniendo")
    track.editing_step(0.08, "Preparando la edición")
    track.editing_step(0.25, "Dibujando")
    track.editing_step(0.9, "Portada")
    track.finishing("Listo")

    percents = [event.percent for event in events]
    assert percents == sorted(percents), percents
    assert percents[0] == 5.0
    assert percents[-1] == 100.0
    assert len(set(percents)) > 5, "el avance tiene que ser granular, no cuatro saltos"


def test_an_empty_batch_is_treated_as_finished():
    events, track = _collect()
    track.normalizing(0, 0, "sin tramos")
    assert events[0].percent == SPAN_FULL["normalizing"][1]


def test_a_phase_outside_the_bar_is_an_error():
    _, track = _collect()
    events: list = []
    edit_only = Progress(events.append, span=SPAN_EDIT_ONLY)
    with pytest.raises(KeyError, match="normalizing"):
        edit_only.normalizing(0, 5, "no hay clips que normalizar aquí")
    assert events == []


def test_to_json_only_carries_what_the_panel_needs():
    event = Progress().normalizing(2, 5, "clip 3")
    payload = event.to_json()
    assert payload == {"percent": 31.0, "phase": "normalizing", "label": "clip 3", "step": 2, "total": 5}
