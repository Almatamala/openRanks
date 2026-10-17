"""Construcción de comandos FFmpeg.

Este módulo **no ejecuta nada**: devuelve ``argv`` para que el núcleo de decisiones
se pueda testear sin FFmpeg instalado (§7.6 del plan).
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

from .config import Config

# Alto de la **banda** del encuadre por defecto: cuántos píxeles del marco vertical
# puede ocupar el clip. 1184/1920 = 61,7 %, el encuadre de referencia del operador
# (agrandar y recortar laterales, nunca arriba/abajo).
BAND_HEIGHT = 1184

class ToolNotFound(RuntimeError):
    """No se pudo localizar ffmpeg/ffprobe."""


def resolve_binary(explicit: str | None, env_var: str, name: str) -> str:
    """Resuelve un binario: explícito → variable de entorno → PATH.

    Orden pensado para que el despliegue use el binario de la imagen y el
    desarrollo el estático local, sin tocar el código.
    """
    for candidate in (explicit, os.environ.get(env_var)):
        if candidate:
            path = Path(candidate)
            if path.is_file():
                return str(path)
            raise ToolNotFound(f"{env_var}/{name}: no existe el binario indicado ({candidate})")
    found = shutil.which(name)
    if found:
        return found
    raise ToolNotFound(
        f"no se encontró `{name}`. Instálalo en el PATH, define {env_var}, "
        f"o en desarrollo: `pip install static-ffmpeg` y `python -c \"import static_ffmpeg; static_ffmpeg.add_paths()\"`"
    )


def video_filter(config: Config, fit: str = "band") -> str:
    """Cadena de vídeo para llevar cualquier fuente al marco vertical.

    ``band`` (por defecto) agranda el clip hasta llenar una **banda central** de
    ``width`` x ``BAND_HEIGHT`` (el ~62 % del alto): recorta **los laterales** si hace
    falta y **nunca** arriba o abajo, así que un clip apaisado se ve grande y centrado
    en vez de pequeño. El resto del marco va en negro.

    ``contain`` encaja el clip entero sin recortar nada (un clip apaisado queda con
    barras negras y se ve pequeño) y ``cover`` recorta para llenar los 1080x1920
    enteros (se pierde buena parte del encuadre original).
    """
    width, height = config.total
    band = max(2, min(height, int(BAND_HEIGHT)))
    if fit == "cover":
        base = f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
    elif fit == "contain":
        base = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    elif fit == "band":
        # Se escala por el lado que más agrande: llenar el ancho o llenar la banda.
        # ``iw``/``ih`` son los de la fuente, así que vale para cualquier tamaño de
        # entrada sin tener que leerlo antes. Los lados impares se redondean a par.
        grow = f"max({width}/iw\\,{band}/ih)"
        base = (
            f"scale=w='trunc(iw*{grow}/2)*2':h='trunc(ih*{grow}/2)*2':flags=bicubic,"
            # El ancho sobrante se recorta (centrado); el alto nunca se recorta.
            f"crop=w='min(iw\\,{width})':h='min(ih\\,{height})':x='(iw-ow)/2':y='(ih-oh)/2',"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )
    else:
        raise ValueError(f"fit desconocido: {fit!r} (usa 'band', 'contain' o 'cover')")
    # setsar=1 es obligatorio para que la unión por copia de streams no falle.
    return f"{base},setsar=1,fps={config.fps},format={config.pix_fmt}"


def loudnorm_filter(config: Config, measured: dict | None = None) -> str:
    """Filtro ``loudnorm`` a −14 LUFS.

    Con ``measured`` (segunda pasada) aplica ganancia lineal usando los valores
    medidos: así el resultado cae en el objetivo sin bombeo.
    """
    parts = [f"I={config.loudness_lufs}", f"TP={config.true_peak_db}", f"LRA={config.loudness_range}"]
    if measured:
        parts += [
            f"measured_I={measured['input_i']}",
            f"measured_TP={measured['input_tp']}",
            f"measured_LRA={measured['input_lra']}",
            f"measured_thresh={measured['input_thresh']}",
            f"offset={measured['target_offset']}",
            "linear=true",
        ]
    return "loudnorm=" + ":".join(parts)


def measure_loudness_argv(ffmpeg: str, src: Path, config: Config) -> list[str]:
    """Primera pasada de ``loudnorm``: mide y no escribe salida."""
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-i",
        str(src),
        "-map",
        "0:a:0",
        "-af",
        f"{loudnorm_filter(config)}:print_format=json",
        "-f",
        "null",
        "-",
    ]


_LOUDNORM_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.DOTALL)


def parse_loudnorm_json(stderr: str) -> dict | None:
    """Extrae el bloque JSON de la primera pasada del stderr de FFmpeg."""
    matches = _LOUDNORM_JSON.findall(stderr or "")
    if not matches:
        return None
    try:
        payload = json.loads(matches[-1])
    except json.JSONDecodeError:
        return None
    # Un audio mudo puede devolver "-inf": no sirve para la segunda pasada.
    if str(payload.get("input_i", "")).strip() in {"", "-inf", "inf", "nan"}:
        return None
    return payload


def normalize_argv(
    ffmpeg: str,
    src: Path,
    dst: Path,
    *,
    config: Config,
    has_audio: bool,
    fit: str = "band",
    measured: dict | None = None,
    limit_s: float | None = None,
    duration_s: float | None = None,
) -> list[str]:
    """Comando que convierte un clip de entrada en un clip "ya listo" de L1.

    ``limit_s`` corta la **entrada** (cold open: los primeros N segundos del #1, sin
    decodificar el resto). ``duration_s`` acota la **salida**: `loudnorm` y el AAC dejan
    cola de audio, y sin acotar el tramo el contenedor crecía ~100 ms por clip, el
    "fotograma congelado" se colaba en cada corte y la unión no cuadraba con la suma.
    """
    argv = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "warning", "-y"]
    if limit_s is not None:
        argv += ["-t", f"{limit_s:.3f}"]
    argv += ["-i", str(src)]
    if not has_audio:
        # Sin audio no se puede unir por copia: se inyecta silencio del largo del vídeo.
        argv += ["-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate={config.sample_rate}"]

    argv += ["-map", "0:v:0", "-map", "1:a:0" if not has_audio else "0:a:0"]
    argv += ["-vf", video_filter(config, fit)]
    if has_audio:
        argv += ["-af", loudnorm_filter(config, measured)]
    argv += [
        "-c:v",
        config.video_codec,
        "-preset",
        config.preset,
        "-crf",
        str(config.crf),
        "-pix_fmt",
        config.pix_fmt,
        "-profile:v",
        "high",
        # Mismo timescale en todos los segmentos: requisito de la unión por copia.
        "-video_track_timescale",
        "30000",
        "-c:a",
        config.audio_codec,
        "-b:a",
        config.audio_bitrate,
        "-ar",
        str(config.sample_rate),
        "-ac",
        str(config.channels),
        # Equivalente a METADATA_SCRUB: ni rutas ni metadatos de origen a la salida.
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
    ]
    if not has_audio and duration_s is None and limit_s is None:
        # Sin acotar, el silencio inyectado es infinito: hay que cortarlo en algún sitio.
        argv += ["-shortest"]
    if duration_s is not None:
        argv += ["-t", f"{duration_s:.3f}"]
    argv += [str(dst)]
    return argv


def escape_concat_path(path: Path) -> str:
    """Ruta para el demuxer ``concat``: comillas simples con ``'`` escapada."""
    text = Path(path).resolve().as_posix()
    return "'" + text.replace("'", "'\\''") + "'"


def concat_list_text(paths: list[Path]) -> str:
    return "".join(f"file {escape_concat_path(path)}\n" for path in paths)


def concat_copy_argv(ffmpeg: str, list_file: Path, dst: Path) -> list[str]:
    """Unión sin recodificar: los segmentos ya comparten formato exacto."""
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-y",
        str(dst),
    ]
