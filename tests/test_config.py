"""Configuración: los defectos son el criterio de salida de L1 y el entorno los sobreescribe."""

from __future__ import annotations

from pathlib import Path

from openranks.core.config import Config

PANEL_LIMITS = Path(__file__).resolve().parents[1] / "web" / "lib" / "limits.ts"


def test_defaults_match_the_l1_output_criterion():
    config = Config()
    assert config.items == 5
    assert config.total == (1080, 1920)
    assert config.fps == 30
    # Por defecto se detecta el área útil y se recorta el fondo borroso; `band`,
    # `contain` y `cover` siguen disponibles como elección explícita.
    assert config.fit == "auto"
    assert config.pix_fmt == "yuv420p"
    assert config.loudness_lufs == -14.0
    assert config.true_peak_db == -1.0
    assert (config.min_total_seconds, config.max_total_seconds) == (30.0, 58.0)


def test_the_ranking_goes_from_five_to_ten_positions():
    config = Config()
    assert (config.items, config.items_min, config.items_max) == (5, 5, 10)
    assert Config.from_env().items == 5


def test_the_panel_offers_the_same_positions_as_the_engine():
    """Regresión: el selector del panel no puede ofrecer un ranking que el motor rechace."""
    source = PANEL_LIMITS.read_text(encoding="utf-8")
    config = Config()
    assert f"export const POSITIONS_MIN = {config.items_min};" in source
    assert f"export const POSITIONS_MAX = {config.items_max};" in source


def test_text_limits_match_the_rpd_9_5():
    config = Config()
    assert config.title_layer_chars == 40
    assert config.title_lines_max == 3
    assert config.label_chars == 24
    assert config.label_words == 4


def test_the_panel_validates_the_same_text_limits_as_the_engine():
    """Regresión: el formulario no puede aceptar un texto que el binding rechaza."""
    source = PANEL_LIMITS.read_text(encoding="utf-8")
    config = Config()
    assert f"titleLayerChars: {config.title_layer_chars}," in source
    assert f"labelChars: {config.label_chars}," in source
    assert f"labelWords: {config.label_words}," in source


def test_from_env_overrides_every_knob(monkeypatch):
    monkeypatch.setenv("OPENRANKS_ITEMS", "8")
    monkeypatch.setenv("OPENRANKS_LOUDNESS_LUFS", "-12.5")
    monkeypatch.setenv("OPENRANKS_WIDTH", "720")
    monkeypatch.setenv("OPENRANKS_HEIGHT", "1280")
    monkeypatch.setenv("OPENRANKS_MIN_TOTAL_SECONDS", "20")
    monkeypatch.setenv("OPENRANKS_PRESET", "veryfast")
    monkeypatch.setenv("OPENRANKS_FIT", "cover")

    config = Config.from_env()
    assert config.items == 8
    assert config.total == (720, 1280)
    assert config.loudness_lufs == -12.5
    assert config.min_total_seconds == 20.0
    assert config.preset == "veryfast"
    assert config.fit == "cover"


def test_empty_env_values_fall_back_to_defaults(monkeypatch):
    monkeypatch.setenv("OPENRANKS_ITEMS", "")
    assert Config.from_env().items == 5


def test_manifest_view_is_reproducible():
    payload = Config().to_manifest()
    assert payload["target"] == "1080x1920"
    assert payload["fit"] == "auto"
    assert payload["audio"]["loudness_lufs"] == -14.0
    assert payload["bands"]["total_seconds"] == [30.0, 58.0]
