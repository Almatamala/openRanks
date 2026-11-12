"""Score de clips completos de la galería (P3-9 y P3-12), sin FFmpeg ni red."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from openranks import rate as rate_module
from openranks.core.llm import LlmSettings


def test_sin_clave_no_se_puntua_y_no_se_pide_ffmpeg(tmp_path):
    clip = tmp_path / "gatos_graciosos.mp4"
    clip.write_bytes(b"x")

    with pytest.raises(rate_module.RateError, match="clave"):
        rate_module.rate_many([clip], settings=LlmSettings(api_key=None))


def test_el_contrato_lleva_titulo_y_nunca_rutas(tmp_path):
    rated = rate_module.RatedClip(
        file="gatos_graciosos.mp4",
        duration_s=12.5,
        score=71,
        title="EL GATO QUE NO SABÍA",
        source="llm",
        model_version="claude-haiku-5.5",
    )
    document = rated.to_json(1)

    assert document["title"] == "EL GATO QUE NO SABÍA"
    assert document["score"] == 71
    assert document["file"] == "gatos_graciosos.mp4"
    assert "reasons" not in document
    assert str(tmp_path) not in json.dumps(document)


def test_un_clip_ilegible_no_tumba_la_tanda(tmp_path, monkeypatch):
    good = tmp_path / "bueno.mp4"
    good.write_bytes(b"x")

    monkeypatch.setattr(rate_module, "resolve_binary", lambda *_: "bin")
    monkeypatch.setattr(
        rate_module,
        "probe",
        lambda *_: (_ for _ in ()).throw(rate_module.ToolError("no se pudo abrir")),
    )

    settings = LlmSettings(api_key="clave-de-prueba", model="claude-haiku-5.5")
    clips = rate_module.rate_many([good, tmp_path / "roto.mp4"], settings=settings)

    assert all(clip.error for clip in clips)
    assert clips[0].score is None


def test_puntua_la_tanda_en_una_llamada_y_devuelve_titulo(tmp_path, monkeypatch):
    clip = tmp_path / "gatos_graciosos.mp4"
    clip.write_bytes(b"x")

    monkeypatch.setattr(rate_module, "resolve_binary", lambda *_: "bin")
    monkeypatch.setattr(
        rate_module,
        "probe",
        lambda *_: SimpleNamespace(video_codec="h264", usable_duration_s=10.0),
    )
    monkeypatch.setattr(
        rate_module,
        "sample_at",
        lambda _ffmpeg, _src, _at, destination: Path(destination).write_bytes(b"jpg"),
    )
    sent: list[dict] = []

    def fake_post(_settings, payload):
        sent.append(payload)
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "scores": [
                                    {
                                        "index": 1,
                                        "value": 73,
                                        "title": "EL GATO",
                                    }
                                ]
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(rate_module, "post_json", fake_post)
    settings = LlmSettings(api_key="clave", model="claude-haiku-5.5")
    clips = rate_module.rate_many([clip], settings=settings)

    assert len(sent) == 1, "la tanda entera viaja en una sola llamada"
    assert clips[0].score == 73
    assert clips[0].title == "EL GATO"
    assert clips[0].source == "llm"
