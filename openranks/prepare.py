"""Preparación incremental: un clip del ranking se edita **cuando entra** (§12).

Normalizar un clip (encuadre automático, 1080x1920, 30 fps y audio a −14 LUFS) es la
parte cara del montaje. Hacerlo al entrar permite que el panel muestre un tick por
puesto y que, cuando están todos, la unión ya esté lista: «Montar» solo añade la
edición (L2), que es una sola generación de vídeo.

El resultado es **estable**: ``<salida>/prepared/05.mp4`` (el nombre depende solo del
puesto, no del rótulo, que se puede escribir después). Al lado se deja un JSON con lo
medido, para que la unión no tenga que volver a sondear ni a analizar el encuadre.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .core import ffmpeg as ff
from .core.config import Config
from .core.framing import FramingDecision, FramingError, fallback_decision
from .core.manifest import sha256_file, utc_now, write_manifest
from .core.media import MediaInfo, probe, validate_normalized, validate_ready_clip
from .core.plan import prepared_name
from .core.runner import run, stderr_warnings
from .framing import analyze

Logger = Callable[[str], None]


class PrepareError(RuntimeError):
    """El clip no se puede preparar (entrada inválida o normalización fallida)."""

    def __init__(self, message: str, reasons: tuple[str, ...] = ()) -> None:
        self.reasons = reasons
        detail = "" if not reasons else ": " + "; ".join(reasons)
        super().__init__(message + detail)


@dataclass
class PreparedClip:
    """Un clip ya listo: el archivo normalizado y **lo que se midió de su fuente**."""

    position: int
    source: Path
    output: Path
    info: MediaInfo
    normalized: MediaInfo
    decision: FramingDecision | None = None
    warnings: tuple[str, ...] = ()
    loudness: dict = field(default_factory=dict)

    @property
    def duration_s(self) -> float:
        """Duración que entra en el plan: la del vídeo de la fuente, no la del contenedor."""
        return self.info.usable_duration_s

    def to_manifest(self) -> dict:
        """Lo que la unión necesita saber, sin volver a tocar la fuente."""
        return {
            "position": self.position,
            "source": {
                **self.info.to_source_entry(position=self.position, sha256=sha256_file(self.source)),
                "framing": None if self.decision is None else self.decision.to_manifest(),
            },
            "clip": {
                "file": self.output.name,
                "sha256": sha256_file(self.output),
                "bytes": self.output.stat().st_size,
                "duration_s": round(self.normalized.duration_s, 3),
                "width": self.normalized.width,
                "height": self.normalized.height,
                "fps": None if self.normalized.fps is None else round(self.normalized.fps, 3),
                "pix_fmt": self.normalized.pix_fmt,
                "has_audio": self.normalized.has_audio,
            },
            "prepared_at": utc_now(),
            "warnings": list(self.warnings),
        }


def _noop(_: str) -> None:
    return None


def _measure_loudness(ffmpeg_bin: str, path: Path, cfg: Config) -> dict | None:
    """Primera pasada de ``loudnorm``: mide y no escribe salida."""
    completed = run(ff.measure_loudness_argv(ffmpeg_bin, path, cfg), check=False)
    return ff.parse_loudnorm_json(completed.stderr or "")


def prepare_clip(
    source: str | Path,
    destination: str | Path,
    *,
    position: int,
    config: Config | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    fit: str | None = None,
    limit_s: float | None = None,
    info: MediaInfo | None = None,
    decision: FramingDecision | None = None,
    log: Logger | None = None,
) -> PreparedClip:
    """Normaliza **un** clip a 1080x1920 / 30 fps / yuv420p con audio a −14 LUFS.

    ``info`` y ``decision`` permiten reaprovechar la medición y el análisis de encuadre
    que ya hizo el llamador (el ensamblador completo los necesita antes de planificar),
    y así no se paga dos veces el ``ffprobe`` ni el muestreo de FFmpeg.

    ``limit_s`` recorta la entrada (cold open). Sin él, el clip entra completo.
    """
    say = log or _noop
    cfg = config or Config.from_env()
    fit = fit or cfg.fit
    ffmpeg_bin = ff.resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = ff.resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    source = Path(source)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    if info is None:
        info = probe(ffprobe_bin, source)
        check = validate_ready_clip(info, cfg)
        if not check.ok:
            raise PrepareError(
                f"el clip del puesto #{position} no cumple el contrato de entrada",
                tuple(check.errors),
            )
        warnings.extend(check.warnings)
        for warning in check.warnings:
            say(f"  aviso #{position}: {warning}")

    if decision is None and fit == "auto":
        try:
            decision = analyze(ffmpeg_bin, source, info, config=cfg)
        except (FramingError, OSError) as exc:
            visible = (info.display_width or info.width or 0, info.display_height or info.height or 0)
            decision = fallback_decision(
                input_size=(info.width or 0, info.height or 0),
                visible_size=visible,
                rotation=info.rotation,
                reason="no se pudo analizar el encuadre",
                warning=f"no se pudo analizar el encuadre ({exc}); se rellena con negro sin recortar",
            )
        say(f"  #{position}: {decision.reason} (confianza {decision.confidence:.2f})")
        warnings.extend(f"#{position}: {warning}" for warning in decision.warnings)
        for warning in decision.warnings:
            say(f"  aviso #{position}: {warning}")

    if fit == "auto" and decision is not None:
        # `sin_cambios` solo significa que no hay crop; el clip igual se re-encodea a
        # 30 fps/yuv420p para que la unión por copia funcione.
        segment_fit = "contain" if decision.fit == "sin_cambios" else decision.fit
        crop = decision.crop
    elif fit == "auto":
        segment_fit = "contain"
        crop = None
        warnings.append(f"#{position}: no había decisión de encuadre; se rellena con negro")
    else:
        segment_fit = fit
        crop = None

    measured = None
    if info.has_audio:
        say(f"  #{position}: midiendo loudness")
        measured = _measure_loudness(ffmpeg_bin, source, cfg)

    duration_s = info.usable_duration_s if limit_s is None else float(limit_s)
    say(f"  #{position}: normalizando -> {destination.name}")
    completed = run(
        ff.normalize_argv(
            ffmpeg_bin,
            source,
            destination,
            config=cfg,
            has_audio=info.has_audio,
            fit=segment_fit,
            crop=crop,
            measured=measured,
            limit_s=limit_s,
            duration_s=duration_s,
        )
    )
    warnings.extend(stderr_warnings(completed.stderr, where=f"#{position}"))

    normalized = probe(ffprobe_bin, destination)
    check = validate_normalized(normalized, cfg)
    if not check.ok:
        raise PrepareError(
            f"el clip normalizado del puesto #{position} no cumple el formato",
            tuple(check.errors),
        )
    warnings.extend(f"#{position}: {warning}" for warning in check.warnings)

    return PreparedClip(
        position=position,
        source=source,
        output=destination,
        info=info,
        normalized=normalized,
        decision=decision,
        warnings=tuple(warnings),
        loudness=measured or {},
    )


def metadata_path(out_dir: str | Path, position: int) -> Path:
    """``<salida>/prepared/05.json``: lo medido, junto al clip preparado."""
    return Path(out_dir) / "prepared" / f"{position:02d}.json"


def write_metadata(out_dir: str | Path, clip: PreparedClip) -> Path:
    return write_manifest(metadata_path(out_dir, clip.position), clip.to_manifest())


def read_metadata(out_dir: str | Path, position: int) -> dict:
    """Lee lo medido al preparar. Falla si el clip no está preparado."""
    path = metadata_path(out_dir, position)
    if not path.is_file():
        raise PrepareError(f"el puesto #{position} no está preparado todavía")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PrepareError(f"los datos del puesto #{position} no son JSON válido") from exc
    if not isinstance(payload, dict):
        raise PrepareError(f"los datos del puesto #{position} están incompletos")
    return payload


def prepared_file(out_dir: str | Path, position: int) -> Path:
    """Ruta del clip normalizado de un puesto: ``<salida>/prepared/05.mp4``."""
    return Path(out_dir) / "prepared" / prepared_name(position)
