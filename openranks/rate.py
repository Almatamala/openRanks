"""Score con LLM de clips completos de la galería (F3 · P3-9 y P3-12).

El divisor de escenas y la puntuación son **procesos separados**: `analyze` solo corta y
la galería es el único sitio donde se puntúa. Este módulo toma clips ya cortados, saca la
miniatura del centro de cada uno y manda **una sola** petición con todas, para que los
scores sean comparables. Devuelve score 0-100 y un título corto para el puesto; no hay
razones ni respaldo heurístico.

Sin clave no se puntúa y el operador ve dónde configurarla. Un archivo ilegible no tumba
la tanda: el resto sigue y el fallo queda por clip. Nada de esto escribe en la galería.
"""

from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from .core.ffmpeg import ToolNotFound, resolve_binary
from .core.llm import ClipFrame, LlmSettings, build_request, estimate_cost, parse_scores
from .core.media import probe
from .core.runner import ToolError
from .llm import LlmError, post_json
from .scenes import sample_at

Logger = Callable[[str], None]


class RateError(RuntimeError):
    """La tanda no se puede puntuar (sin clave, sin FFmpeg o proveedor caído)."""


@dataclass(frozen=True)
class RatedClip:
    """Score de un clip completo, listo para el panel o para un error legible."""

    file: str
    duration_s: float | None = None
    score: int | None = None
    title: str = ""
    source: str | None = None
    model_version: str | None = None
    error: str | None = None

    def to_json(self, index: int) -> dict:
        """Contrato del panel: índice de la tanda, nombre sin rutas y score o error."""
        document: dict = {"index": int(index), "file": self.file}
        if self.error is not None:
            document["error"] = self.error
            return document
        document.update(
            {
                "duration_s": round(float(self.duration_s or 0.0), 3),
                "score": int(self.score or 0),
                "title": self.title,
                "source": self.source,
                "model_version": self.model_version,
            }
        )
        return document


def rate_many(
    sources: Iterable[str | Path],
    *,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    settings: LlmSettings | None = None,
    log: Logger | None = None,
) -> list[RatedClip]:
    """Puntúa la tanda con el LLM, en una sola llamada, en el orden de entrada."""
    paths = [Path(source) for source in sources]
    say = log or (lambda _: None)
    config = settings or LlmSettings.from_env()

    if not config.configured:
        raise RateError("Sin clave de IA: guárdala en Ajustes para puntuar la galería.")

    try:
        ffmpeg_bin = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
        ffprobe_bin = resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")
    except ToolNotFound as exc:
        raise RateError(str(exc)) from None

    results: dict[int, RatedClip] = {}
    frames: list[ClipFrame] = []

    with tempfile.TemporaryDirectory(prefix="openranks-rate-") as temporary:
        for position, path in enumerate(paths, start=1):
            try:
                if not path.is_file():
                    raise RateError("el archivo ya no está en la galería")
                info = probe(ffprobe_bin, path)
                if not info.video_codec:
                    raise RateError("el archivo no tiene pista de vídeo")
                duration = float(info.usable_duration_s or 0.0)
                if not math.isfinite(duration) or duration <= 0:
                    raise RateError("la duración del vídeo es desconocida o cero")

                thumbnail = Path(temporary) / f"{position:02d}.jpg"
                sample_at(ffmpeg_bin, path, duration / 2.0, thumbnail)
                image = thumbnail.read_bytes() if thumbnail.is_file() else None
            except (RateError, ToolError, ToolNotFound, OSError) as exc:
                say(f"No se pudo preparar {path.name}: {exc}")
                results[position] = RatedClip(
                    file=path.name, error=str(exc) or "no se pudo preparar el clip"
                )
                continue

            frames.append(
                ClipFrame(
                    index=position,
                    start_s=0.0,
                    end_s=duration,
                    duration_s=duration,
                    image=image,
                )
            )
            results[position] = RatedClip(file=path.name, duration_s=duration)

    if not frames:
        return [results[index] for index in range(1, len(paths) + 1)]

    estimated = estimate_cost(config, len(frames))
    if estimated > config.max_cost_usd + 1e-12:
        raise RateError(
            f"Puntuar {len(frames)} clips costaría unos {estimated:.4f} USD y supera el "
            f"tope de {config.max_cost_usd:g} USD por trabajo."
        )

    say(f"Puntuando {len(frames)} clips con {config.model}")
    try:
        payload = post_json(config, build_request(config, frames))
    except LlmError as exc:
        raise RateError(f"No se pudo puntuar la galería con el LLM ({exc}).") from None

    parsed = parse_scores(payload, [frame.index for frame in frames], model=config.model)
    for frame in frames:
        score = parsed.get(frame.index)
        current = results[frame.index]
        if score is None:
            results[frame.index] = RatedClip(
                file=current.file,
                duration_s=current.duration_s,
                error="el LLM no devolvió un score válido para este clip",
            )
            continue
        results[frame.index] = RatedClip(
            file=current.file,
            duration_s=current.duration_s,
            score=score.value,
            title=score.title,
            source=score.source,
            model_version=score.model_version,
        )

    return [results[index] for index in range(1, len(paths) + 1)]
