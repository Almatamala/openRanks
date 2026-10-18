"""Spec de L2 sin FFmpeg: ventanas de tiempo, título en capas y colores (§9.2)."""

from __future__ import annotations

import pytest

from openranks.core.config import Config
from openranks.core.overlay import DEFAULT_STYLE, get_style
from openranks.core.specs import (
    SpecError,
    badge_text,
    badge_y,
    build_spec,
    labels_from_segments,
    rank_color,
    timeline,
    title_layers,
    total_duration_s,
)


def _segments(duration: float = 7.0, count: int = 5) -> list[dict]:
    return [
        {"position": position, "label": f"PUESTO {position}", "duration_s": duration}
        for position in range(count, 0, -1)
    ]


def test_timeline_is_the_running_sum_without_overlap():
    # Corte seco: cada tramo empieza donde acaba el anterior.
    windows = timeline(_segments(7.0))
    assert [window.position for window in windows] == [5, 4, 3, 2, 1]
    assert [(window.from_s, window.to_s) for window in windows] == [
        (0.0, 7.0),
        (7.0, 14.0),
        (14.0, 21.0),
        (21.0, 28.0),
        (28.0, 35.0),
    ]
    assert total_duration_s(windows) == pytest.approx(35.0)


def test_timeline_keeps_the_cold_open_as_position_zero():
    segments = [{"position": 0, "label": "TEASER", "duration_s": 2.0}, *_segments(7.0)]
    windows = timeline(segments)
    assert windows[0].is_cold_open and windows[0].position == 0
    assert windows[1].from_s == pytest.approx(2.0)
    assert total_duration_s(windows) == pytest.approx(37.0)


def test_incomplete_segment_is_an_error():
    with pytest.raises(SpecError, match="tramo incompleto"):
        timeline([{"position": 5}])


def test_title_layers_give_the_number_its_own_colour():
    layers = title_layers("TOP 5 GATOS", base_color="#FFFFFF", accent_color="#FFD60A")
    assert [layer["text"] for layer in layers] == ["TOP ", "5", " GATOS"]
    assert layers[1]["color"] == "#FFD60A"
    assert layers[1]["scale"] == 1.35
    assert layers[0]["color"] == "#FFFFFF"


def test_title_without_a_number_stays_a_single_layer():
    layers = title_layers("MOMENTOS LOCOS", base_color="#FFFFFF", accent_color="#FFD60A")
    assert len(layers) == 1
    assert layers[0]["text"] == "MOMENTOS LOCOS"


def test_starred_words_take_the_accent_and_underscored_the_blue():
    layers = title_layers(
        "TOP *5* _GATOS_ LOCOS",
        base_color="#FFFFFF",
        accent_color="#FFD60A",
        blue_color="#3B82F6",
    )
    # Las marcas no se dibujan: solo eligen color.
    colours = {layer["text"]: layer["color"] for layer in layers}
    assert colours["5"] == "#FFD60A"
    assert colours["GATOS"] == "#3B82F6"
    assert colours["TOP "] == "#FFFFFF" and colours[" LOCOS"] == "#FFFFFF"
    assert "*" not in "".join(layer["text"] for layer in layers)
    assert "_" not in "".join(layer["text"] for layer in layers)


def test_medals_only_reach_the_podium():
    ladder = {"medals": {1: "🥇", 2: "🥈", 3: "🥉"}}
    assert [badge_text(position, ladder) for position in (5, 4, 3, 2, 1)] == ["5", "4", "🥉", "🥈", "🥇"]
    # Sin medallas configuradas, la casilla vuelve a su número, pelado (sin `#`).
    assert badge_text(1, {"medals": {}}) == "1"
    assert badge_text(1, {}) == "1"
    assert not any("#" in badge_text(position, ladder) for position in range(1, 6))


def test_rank_colours_are_gold_silver_bronze_and_white_from_four_on():
    assert rank_color(1) == "#D4AF37"
    assert rank_color(2) == "#C0C0C0"
    assert rank_color(3) == "#CD7F32"
    # Del 4 en adelante el número va en blanco (el azul competía con el rótulo).
    assert all(rank_color(position) == "#FFFFFF" for position in range(4, 11))


def test_badge_ladder_puts_five_bottom_and_one_top():
    ladder = DEFAULT_STYLE["rank_ladder"]
    assert badge_y(5, ladder) == pytest.approx(ladder["y_bottom"])
    assert badge_y(1, ladder) == pytest.approx(ladder["y_top"])
    assert badge_y(4, ladder) > badge_y(3, ladder) > badge_y(2, ladder)


def test_badge_ladder_spreads_as_many_positions_as_the_ranking_has():
    ladder = DEFAULT_STYLE["rank_ladder"]
    for count in (5, 7, 10):
        ys = [badge_y(position, ladder, slots=count) for position in range(count, 0, -1)]
        assert ys[0] == pytest.approx(ladder["y_bottom"])
        assert ys[-1] == pytest.approx(ladder["y_top"])
        assert ys == sorted(ys, reverse=True)


def _spec(cold_open: bool = False) -> dict:
    segments = _segments(7.0)
    if cold_open:
        segments = [{"position": 0, "label": "TEASER", "duration_s": 2.0}, *segments]
    return build_spec(
        title="TOP 5 GATOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=segments,
        cold_open_s=2.0 if cold_open else 0.0,
        style=get_style(),
        config=Config(),
    )


def test_spec_total_matches_the_timeline():
    assert _spec()["total_duration_s"] == pytest.approx(35.0)
    # El spec ya no lleva transición: el montaje es de corte seco.
    assert "transition" not in _spec()


