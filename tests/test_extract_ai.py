"""Cliente LLM del score de la galería: configuración, esquema y validación.

No toca la red: comprueba las variables de entorno, el coste estimado, el esquema (score
y título, sin razones), el parseo y los cuerpos nativos de Claude, Gemini y OpenAI. La
llamada real se prueba contra un servidor local en `tests/test_rate.py`.
"""

from __future__ import annotations

import json

import pytest

from openranks.core.llm import (
    PROMPT_VERSION,
    ClipFrame,
    LlmSettings,
    build_request,
    build_schema,
    estimate_cost,
    estimate_tokens,
    parse_scores,
    price_for,
)


def _clip(index: int = 1) -> ClipFrame:
    return ClipFrame(
        index=index,
        start_s=0.0,
        end_s=5.0,
        duration_s=5.0,
        image=b"imagen-de-prueba",
    )


def _payload(entries: list[dict]) -> dict:
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps({"scores": entries}, ensure_ascii=False)
                }
            }
        ]
    }


def test_settings_read_the_environment_and_fall_back_on_invalid_values():
    settings = LlmSettings.from_env(
        {
            "OPENRANKS_LLM_API_KEY": "  clave  ",
            "OPENRANKS_LLM_MODEL": "gpt-6-luna",
            "OPENRANKS_LLM_BASE_URL": "https://ejemplo.test/v1/",
            "OPENRANKS_LLM_MAX_COST_USD": "0.5",
        }
    )
    assert settings.configured
    assert settings.api_key == "clave"
    assert settings.model == "gpt-6-luna"
    assert settings.endpoint == "https://ejemplo.test/v1/chat/completions"
    assert settings.max_cost_usd == 0.5

    fallback = LlmSettings.from_env({"OPENRANKS_LLM_MAX_COST_USD": "no"})
    assert not fallback.configured
    assert fallback.max_cost_usd == 0.02


def test_haiku_ten_clips_stays_under_the_price_target():
    settings = LlmSettings(model="claude-haiku-5.5", api_key="x")
    cost = estimate_cost(settings, 10)
    assert cost <= 0.002
    assert cost == pytest.approx(0.0011, abs=5e-5)
    input_tokens, output_tokens = estimate_tokens(10)
    assert input_tokens == 5000
    assert output_tokens == 1200


def test_unknown_model_uses_the_most_expensive_price():
    assert price_for("modelo-desconocido") == (1.20, 5.00)
    assert price_for("claude-haiku-5.5") == (0.10, 0.50)
    assert estimate_cost(LlmSettings(model="otro"), 10) > 0.002


def test_schema_requires_a_bounded_score_and_a_title_without_reasons():
    schema = build_schema()["schema"]["properties"]["scores"]["items"]
    value = schema["properties"]["value"]
    title = schema["properties"]["title"]
    assert (value["minimum"], value["maximum"]) == (0, 100)
    assert (title["minLength"], title["maxLength"]) == (3, 24)
    assert schema["required"] == ["index", "value", "title"]
    assert "reasons" not in schema["properties"]


def test_parse_scores_keeps_score_and_title_and_discards_invalid_entries():
    payload = _payload(
        [
            {"index": 1, "value": 150, "title": "FUERA"},  # fuera de 0-100
            {"index": 2, "value": 70, "title": "  el gato  "},  # válido
            {"index": 3, "value": 60, "title": "x"},  # título demasiado corto
            {"index": 4, "value": "80", "title": "TEXTO"},  # no es un número
            {"index": 99, "value": 90, "title": "AJENO"},  # índice que no existe
        ]
    )

    scores = parse_scores(payload, [1, 2, 3, 4], model="claude-haiku-5.5")

    assert set(scores) == {2, 3}
    assert scores[2].value == 70
    assert scores[2].title == "el gato"
    assert scores[2].source == "llm"
    assert scores[2].model_version == "claude-haiku-5.5"
    assert scores[3].title == "", "un título inválido no invalida el score"
    assert not hasattr(scores[2], "reasons")


def test_parse_scores_survives_invalid_json_and_code_fences():
    assert (
        parse_scores(
            {"choices": [{"message": {"content": "no es json"}}]}, [1], model="m"
        )
        == {}
    )
    fenced = (
        "```json\n"
        + json.dumps({"scores": [{"index": 1, "value": 42, "title": "BUEN CLIP"}]})
        + "\n```"
    )
    scores = parse_scores(
        {"choices": [{"message": {"content": fenced}}]}, [1], model="m"
    )
    assert scores[1].value == 42
    assert scores[1].title == "BUEN CLIP"


def test_prompt_version_travels_with_the_score():
    assert PROMPT_VERSION == "score-llm-4"


def test_anthropic_requests_are_native_and_carry_the_image():
    settings = LlmSettings(
        api_key="clave", model="claude-haiku-5.5", provider="anthropic"
    )
    body = build_request(settings, [_clip()])
    content = body["messages"][0]["content"]
    images = [block for block in content if block.get("type") == "image"]
    assert len(images) == 1
    assert images[0]["source"]["type"] == "base64"
    assert "response_format" not in body
    assert body["system"]


def test_gemini_requests_are_native_and_carry_the_image():
    settings = LlmSettings(
        api_key="clave", model="gemini-3.8-flash", provider="gemini"
    )
    body = build_request(settings, [_clip()])
    parts = body["contents"][0]["parts"]
    images = [part for part in parts if "inline_data" in part]
    assert len(images) == 1
    assert body["generationConfig"]["responseMimeType"] == "application/json"
    prompt = json.dumps(body, ensure_ascii=False).lower()
    assert "título" in prompt
    assert "reasons" not in prompt


def test_openai_requests_use_the_strict_schema_without_reasons():
    settings = LlmSettings(api_key="clave", model="gpt-6-luna", provider="openai")
    body = build_request(settings, [_clip()])
    schema = body["response_format"]["json_schema"]
    assert schema["strict"] is True
    required = schema["schema"]["properties"]["scores"]["items"]["required"]
    assert required == ["index", "value", "title"]
