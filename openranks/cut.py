"""Recorte de un tramo aprobado del temporal (F3 · P3-4).

El análisis propone tramos; el operador aprueba. Aquí se materializa **solo ese tramo**
desde la fuente, sin tocar el resto: se recodifica el trozo aprobado (corto, ≤30 s) para
que el corte sea exacto y el clip entre en la galería como cualquier otro.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .core.ffmpeg import base_argv, resolve_binary
from .core.media import MediaInfo, probe
from .core.runner import run


class CutError(RuntimeError):
    """El tramo no se puede recortar (rango inválido o fallo de FFmpeg)."""


@dataclass(frozen=True)
class CutClip:
    source: Path
    output: Path
    start_s: float
    end_s: float
    info: MediaInfo

    @property
    def duration_s(self) -> float:
        return self.info.usable_duration_s

    def to_manifest(self) -> dict:
        return {
            "file": self.output.name,
            "start_s": round(self.start_s, 3),
            "end_s": round(self.end_s, 3),
            "duration_s": round(self.duration_s, 3),
            "bytes": self.output.stat().st_size,
            "has_audio": self.info.has_audio,
        }


def cut_argv(
    ffmpeg: str,
    source: Path,
    destination: Path,
    start_s: float,
    end_s: float,
    *,
    has_audio: bool,
) -> list[str]:
    """Argumentos del recorte: entrada precisa (`-ss` antes de `-i`) y re-codificado."""
    length = max(0.0, end_s - start_s)
    argv = [
        *base_argv(ffmpeg, loglevel="error"),
        "-ss",
        f"{start_s:.3f}",
        "-i",
        str(source),
        "-t",
        f"{length:.3f}",
        "-map",
        "0:v:0",
    ]
    if has_audio:
        argv += ["-map", "0:a:0"]
    argv += [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
    ]
    if has_audio:
        argv += ["-c:a", "aac", "-b:a", "192k"]
    argv += [
        "-movflags",
        "+faststart",
        # Ni metadatos ni rutas de la fuente en el clip aprobado. `+bitexact` evita la
        # hora de creación: dos cortes del mismo tramo dan el mismo SHA-256 y la galería
        # no duplica al reintentar.
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        str(destination),
    ]
    return argv


def cut_clip(
    source: str | Path,
    destination: str | Path,
    start_s: float,
    end_s: float,
    *,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
) -> CutClip:
    """Recorta `[start_s, end_s)` de la fuente y devuelve lo medido del clip."""
    source_path = Path(source)
    target = Path(destination)
    if not source_path.is_file():
        raise CutError("no se encontró el vídeo del que recortar el tramo")
    try:
        start = float(start_s)
        end = float(end_s)
    except (TypeError, ValueError) as exc:
        raise CutError("el tramo no tiene tiempos válidos") from exc
    if start < 0 or end <= start:
        raise CutError("el tramo empieza y acaba en un orden imposible")

    ffmpeg_bin = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    info = probe(ffprobe_bin, source_path)
    if not info.video_codec:
        raise CutError("la fuente no tiene pista de vídeo")
    if start >= info.usable_duration_s:
        raise CutError("el tramo empieza después del final del vídeo")
    end = min(end, info.usable_duration_s)

    target.parent.mkdir(parents=True, exist_ok=True)
    run(cut_argv(ffmpeg_bin, source_path, target, start, end, has_audio=info.has_audio))
    if not target.is_file():
        raise CutError("FFmpeg no dejó el clip del tramo")

    return CutClip(
        source=source_path,
        output=target,
        start_s=start,
        end_s=end,
        info=probe(ffprobe_bin, target),
    )
