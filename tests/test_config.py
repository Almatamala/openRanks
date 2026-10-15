"""Configuración: los defectos son el criterio de salida de L1 y el entorno los sobreescribe."""

from __future__ import annotations

from openranks.core.config import Config


def test_defaults_match_the_l1_output_criterion():
    config = Config()
    assert config.items == 5
    assert config.total == (1080, 1920)
    assert config.fps == 30
    # Por defecto se agranda a la banda central (recortando solo laterales); el clip
    # entero sin recortar queda con `contain` y el recorte total con `cover`.
    assert config.fit == "band"
    assert config.pix_fmt == "yuv420p"
    assert config.loudness_lufs == -14.0
    assert config.true_peak_db == -1.0
    assert (config.min_total_seconds, config.max_total_seconds) == (30.0, 58.0)


def test_text_limits_match_the_plan_9_5():
    config = Config()
    assert config.title_layer_chars == 28
    assert config.title_layers_max == 3
    assert config.label_chars == 24
    assert config.label_words == 4


def test_from_env_overrides_every_knob(monkeypatch):
    monkeypatch.setenv("OPENRANKS_ITEMS", "3")
    monkeypatch.setenv("OPENRANKS_LOUDNESS_LUFS", "-12.5")
    monkeypatch.setenv("OPENRANKS_WIDTH", "720")
    monkeypatch.setenv("OPENRANKS_HEIGHT", "1280")
    monkeypatch.setenv("OPENRANKS_MIN_TOTAL_SECONDS", "20")
    monkeypatch.setenv("OPENRANKS_PRESET", "veryfast")
    monkeypatch.setenv("OPENRANKS_FIT", "cover")

    config = Config.from_env()
    assert config.items == 3
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
    assert payload["fit"] == "band"
    assert payload["audio"]["loudness_lufs"] == -14.0
    assert payload["bands"]["total_seconds"] == [30.0, 58.0]
