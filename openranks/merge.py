"""Fusión de varios clips de la galería en uno solo, en el orden que elija el operador.

Es la operación inversa al divisor de escenas: en vez de partir un archivo, se pegan de 2
a 4 clips (los que el operador haya marcado) y sale **un** MP4 con ellos en ese orden. A
diferencia de `join` —que une clips ya normalizados al marco vertical por copia de
streams— aquí las fuentes son originales sueltos, así que se recodifica con el filtro
`concat`, normalizando antes cada tramo a un lienzo y una tasa comunes:

* el lienzo es el mayor de los clips, con cada tramo encajado y centrado (barras negras
  antes que recortar imagen);
* la tasa y el formato de píxel son comunes, que es lo que exige `concat`;
* un clip sin audio entra con silencio de su misma duración, para que la pista exista en
  todo el resultado.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .core.ffmpeg import base_argv, resolve_binary
from .core.media import MediaInfo, probe
from .core.runner import run

# Mínimo del producto: una «fusión» de un solo clip no es una fusión.
MIN_CLIPS = 2
# Audio del resultado: el mismo criterio que los cortes del divisor.
SAMPLE_RATE = 48000
AUDIO_CHANNELS = 2
# Recodificar deja el resultado comparable a los cortes aprobados (`cut.py`).
VIDEO_PRESET = "veryfast"
VIDEO_CRF = "18"
# Vista previa del diálogo de fusión: **el clip unido de verdad**, pero reducido y con
# preset rápido, para verlo sin esperar una recodificación a tamaño completo.
PREVIEW_MAX_WIDTH = 640
PREVIEW_PRESET = "ultrafast"
PREVIEW_CRF = "32"
PREVIEW_AUDIO_KBPS = "96"


class MergeError(RuntimeError):
    """La fusión no puede continuar (faltan clips, no son vídeo o FFmpeg falló)."""


@dataclass(frozen=True)
class MergeResult:
    """El clip fusionado y lo que se midió de él."""

    output: Path
    inputs: tuple[Path, ...]
    info: MediaInfo

    def to_manifest(self) -> dict:
        return {
            "file": self.output.name,
            "inputs": len(self.inputs),
            "bytes": self.output.stat().st_size,
            "duration_s": round(self.info.usable_duration_s, 3),
            "width": self.info.display_width or self.info.width,
            "height": self.info.display_height or self.info.height,
            "has_audio": self.info.has_audio,
        }


def _canvas(infos: Sequence[MediaInfo], *, max_width: int | None = None) -> tuple[int, int]:
    """Lienzo común: el mayor de los clips, con lados pares (yuv420p los exige).

    Con `max_width` (la vista previa) el lienzo se encoge proporcionalmente hasta caber en
    ese ancho: el resultado se ve igual, pero cuesta una fracción de la codificación.
    """
    widths = [info.display_width or info.width or 0 for info in infos]
    heights = [info.display_height or info.height or 0 for info in infos]
    width = max(2, max(widths))
    height = max(2, max(heights))
    if max_width and width > max_width:
        factor = max_width / width
        width = max(2, int(round(width * factor)))
        height = max(2, int(round(height * factor)))
    return max(2, width - width % 2), max(2, height - height % 2)


def _rate(infos: Sequence[MediaInfo]) -> float:
    """Tasa de fotogramas del resultado: la mayor de los clips (30 si no se sabe)."""
    rates = [
        rate
        for rate in (info.nominal_fps or info.fps for info in infos)
        if rate is not None and rate > 0
    ]
    return round(max(rates), 3) if rates else 30.0


def merge_filter(infos: Sequence[MediaInfo], *, width: int, height: int, rate: float) -> str:
    """Grafo `filter_complex`: cada clip al lienzo común y todos pegados con `concat`."""
    parts: list[str] = []
    for index, info in enumerate(infos):
        parts.append(
            f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps={rate},format=yuv420p,setpts=PTS-STARTPTS[v{index}]"
        )
        if info.has_audio:
            parts.append(
                f"[{index}:a]aresample={SAMPLE_RATE},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )
        else:
            # Sin pista de audio: silencio del largo del tramo, para que `concat` tenga
            # un audio por segmento y el resultado lleve audio en todo su recorrido.
            parts.append(
                f"anullsrc=r={SAMPLE_RATE}:cl=stereo,"
                f"atrim=duration={info.usable_duration_s:.3f},"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )
    joins = "".join(f"[v{index}][a{index}]" for index in range(len(infos)))
    parts.append(f"{joins}concat=n={len(infos)}:v=1:a=1[v][a]")
    return ";".join(parts)


def merge_argv(
    ffmpeg: str,
    inputs: Sequence[Path],
    destination: Path,
    infos: Sequence[MediaInfo],
    *,
    preview: bool = False,
) -> list[str]:
    """Comando de la fusión: un archivo de salida, sin metadatos de las fuentes."""
    width, height = _canvas(infos, max_width=PREVIEW_MAX_WIDTH if preview else None)
    argv = base_argv(ffmpeg, loglevel="error")
    for path in inputs:
        argv += ["-i", str(path)]
    argv += ["-filter_complex", merge_filter(infos, width=width, height=height, rate=_rate(infos))]
    argv += ["-map", "[v]", "-map", "[a]"]
    argv += [
        "-c:v",
        "libx264",
        "-preset",
        PREVIEW_PRESET if preview else VIDEO_PRESET,
        "-crf",
        PREVIEW_CRF if preview else VIDEO_CRF,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        PREVIEW_AUDIO_KBPS + "k" if preview else "192k",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        str(AUDIO_CHANNELS),
        "-movflags",
        "+faststart",
        # Ni rutas ni metadatos de las fuentes en el clip fusionado.
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        str(destination),
    ]
    return argv


def merge_clips(
    sources: Sequence[str | Path],
    destination: str | Path,
    *,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    preview: bool = False,
) -> MergeResult:
    """Pega los clips de `sources` en `destination`, en el orden recibido.

    Con `preview` el archivo sale reducido y con preset rápido: es la vista previa del
    diálogo, no el clip que entra en la galería.
    """
    inputs = tuple(Path(source) for source in sources)
    if len(inputs) < MIN_CLIPS:
        raise MergeError(f"hacen falta al menos {MIN_CLIPS} clips para fusionarlos")
    missing = [path.name for path in inputs if not path.is_file()]
    if missing:
        raise MergeError(f"no se encontraron los clips: {', '.join(missing)}")

    ffmpeg_bin = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    infos = [probe(ffprobe_bin, path) for path in inputs]
    silent_video = [path.name for path, info in zip(inputs, infos) if not info.video_codec]
    if silent_video:
        raise MergeError(f"no son vídeo: {', '.join(silent_video)}")
    empty = [path.name for path, info in zip(inputs, infos) if info.usable_duration_s <= 0]
    if empty:
        raise MergeError(f"no tienen duración válida: {', '.join(empty)}")

    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    run(merge_argv(ffmpeg_bin, inputs, target, infos, preview=preview), timeout_s=3600)
    if not target.is_file():
        raise MergeError("FFmpeg no dejó el clip fusionado")

    info = probe(ffprobe_bin, target)
    if not info.has_audio:
        raise MergeError("el clip fusionado salió sin audio")
    return MergeResult(output=target, inputs=inputs, info=info)