def test_the_ladder_is_complete_from_the_first_frame():
    spec = _spec()
    slots = spec["rank_ladder"]["slots"]
    assert [slot["position"] for slot in slots] == [5, 4, 3, 2, 1]
    # El podio lleva medalla; el resto, su número pelado.
    assert [slot["text"] for slot in slots] == ["5", "4", "🥉", "🥈", "🥇"]
    assert [slot["number"] for slot in slots] == ["5", "4", "3", "2", "1"]
    # Solo el podio lleva glifo de medalla; el resto no fuerza otra fuente.
    assert [slot["medal"] for slot in slots] == [None, None, "🥉", "🥈", "🥇"]
    # Las cinco casillas están puestas desde el fotograma 0 y duran todo el vídeo.
    assert {slot["from_s"] for slot in slots} == {0.0}
    assert {slot["to_s"] for slot in slots} == {35.0}
    # Lo que llega con cada clip es su **turno** (§9.3).
    assert [slot["active_from_s"] for slot in slots] == [0.0, 7.0, 14.0, 21.0, 28.0]
    assert [slot["active_to_s"] for slot in slots] == [7.0, 14.0, 21.0, 28.0, 35.0]
    assert slots[-1]["color"] == "#D4AF37"


def test_label_sits_next_to_its_own_badge():
    spec = _spec()
    labels = spec["clip_labels"]
    slots = spec["rank_ladder"]["slots"]
    ladder = DEFAULT_STYLE["rank_ladder"]
    dx = float(DEFAULT_STYLE["clip_label"]["dx"])
    for label, slot in zip(labels, slots):
        assert label["x"] == pytest.approx(ladder["x"] + dx)
        assert label["y"] == pytest.approx(slot["y"])


def test_each_label_arrives_with_its_clip_and_stays():
    spec = _spec()
    labels = spec["clip_labels"]
    assert [item["text"] for item in labels] == [f"RÓTULO {position}" for position in range(5, 0, -1)]
    # Cada rótulo entra con su clip…
    assert [item["from_s"] for item in labels] == [0.0, 7.0, 14.0, 21.0, 28.0]
    # …y se queda hasta el final: el texto se **acumula**, no se sustituye.
    assert {item["to_s"] for item in labels} == {35.0}
    # Mientras su puesto tiene el turno se ve nítido; después se atenúa con él.
    assert [item["active_to_s"] for item in labels] == [7.0, 14.0, 21.0, 28.0, 35.0]


def test_cold_open_has_no_badge_but_keeps_the_windows_aligned():
    spec = _spec(cold_open=True)
    assert all(slot["position"] != 0 for slot in spec["rank_ladder"]["slots"])
    # La escalera está puesta desde el fotograma 0, pero al 5 le toca cuando acaba el teaser.
    assert spec["rank_ladder"]["slots"][0]["from_s"] == pytest.approx(0.0)
    assert spec["rank_ladder"]["slots"][0]["active_from_s"] == pytest.approx(2.0)
    assert spec["total_duration_s"] == pytest.approx(37.0)


def test_the_ranking_ends_without_a_cta():
    """El cierre no lleva CTA: la edición termina con la escalera y el último rótulo."""
    assert "cta" not in _spec()


def test_editable_surface_is_only_text():
    spec = _spec()
    assert spec["editable_surface"]["fields"] == ["title", "labels"]
    assert spec["title"]["text"] == "TOP 5 GATOS"
    assert spec["title"]["layers"][1]["text"] == "5"


def test_labels_from_segments_reads_the_plan():
    assert labels_from_segments(_segments()) == {position: f"PUESTO {position}" for position in range(1, 6)}


def test_a_ranking_of_ten_positions_builds_ten_slots():
    spec = build_spec(
        title="TOP 10 GATOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 11)},
        segments=_segments(5.0, count=10),
        cold_open_s=0.0,
        style=get_style(),
        config=Config(items=10),
    )
    slots = spec["rank_ladder"]["slots"]
    labels = spec["clip_labels"]
    assert [slot["position"] for slot in slots] == list(range(10, 0, -1))
    assert len(labels) == 10
    assert spec["total_duration_s"] == pytest.approx(50.0)
    # El último (el 1) queda arriba y el primero (el 10) abajo.
    assert slots[-1]["y"] < slots[0]["y"]


def test_the_title_is_fitted_to_the_space_it_has():
    """El título nunca se sale del marco: se reparte en renglones y, si hace falta, baja.

    220 px de alto no caben con este texto, así que el spec guarda el tamaño **ajustado**
    y los renglones ya repartidos.
    """
    style = get_style({"title": {"size": 220}})
    spec = build_spec(
        title="TOP 8 MOMENTOS LOCOS DE GATOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 9)},
        segments=_segments(6.0, count=8),
        cold_open_s=0.0,
        style=style,
        config=Config(items=8),
    )
    title = spec["title"]
    assert title["size"] < 220
    assert 1 < len(title["lines"]) <= Config().title_layers_max
    # Las palabras no se pierden ni se reordenan al repartirlas.
    words = [word["text"] for line in title["lines"] for word in line]
    assert words == "TOP 8 MOMENTOS LOCOS DE GATOS".split()
    # El número conserva su color y su escala aunque cambie de renglón.
    number = next(word for line in title["lines"] for word in line if word["text"] == "8")
    assert number["color"] == DEFAULT_STYLE["title"]["accent"] and number["scale"] == 1.35
