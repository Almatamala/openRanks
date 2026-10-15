"""El listado del preset: todo ajuste tiene que decir qué es y **dónde** se cambia.

Es lo que responde a «¿dónde veo cómo está la edición del texto?» sin que nadie tenga
que leer el código a ciegas.
"""

from __future__ import annotations

import json

import pytest

from openranks.core.overlay import (
    DEFAULT_STYLE,
    EDITABLE_SECTIONS,
    STYLE_SOURCES,
    describe_style,
    get_style,
    load_saved_preset,
)
from openranks.core.specs import RANK_COLORS


def test_every_setting_explains_itself_and_points_at_its_file():
    rows = describe_style()
    assert len(rows) >= 20
    for row in rows:
        assert row["key"], row
        assert len(row["what"]) > 15, f"{row['key']} no explica para qué sirve"
        assert "openranks/" in row["where"], f"{row['key']} no dice dónde se cambia"


def test_the_groups_you_touch_to_improve_the_template_are_there():
    groups = {row["group"] for row in describe_style()}
    assert {"Fuente", "Título", "Escalera", "Rótulo", "CTA", "Colores"} <= groups


def test_every_source_group_is_covered():
    rows = describe_style()
    assert {row["group"] for row in rows} == set(STYLE_SOURCES)


def test_rank_colours_are_the_ones_the_render_uses():
    row = next(row for row in describe_style() if row["key"] == "rank_colors")
    assert row["value"] == RANK_COLORS
    assert row["value"][1] == "#D4AF37"


def test_the_listing_follows_the_actual_preset_not_a_copy(monkeypatch):
    custom = get_style({"title": {"y": 250, "accent": "#00FF00"}})
    rows = {row["key"]: row["value"] for row in describe_style(custom)}
    assert rows["title.y"] == 250
    assert rows["title.accent"] == "#00FF00"
    assert rows["title.y"] != DEFAULT_STYLE["title"]["y"]


def test_the_listing_reports_the_font_the_render_will_actually_use(monkeypatch):
    """Regresión: el panel decía `Arial` mientras el contenedor renderizaba `DejaVu Sans`."""
    monkeypatch.setenv("OPENRANKS_FONT", "DejaVu Sans")
    rows = {row["key"]: row["value"] for row in describe_style()}
    assert rows["font"] == "DejaVu Sans"


def test_a_preset_without_the_theme_falls_back_to_the_default_style():
    assert get_style().get("theme") == DEFAULT_STYLE["theme"]


@pytest.mark.parametrize(
    "key", ["title.size", "title.background", "rank_ladder.y_top", "rank_ladder.y_bottom", "cta.hold_s"]
)
def test_the_geometry_knobs_are_numeric(key):
    rows = {row["key"]: row["value"] for row in describe_style()}
    assert isinstance(rows[key], (int, float, bool))


def _write_preset(tmp_path, payload) -> str:
    path = tmp_path / "preset.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return str(path)


def test_a_saved_preset_wins_over_the_factory_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "OPENRANKS_PRESET_FILE",
        _write_preset(
            tmp_path,
            {"font": "Liberation Sans", "title": {"size": 150, "background": True}, "rank_ladder": {"size": 90, "x": 300}},
        ),
    )
    style = get_style()
    assert style["font"] == "Liberation Sans"
    assert style["title"]["size"] == 150 and style["title"]["background"] is True
    assert style["rank_ladder"]["size"] == 90 and style["rank_ladder"]["x"] == 300
    # Lo que no se guardó sigue siendo el valor de fábrica.
    assert style["title"]["color"] == DEFAULT_STYLE["title"]["color"]
    assert style["rank_ladder"]["y_top"] == DEFAULT_STYLE["rank_ladder"]["y_top"]


def test_the_saved_font_beats_the_container_default(tmp_path, monkeypatch):
    """En Docker `OPENRANKS_FONT=DejaVu Sans`; una fuente guardada tiene que mandar."""
    monkeypatch.setenv("OPENRANKS_FONT", "DejaVu Sans")
    monkeypatch.setenv("OPENRANKS_PRESET_FILE", _write_preset(tmp_path, {"font": "Liberation Sans"}))
    assert get_style()["font"] == "Liberation Sans"


def test_explicit_overrides_still_beat_the_saved_preset(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENRANKS_PRESET_FILE", _write_preset(tmp_path, {"title": {"size": 150}}))
    assert get_style({"title": {"size": 60}})["title"]["size"] == 60


def test_a_corrupt_or_unknown_saved_preset_is_ignored(tmp_path, monkeypatch):
    broken = tmp_path / "broken.json"
    broken.write_text("{no soy json", encoding="utf-8")
    monkeypatch.setenv("OPENRANKS_PRESET_FILE", str(broken))
    assert load_saved_preset() == {}
    assert get_style()["title"]["size"] == DEFAULT_STYLE["title"]["size"]

    # Solo entran las claves editables: nada de colarse el layout entero.
    monkeypatch.setenv("OPENRANKS_PRESET_FILE", _write_preset(tmp_path, {"title": {"y": 999}, "hack": 1}))
    assert load_saved_preset() == {}
    assert "title" in EDITABLE_SECTIONS
