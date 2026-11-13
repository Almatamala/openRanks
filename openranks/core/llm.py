"""Cliente LLM del score (F3 · P3-6): configuración, prompt, esquema y validación.

Este módulo es **puro**: no hace peticiones, no toca el disco y no lee el entorno salvo
en `LlmSettings.from_env`. La parte de red y la caché viven en `openranks/llm.py`, para
poder probar el cliente contra un servidor local sin acercarse al proveedor.

El LLM es el **único** productor del score (P3-11): sin clave no se puntúa. Devuelve
score 0-100 y un título corto para el puesto; todo se valida aquí y
lo inválido se descarta, de modo que el trabajo falla con un mensaje accionable y nunca
inventa un score local.

Los nombres de modelo y precios son los del RPD §7.9 (ADR-20). Un modelo desconocido
se estima con el precio más caro de la tabla: si el tope no se supera con ese precio,
tampoco se superará con el real.

El cliente habla **la API nativa de cada proveedor** con el mismo prompt y el mismo
esquema: `anthropic` (Claude), `gemini` (Google) y `openai`. Así sirve la clave que el
operador ya tenga en la máquina (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/
`GOOGLE_API_KEY` u `OPENAI_API_KEY`) además de `OPENRANKS_LLM_API_KEY`, y el proveedor
se deduce del modelo (`claude-…`, `gemini-…`, `gpt-…`) si no se fuerza con
`OPENRANKS_LLM_PROVIDER`.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Mapping, Sequence

from .score import TITLE_MAX_CHARS, Score

# El modelo por defecto del RPD (ADR-20): Haiku 5.5, visión y salida estructurada.
DEFAULT_MODEL = "claude-haiku-5.5"
# Endpoint del proveedor por defecto. Cambiar de proveedor es cambiar la clave, el
# modelo y, si hace falta, esta URL; nunca el código (ADR-20).
DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
# Versión del prompt y del esquema: viaja en `extract.json` junto al modelo y la fecha.
# Sube a la 2 al pasar a adaptadores nativos: el texto del esquema cambió.
PROMPT_VERSION = "score-llm-4"

# Proveedores con adaptador propio. `auto` deja que se deduzca (ver `from_env`).
PROVIDER_AUTO = "auto"
PROVIDER_ANTHROPIC = "anthropic"
PROVIDER_GEMINI = "gemini"
PROVIDER_OPENAI = "openai"
PROVIDERS = (PROVIDER_ANTHROPIC, PROVIDER_GEMINI, PROVIDER_OPENAI)

# Cada proveedor tiene su dirección, su cabecera de clave y su cuerpo. El adaptador
# traduce el mismo prompt y esquema a los tres, para no atarse a ninguno (ADR-20).
PROVIDER_DEFAULT_MODEL = {
    PROVIDER_ANTHROPIC: DEFAULT_MODEL,
    PROVIDER_GEMINI: "gemini-3.8-flash",
    PROVIDER_OPENAI: "gpt-6-luna",
}
PROVIDER_DEFAULT_BASE_URL = {
    PROVIDER_ANTHROPIC: DEFAULT_BASE_URL,
    PROVIDER_GEMINI: "https://generativelanguage.googleapis.com/v1beta",
    PROVIDER_OPENAI: "https://api.openai.com/v1",
}
# Variables de entorno que traen la clave de cada proveedor. `OPENRANKS_LLM_API_KEY`
# manda; estas permiten usar la clave que ya está en la máquina sin duplicarla.
PROVIDER_KEY_VARS = {
    PROVIDER_ANTHROPIC: ("ANTHROPIC_API_KEY",),
    PROVIDER_GEMINI: ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    PROVIDER_OPENAI: ("OPENAI_API_KEY",),
}
# Prefijo del modelo → proveedor: tener `OPENRANKS_LLM_MODEL=gemini-3.8-flash` basta,
# sin declarar también el proveedor.
MODEL_PREFIXES = (
    ("claude", PROVIDER_ANTHROPIC),
    ("gemini", PROVIDER_GEMINI),
    ("gpt", PROVIDER_OPENAI),
    ("o3", PROVIDER_OPENAI),
    ("o4", PROVIDER_OPENAI),
)
ANTHROPIC_VERSION = "2023-06-01"
# Tope de coste **por trabajo** antes de llamar al LLM (RF-18.6).
MAX_COST_USD = 0.02
# p95 objetivo por trabajo (RF-18.6). Un trabajo hace una sola llamada.
TIMEOUT_S = 20.0

# Estimación conservadora de tokens (RPD §7.9): prompt + esquema, una miniatura y sus
# metadatos por clip, y la salida con score y título.
PROMPT_TOKENS = 600
IMAGE_TOKENS = 400
METADATA_TOKENS = 40
OUTPUT_TOKENS_PER_CLIP = 120

# Precios de lista por 1M de tokens (entrada, salida), consultados el 28-oct-2026.
PRICES_USD_PER_MILLION: dict[str, tuple[float, float]] = {
    "claude-haiku-5.5": (0.10, 0.50),
    "gpt-6-luna": (0.10, 0.50),
    "gemini-3.8-flash": (0.75, 3.75),
    "glm-5v-turbo": (1.20, 4.00),
    "gpt-6.1-terra": (1.00, 5.00),
}
# El más caro de la tabla: con él, un modelo desconocido nunca se queda corto.
FALLBACK_PRICE: tuple[float, float] = (1.20, 5.00)


def _clean(values: Mapping[str, str], name: str) -> str:
    """Valor de entorno sin espacios; vacío cuenta como no definido."""
    return (values.get(name) or "").strip()


def provider_for_model(model: str) -> str | None:
    """Proveedor que corresponde al nombre del modelo, si se reconoce."""
    name = (model or "").strip().lower()
    for prefix, provider in MODEL_PREFIXES:
        if name.startswith(prefix):
            return provider
    return None


def key_from_env(provider: str, values: Mapping[str, str]) -> str | None:
    """Clave del proveedor tomada de la variable estándar de su SDK o CLI."""
    for name in PROVIDER_KEY_VARS.get(provider, ()):
        value = _clean(values, name)
        if value:
            return value
    return None


def _resolve_provider(
    explicit: str, model: str, explicit_key: str, values: Mapping[str, str]
) -> str:
    """Proveedor efectivo: el forzado, el del modelo, o el de la única clave presente."""
    if explicit in PROVIDERS:
        return explicit
    guessed = provider_for_model(model)
    if guessed:
        return guessed
    keyed = [provider for provider in PROVIDERS if key_from_env(provider, values)]
    if not explicit_key and len(keyed) == 1:
        return keyed[0]
    return PROVIDER_ANTHROPIC


@dataclass(frozen=True)
class LlmSettings:
    """Cómo se habla con el proveedor; todo se puede cambiar por entorno."""

    api_key: str | None = None
    model: str = DEFAULT_MODEL
    base_url: str = DEFAULT_BASE_URL
    max_cost_usd: float = MAX_COST_USD
    timeout_s: float = TIMEOUT_S
    provider: str = PROVIDER_ANTHROPIC

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "LlmSettings":
        """Lee `OPENRANKS_LLM_*` y las claves estándar; lo inválido cae al RPD."""
        values = os.environ if env is None else env
        explicit_key = _clean(values, "OPENRANKS_LLM_API_KEY")
        model_raw = _clean(values, "OPENRANKS_LLM_MODEL")
        provider = _resolve_provider(
            _clean(values, "OPENRANKS_LLM_PROVIDER").lower(),
            model_raw,
            explicit_key,
            values,
        )
        model = model_raw or PROVIDER_DEFAULT_MODEL[provider]
        base_url = (
            _clean(values, "OPENRANKS_LLM_BASE_URL")
            or PROVIDER_DEFAULT_BASE_URL[provider]
        )
        key = explicit_key or key_from_env(provider, values)

        cap_raw = _clean(values, "OPENRANKS_LLM_MAX_COST_USD")
        cap = MAX_COST_USD
        if cap_raw:
            try:
                parsed = float(cap_raw)
            except ValueError:
                parsed = MAX_COST_USD
            if math.isfinite(parsed) and parsed > 0:
                cap = parsed

        return cls(
            api_key=key,
            model=model,
            base_url=base_url,
            max_cost_usd=cap,
            provider=provider,
        )

    @property
    def configured(self) -> bool:
        """Sin clave no se llama a nadie: no hay score."""
        return bool(self.api_key)

    @property
    def endpoint(self) -> str:
        """URL de la llamada, acepte la base del proveedor con o sin el sufijo."""
        base = self.base_url.rstrip("/")
        if self.provider == PROVIDER_GEMINI:
            if base.endswith(":generateContent"):
                return base
            model = self.model[len("models/") :] if self.model.startswith("models/") else self.model
            return f"{base}/models/{model}:generateContent"
        if self.provider == PROVIDER_ANTHROPIC:
            return base if base.endswith("/messages") else f"{base}/messages"
        return base if base.endswith("/chat/completions") else f"{base}/chat/completions"

    def headers(self) -> dict[str, str]:
        """Cabeceras de la llamada. La clave viaja en cabecera, nunca en la URL."""
        headers = {"Content-Type": "application/json"}
        if self.provider == PROVIDER_GEMINI:
            headers["x-goog-api-key"] = self.api_key or ""
        elif self.provider == PROVIDER_ANTHROPIC:
            headers["x-api-key"] = self.api_key or ""
            headers["anthropic-version"] = ANTHROPIC_VERSION
        else:
            headers["Authorization"] = f"Bearer {self.api_key or ''}"
        return headers


@dataclass(frozen=True)
class ClipFrame:
    """Un clip tal y como lo ve el LLM: metadatos y, si se pudo leer, su miniatura."""

    index: int
    start_s: float
    end_s: float
    duration_s: float
    image: bytes | None = None
    image_mime: str = "image/jpeg"


def price_for(model: str) -> tuple[float, float]:
    """Precio (entrada, salida) por 1M de tokens; desconocido ⇒ el más caro."""
    name = (model or "").strip().lower()
    if name in PRICES_USD_PER_MILLION:
        return PRICES_USD_PER_MILLION[name]
    for known, price in PRICES_USD_PER_MILLION.items():
        family = known.split("-", 1)[0]
        if family and family in name:
            return price
    return FALLBACK_PRICE


def estimate_tokens(clip_count: int) -> tuple[int, int]:
    """Tokens de entrada y salida estimados para un trabajo de `clip_count` clips."""
    count = max(0, int(clip_count))
    input_tokens = PROMPT_TOKENS + count * (IMAGE_TOKENS + METADATA_TOKENS)
    return input_tokens, count * OUTPUT_TOKENS_PER_CLIP


def estimate_cost(settings: LlmSettings, clip_count: int) -> float:
    """Coste estimado en USD antes de enviar nada (RF-18.6)."""
    input_tokens, output_tokens = estimate_tokens(clip_count)
    input_price, output_price = price_for(settings.model)
    return (input_tokens * input_price + output_tokens * output_price) / 1_000_000


def build_prompt(clips: Sequence[ClipFrame]) -> str:
    """Instrucciones para puntuar **todos** los clips en una sola respuesta comparable."""
    lines = [
        "Eres editor de vídeos cortos para un ranking vertical.",
        "Vas a puntuar los clips de este trabajo EN CONJUNTO, con el mismo criterio para todos,",
        "para que sus scores se puedan comparar entre sí. No puntúes cada uno por separado.",
        "",
        "Para cada clip mira la miniatura y los metadatos: gancho del primer fotograma,",
        "movimiento y cambios visuales, presencia de personas o caras, texto o rótulos,",
        "claridad de la imagen y duración. No tienes audio: no supongas nada sobre el sonido.",
        "Devuelve un entero de 0 a 100 (100 = el clip más llamativo del trabajo) y un",
        "título de puesto: 3-24 caracteres, en mayúsculas, en español, con gancho de ranking",
        "(un chiste corto o una referencia al clip), legible como rótulo y sin numeración,",
        "comillas, emojis ni hashtags.",
        "",
        "Clips:",
    ]
    for clip in clips:
        lines.append(
            f"- índice {clip.index}: {clip.start_s:.2f}s-{clip.end_s:.2f}s "
            f"({clip.duration_s:.2f}s)"
        )
    lines.append("")
    lines.append("Responde solo con el JSON del esquema, sin markdown ni comentarios:")
    lines.append('{"scores":[{"index":1,"value":0,"title":"TÍTULO"}]}')
    return "\n".join(lines)


# Instrucción de sistema, igual para los tres proveedores.
SYSTEM_PROMPT = (
    "Puntúas clips para un ranking y les pones títulos cortos con gancho. Eres "
    "consistente y comparativo; nunca inventas señales que no se vean en la imagen."
)

def build_messages(clips: Sequence[ClipFrame]) -> list[dict]:
    """Mensajes de chat completions (OpenAI): texto + una miniatura por clip."""
    content: list[dict] = [{"type": "text", "text": build_prompt(clips)}]
    for clip in clips:
        if not clip.image:
            continue
        encoded = _base64(clip.image)
        content.append(
            {
                "type": "text",
                "text": f"Miniatura del clip {clip.index}:",
            }
        )
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{clip.image_mime};base64,{encoded}"},
            }
        )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


def build_schema() -> dict:
    """JSON Schema estricto de la respuesta: una lista de scores por índice."""
    return {
        "name": "clip_scores",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["scores"],
            "properties": {
                "scores": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["index", "value", "title"],
                        "properties": {
                            "index": {"type": "integer"},
                            "value": {"type": "integer", "minimum": 0, "maximum": 100},
                            "title": {
                                "type": "string",
                                "minLength": 3,
                                "maxLength": TITLE_MAX_CHARS,
                            },
                        },
                    },
                }
            },
        },
    }


def _max_tokens(clip_count: int) -> int:
    """Salida máxima: el JSON con score y título de cada clip, con holgura."""
    return max(512, clip_count * OUTPUT_TOKENS_PER_CLIP + 256)


def build_openai_request(settings: LlmSettings, clips: Sequence[ClipFrame]) -> dict:
    """Chat completions con esquema estricto y la miniatura en data URL."""
    return {
        "model": settings.model,
        "messages": build_messages(clips),
        "response_format": {"type": "json_schema", "json_schema": build_schema()},
        "temperature": 0,
        "max_tokens": _max_tokens(len(clips)),
    }


def build_anthropic_request(settings: LlmSettings, clips: Sequence[ClipFrame]) -> dict:
    """Messages API de Claude: la imagen va en un bloque `image` en base64.

    Claude no acepta `response_format`: el JSON se pide en el prompt (y `parse_scores`
    tolera vallas de markdown), así que un proveedor sin esquema estricto no rompe nada.
    """
    content: list[dict] = [{"type": "text", "text": build_prompt(clips)}]
    for clip in clips:
        if not clip.image:
            continue
        content.append({"type": "text", "text": f"Miniatura del clip {clip.index}:"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": clip.image_mime,
                    "data": _base64(clip.image),
                },
            }
        )
    return {
        "model": settings.model,
        "system": SYSTEM_PROMPT,
        "max_tokens": _max_tokens(len(clips)),
        "temperature": 0,
        "messages": [{"role": "user", "content": content}],
    }


def build_gemini_request(settings: LlmSettings, clips: Sequence[ClipFrame]) -> dict:
    """`generateContent` de Gemini: `parts` con texto e `inline_data` por imagen."""
    parts: list[dict] = [{"text": build_prompt(clips)}]
    for clip in clips:
        if not clip.image:
            continue
        parts.append({"text": f"Miniatura del clip {clip.index}:"})
        parts.append(
            {
                "inline_data": {
                    "mime_type": clip.image_mime,
                    "data": _base64(clip.image),
                }
            }
        )
    return {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": _max_tokens(len(clips)),
            "responseMimeType": "application/json",
        },
    }


def build_request(settings: LlmSettings, clips: Sequence[ClipFrame]) -> dict:
    """Cuerpo de la única llamada del trabajo (mismo modelo y prompt para todos).

    El formato lo decide el proveedor: el trabajo entero viaja en **una** petición, para
    que los scores sean comparables entre sí (RF-18.3).
    """
    if settings.provider == PROVIDER_GEMINI:
        return build_gemini_request(settings, clips)
    if settings.provider == PROVIDER_ANTHROPIC:
        return build_anthropic_request(settings, clips)
    return build_openai_request(settings, clips)


def parse_scores(
    payload: object, expected: Sequence[int], *, model: str
) -> dict[int, Score]:
    """Valida la respuesta y devuelve solo los scores que se pueden usar.

    Un índice desconocido, un valor fuera de 0-100 o un JSON inválido se descartan
    **sin lanzar**: quien llama decide si el hueco es un fallo. El título se valida
    aparte: si falta o no cabe, el score sigue valiendo con título vacío y el panel
    usará el nombre del archivo como último respaldo.
    """
    data = _json_object(_content_text(payload))
    if not isinstance(data, dict):
        return {}
    entries = data.get("scores")
    if not isinstance(entries, list):
        return {}

    allowed = {int(index) for index in expected}
    scores: dict[int, Score] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        value = entry.get("value")
        if isinstance(index, bool) or not isinstance(index, int) or index not in allowed:
            continue
        if index in scores:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(float(value)) or not 0 <= float(value) <= 100:
            continue

        raw_title = entry.get("title")
        title = " ".join(raw_title.split()) if isinstance(raw_title, str) else ""
        title = title[:TITLE_MAX_CHARS].strip()
        if len(title) < 3:
            title = ""

        # La fuente (`llm`) es la de por defecto del propio `Score`: un solo sitio.
        scores[index] = Score(
            value=int(round(float(value))),
            title=title,
            model_version=model,
        )
    return scores


def _base64(payload: bytes) -> str:
    import base64

    return base64.b64encode(payload).decode("ascii")


def _content_text(payload: object) -> str:
    """Texto de la respuesta, sea de OpenAI, de Claude o de Gemini.

    Cada proveedor devuelve el mismo contenido con otra forma: `choices[].message`
    (OpenAI), `content[]` con bloques (Claude) o `candidates[].content.parts[]`
    (Gemini). Se prueban las tres para que `parse_scores` no dependa del proveedor.
    """
    if not isinstance(payload, dict):
        return ""
    for extract in (_openai_text, _gemini_text, _anthropic_text):
        text = extract(payload)
        if text:
            return text
    return ""


def _blocks_text(blocks: object) -> str:
    """Une los `text` de una lista de bloques, ignorando el resto de tipos."""
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _openai_text(payload: dict) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    return _blocks_text(content)


def _gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0]
    if not isinstance(first, dict):
        return ""
    content = first.get("content")
    if not isinstance(content, dict):
        return ""
    return _blocks_text(content.get("parts"))


def _anthropic_text(payload: dict) -> str:
    return _blocks_text(payload.get("content"))


def _json_object(text: str) -> object | None:
    """JSON de la respuesta, tolerando vallas de markdown alrededor."""
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(raw[start : end + 1])
    except (ValueError, TypeError):
        return None
