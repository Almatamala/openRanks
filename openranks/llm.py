"""Cliente HTTP del score de la galería (F3 · P3-9 y P3-12).

El divisor de escenas **no puntúa**: solo corta. Cuando el operador pulsa «Puntuar
galería», este módulo manda **una sola** petición al proveedor con la miniatura de cada
clip y el mismo modelo y prompt para todos, para que los scores sean comparables.

No hay caché ni refinamiento del análisis: el score vive en la galería, que guarda el
resultado en su índice. Sin clave no se llama a nadie; cualquier fallo se traduce en un
mensaje accionable y no se inventan scores.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .core.llm import LlmSettings


class LlmError(RuntimeError):
    """La llamada al proveedor no se pudo completar; el mensaje es para el operador."""


def post_json(settings: LlmSettings, payload: dict) -> object:
    """POST a la API nativa del proveedor con `urllib`.

    La clave va en la cabecera que espera cada uno (`x-api-key` en Claude,
    `x-goog-api-key` en Gemini, `Authorization: Bearer` en OpenAI): nunca en la URL, para
    que no acabe en un log. Los errores se traducen sin filtrar datos del proveedor.
    """
    if not settings.api_key:
        raise LlmError("sin clave configurada")
    request = urllib.request.Request(
        settings.endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=settings.headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=settings.timeout_s) as response:
            body = response.read(4_000_000)
    except urllib.error.HTTPError as exc:
        raise LlmError(_http_message(exc.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise LlmError("no se pudo conectar o la respuesta tardó demasiado") from None

    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise LlmError("la respuesta no era JSON") from None


def _http_message(status: int) -> str:
    if status in (400, 401, 403):
        return "el proveedor rechazó la clave o la petición"
    if status == 404:
        return "el proveedor no reconoce el modelo"
    if status == 429:
        return "el proveedor pidió esperar"
    if status >= 500:
        return "el proveedor falló"
    return f"respuesta HTTP {status}"
