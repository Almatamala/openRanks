"""Análisis y segmentación en escenas (F3 · P3-3) de una fuente ya descargada o subida.

Una sola pasada de FFmpeg **sin recodificar** saca del vídeo el score de **cada** fotograma
(`scdet`), su luminancia media (`signalstats`) y los negros (`blackdetect`). Con esas tres
señales, `core.scenes` decide los cortes con un umbral **adaptativo**, ignora los destellos,
parte en los fundidos y propone tramos de 1-30 s; después se dejan las miniaturas en
`candidates/` y todo queda escrito en `extract.json`. Solo cuenta la imagen: el audio no se
analiza, así que una pausa o un silencio no mueve un corte ni crea un clip.

`extract.json` es **determinista**: mismo archivo y mismos umbrales dan exactamente el
mismo documento (sin fechas), para poder compararlo o reutilizarlo (P3-4).
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import TOOL_VERSION
from .core.manifest import sha256_file
from .core.media import MediaInfo, probe
from .core.phash import duplicates_of, phash
from .core.runner import ToolError, run, run_bytes, version_of
from .core.scenes import (
    Segment,
    Thresholds,
    adaptive_cuts,
    build_segments,
    clean_cuts,
    drop_flash_cuts,
    luma_spans,
    merge_spans,
    span_edges,
)

Logger = Callable[[str], None]

EXTRACT_FILE = "extract.json"
THUMBNAILS_DIR = "candidates"
# Por debajo de cinco tramos no se puede montar un ranking (RF-17.6).
MIN_CANDIDATES = 5
# Lado de la muestra con la que se calcula la huella perceptual: 32×32 en gris.
HASH_SIZE = 32
# Ancho al que se mira el vídeo durante la detección. Los filtros (`scdet`, `signalstats`,
# `blackdetect`) recorren todos los píxeles de cada fotograma: en 1080p son ~2 millones por
# fotograma y la pasada se lleva casi todo el tiempo del divisor. Un cambio de plano se ve
# igual de bien en 480 px de ancho, así que se mira la muestra reducida y la pasada baja de
# minutos a segundos. Nunca se amplía una fuente más pequeña que esto.
ANALYSIS_WIDTH = 480
# Tramos que se muestrean a la vez (miniatura + huella). Cada uno es un FFmpeg que abre la
# fuente y busca su fotograma; con varios a la vez, una parrilla de cien escenas deja de
# tardar minutos en tener sus miniaturas.
MAX_SAMPLERS = 8

# `metadata=mode=print` saca una cabecera con el tiempo del fotograma y, debajo, una línea
# `clave=valor` por cada clave pedida. Las líneas propias de `scdet` usan dos puntos
# (`lavfi.scd.score: 25.1`), así que no se confunden con el `=`.
_FRAME_TIME = re.compile(r"pts_time:(?P<t>-?\d+(?:\.\d+)?)")
_SCORE = re.compile(r"lavfi\.scd\.score=(?P<v>-?\d+(?:\.\d+)?)")
_LUMA = re.compile(r"lavfi\.signalstats\.YAVG=(?P<v>-?\d+(?:\.\d+)?)")
_BLACK_START = re.compile(r"black_start:\s*(?P<t>-?\d+(?:\.\d+)?)")
_BLACK_END = re.compile(r"black_end:\s*(?P<t>-?\d+(?:\.\d+)?)")


class SceneError(RuntimeError):
    """La fuente no se puede analizar (sin vídeo, sin FFmpeg o pasada fallida)."""


@dataclass(frozen=True)
class Detection:
    """Lo que dijo FFmpeg: cortes de imagen (ya decididos), negros y fundidos."""

    scene_cuts: tuple[float, ...] = ()
    black_spans: tuple[tuple[float, float], ...] = ()
    fade_spans: tuple[tuple[float, float], ...] = ()


@dataclass(frozen=True)
class SceneAnalysis:
    """El análisis completo, listo para escribir `extract.json`."""

    source: Path
    out_dir: Path
    info: MediaInfo
    source_sha256: str
    thresholds: Thresholds
    detection: Detection
    candidates: tuple[Segment, ...]
    ffmpeg_version: str
    warnings: tuple[str, ...] = ()
    # Huella perceptual del fotograma central de cada tramo, en el mismo orden.
    hashes: tuple[str | None, ...] = ()
    # Número (1..n) del plano anterior que repite cada tramo, o `None`.
    duplicates: tuple[int | None, ...] = ()

    def to_manifest(self) -> dict:
        """Documento determinista: sin fechas ni rutas del host (solo el nombre)."""
        return {
            "version": 1,
            "tool": {"name": "openRanks", "version": TOOL_VERSION},
            "source": {
                "file": self.source.name,
                "sha256": self.source_sha256,
                "bytes": self.info.size_bytes,
                "duration_s": round(self.info.usable_duration_s, 3),
                "start_time_s": round(self.info.start_time_s or 0.0, 3),
                "width": self.info.display_width or self.info.width,
                "height": self.info.display_height or self.info.height,
                "has_audio": self.info.has_audio,
            },
            "thresholds": self.thresholds.to_manifest(),
            "detection": {
                "scene_cuts": [round(value, 3) for value in self.detection.scene_cuts],
                "black_spans": [
                    [round(start, 3), round(end, 3)] for start, end in self.detection.black_spans
                ],
                "fade_spans": [
                    [round(start, 3), round(end, 3)] for start, end in self.detection.fade_spans
                ],
            },
            "candidates": [
                {
                    **segment.to_manifest(index),
                    "thumbnail": f"{THUMBNAILS_DIR}/{index:02d}.jpg",
                    "phash": self.hashes[index - 1] if index <= len(self.hashes) else None,
                    "duplicate_of": (
                        self.duplicates[index - 1] if index <= len(self.duplicates) else None
                    ),
                }
                for index, segment in enumerate(self.candidates, start=1)
            ],
            "warnings": list(self.warnings),
            "tools": {"ffmpeg": self.ffmpeg_version},
        }

    def write(self) -> Path:
        target = self.out_dir / EXTRACT_FILE
        target.write_text(
            json.dumps(self.to_manifest(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        return target


def parse_series(
    stderr: str, *, offset_s: float = 0.0
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Series ``(tiempo, score)`` y ``(tiempo, YAVG)`` del stderr (pura y tolerante).

    ``offset_s`` las lleva al origen del archivo: algunas fuentes (MPEG-TS) arrancan en un
    `start_time` distinto de cero y, sin restarlo, todos los cortes caerían tarde.
    """
    scores: list[tuple[float, float]] = []
    luma: list[tuple[float, float]] = []
    offset = max(0.0, float(offset_s or 0.0))
    current: float | None = None

    for line in str(stderr or "").splitlines():
        header = _FRAME_TIME.search(line)
        if header:
            current = max(0.0, float(header.group("t")) - offset)
            continue
        if current is None:
            continue
        match = _SCORE.search(line)
        if match:
            scores.append((current, float(match.group("v"))))
            continue
        match = _LUMA.search(line)
        if match:
            luma.append((current, float(match.group("v"))))

    return scores, luma


def parse_detection(
    stderr: str,
    duration_s: float,
    *,
    start_time_s: float = 0.0,
    thresholds: Thresholds | None = None,
) -> Detection:
    """Decide los cortes con el score, la luminancia y los negros del stderr (pura)."""
    limits = thresholds or Thresholds()
    duration = max(0.0, float(duration_s))
    offset = max(0.0, float(start_time_s or 0.0))
    scores, luma = parse_series(stderr, offset_s=offset)

    # `blackdetect` escribe las dos claves en la misma línea, así que se leen siempre las
    # dos: en la línea de apertura llegan iguales (duración 0) y solo la de cierre da un
    # final posterior al inicio.
    black_start: float | None = None
    black: list[tuple[float, float]] = []
    for line in str(stderr or "").splitlines():
        start_match = _BLACK_START.search(line)
        if start_match:
            black_start = max(0.0, float(start_match.group("t")) - offset)
        end_match = _BLACK_END.search(line)
        if end_match and black_start is not None:
            end = max(0.0, float(end_match.group("t")) - offset)
            if end > black_start + 1e-3:
                black.append((black_start, end))
                black_start = None

    # Un negro sin cierre llega hasta el final del vídeo.
    if black_start is not None and duration > black_start:
        black.append((black_start, duration))

    cuts = drop_flash_cuts(adaptive_cuts(scores, limits), limits.flash_max_s)
    return Detection(
        scene_cuts=tuple(clean_cuts(cuts, duration)),
        black_spans=tuple(sorted((start, end) for start, end in black if 0 <= start < end <= duration)),
        fade_spans=tuple(luma_spans(luma, limits)),
    )


def analysis_argv(ffmpeg: str, source: Path, thresholds: Thresholds) -> list[str]:
    """Una pasada sin recodificar y **solo** de imagen.

    `scdet` deja el score de **cada** fotograma en metadatos (el umbral se decide después),
    `signalstats` la luminancia media (fundidos) y `blackdetect` los negros. Nada de audio:
    `-an`, sin subtítulos ni datos, y sin reordenar fotogramas (`sort`/`passthrough`).

    Los filtros van sobre una muestra reducida a `ANALYSIS_WIDTH` de ancho: es lo que hace
    que la pasada tarde segundos y no minutos, sin cambiar qué es un corte (el `scdet` se
    lee igual en 480 px).
    """
    video_filter = (
        f"scale='min({ANALYSIS_WIDTH},iw)':-2,"
        f"blackdetect=d={thresholds.black_min_s}:pix_th=0.10,"
        "scdet,"
        "metadata=mode=print:key=lavfi.scd.score,"
        "signalstats,"
        "metadata=mode=print:key=lavfi.signalstats.YAVG"
    )
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-i",
        str(source),
        "-an",
        "-sn",
        "-dn",
        "-map",
        "0:v:0",
        "-vf",
        video_filter,
        "-fps_mode",
        "passthrough",
        "-f",
        "null",
        "-",
    ]


def thumbnail_argv(ffmpeg: str, source: Path, at_s: float, destination: Path) -> list[str]:
    """Miniatura de la mitad del tramo, pequeña y barata (JPEG de 480 px de ancho)."""
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0.0, at_s):.3f}",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "4",
        str(destination),
    ]


def hash_argv(ffmpeg: str, source: Path, at_s: float) -> list[str]:
    """Un fotograma de 32×32 en gris por stdout: 1.024 bytes, sin guardar nada en disco."""
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, at_s):.3f}",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-vf",
        f"scale={HASH_SIZE}:{HASH_SIZE}:flags=area,format=gray",
        "-f",
        "rawvideo",
        "-",
    ]


def sample_argv(ffmpeg: str, source: Path, at_s: float, thumbnail: Path) -> list[str]:
    """Miniatura **y** fotograma de la huella en una sola pasada: un proceso por tramo.

    El fotograma se parte con `split`: una rama se queda en la miniatura de 480 px y la otra
    en los 1.024 bytes de la huella, que salen por stdout. Antes eran dos FFmpeg por tramo
    (dos aperturas, dos búsquedas), y con decenas de escenas eso se notaba.
    """
    return [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(0.0, at_s):.3f}",
        "-i",
        str(source),
        "-filter_complex",
        (
            "[0:v]split=2[thumb][hash];"
            "[thumb]scale=480:-2[jpeg];"
            f"[hash]scale={HASH_SIZE}:{HASH_SIZE}:flags=area,format=gray[raw]"
        ),
        "-map",
        "[jpeg]",
        "-frames:v",
        "1",
        "-q:v",
        "4",
        str(thumbnail),
        "-map",
        "[raw]",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-",
    ]


def sample_at(ffmpeg_bin: str, source: Path, at_s: float, thumbnail: Path) -> str | None:
    """Deja la miniatura del tramo y devuelve la huella de su fotograma central.

    Ni la miniatura ni la huella pueden tumbar el análisis: si la pasada combinada falla se
    reintenta a la manera antigua (miniatura y después huella) y, si aun así no hay huella,
    el tramo se propone igual, sin la marca de plano repetido.
    """
    try:
        completed = run_bytes(sample_argv(ffmpeg_bin, source, at_s, thumbnail), timeout_s=300)
    except ToolError:
        completed = None
    if completed is not None and completed.returncode == 0:
        return phash(completed.stdout or b"")

    try:
        run(thumbnail_argv(ffmpeg_bin, source, at_s, thumbnail), timeout_s=300)
    except ToolError:
        return None
    return phash_at(ffmpeg_bin, source, at_s)


def phash_at(ffmpeg_bin: str, source: Path, at_s: float) -> str | None:
    """Huella del fotograma de `at_s`; `None` si FFmpeg no lo puede extraer.

    Una huella que falta no puede tumbar el análisis: el tramo se propone igual, sin la
    marca de plano repetido.
    """
    try:
        completed = run_bytes(hash_argv(ffmpeg_bin, source, at_s), timeout_s=120)
    except ToolError:
        return None
    if completed.returncode != 0:
        return None
    return phash(completed.stdout or b"")


def source_phash(
    source: str | Path,
    *,
    at_s: float | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
) -> str | None:
    """Huella perceptual de un archivo (por defecto, su fotograma central).

    La usa la galería para marcar clips repetidos con el **mismo** algoritmo que el
    divisor, sin duplicar la implementación en el panel.
    """
    from .core.ffmpeg import resolve_binary

    source_path = Path(source)
    if not source_path.is_file():
        raise SceneError("no se encontró el vídeo del que calcular la huella")
    ffmpeg_bin = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")
    info = probe(ffprobe_bin, source_path)
    when = info.usable_duration_s / 2 if at_s is None else float(at_s)
    return phash_at(ffmpeg_bin, source_path, max(0.0, when))


def _default_log(_: str) -> None:
    return None


def analyze(
    source: str | Path,
    out_dir: str | Path,
    *,
    thresholds: Thresholds | None = None,
    ffmpeg: str | None = None,
    ffprobe: str | None = None,
    log: Logger | None = None,
) -> SceneAnalysis:
    """Analiza la fuente, deja `extract.json` + miniaturas y devuelve el resultado."""
    say = log or _default_log
    limits = thresholds or Thresholds.from_env()
    source_path = Path(source)
    target = Path(out_dir)
    if not source_path.is_file():
        raise SceneError("no se encontró el vídeo que hay que analizar")

    from .core.ffmpeg import resolve_binary

    ffmpeg_bin = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    ffprobe_bin = resolve_binary(ffprobe, "OPENRANKS_FFPROBE", "ffprobe")

    info = probe(ffprobe_bin, source_path)
    if not info.video_codec:
        raise SceneError("el archivo no tiene pista de vídeo")
    duration = info.usable_duration_s
    if not math.isfinite(duration) or duration <= 0:
        raise SceneError("la duración del vídeo es desconocida o cero")

    say("Detectando cortes de escena, negros y fundidos")
    completed = run(
        analysis_argv(ffmpeg_bin, source_path, limits),
        timeout_s=3600,
        check=False,
    )
    if completed.returncode != 0:
        stderr = completed.stderr or ""
        if "No such filter" in stderr:
            raise SceneError(
                "este FFmpeg no trae `scdet`/`signalstats`; hace falta 4.3 o posterior"
            )
        raise SceneError("la pasada de análisis falló; el vídeo puede estar dañado")

    # Una escena = un clip: mandan los cortes de imagen y los bordes de un fundido. El
    # tramo oscuro entre esos bordes se descarta, así que ningún clip arranca en negro.
    detection = parse_detection(
        completed.stderr or "",
        duration,
        start_time_s=info.start_time_s or 0.0,
        thresholds=limits,
    )
    dark_spans = merge_spans([*detection.black_spans, *detection.fade_spans])
    cuts = clean_cuts([*detection.scene_cuts, *span_edges(dark_spans)], duration)
    candidates = build_segments(cuts, duration, limits, dark_spans=dark_spans)

    warnings: list[str] = []
    if len(candidates) < MIN_CANDIDATES:
        warnings.append(
            f"Solo se propusieron {len(candidates)} escenas válidas; hacen falta al menos "
            f"{MIN_CANDIDATES} para un ranking."
        )

    target.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(target / THUMBNAILS_DIR, ignore_errors=True)
    (target / THUMBNAILS_DIR).mkdir(parents=True, exist_ok=True)

    # Una miniatura y una huella por tramo, en un solo FFmpeg y varios tramos a la vez. El
    # resultado se recoge **en el orden de la parrilla**, así que `extract.json` es el mismo
    # que dejaría una pasada secuencial.
    samples = [
        (
            segment.start_s + segment.duration_s / 2,
            target / THUMBNAILS_DIR / f"{index:02d}.jpg",
        )
        for index, segment in enumerate(candidates, start=1)
    ]
    workers = max(1, min(MAX_SAMPLERS, os.cpu_count() or 1))
    say(f"Miniaturas y huellas de {len(samples)} tramos")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        # El fotograma central de cada tramo deja su huella: dos escenas que repiten el
        # mismo plano se avisan, pero no se descartan solas (el operador decide cuál se
        # queda).
        hashes = tuple(
            pool.map(lambda sample: sample_at(ffmpeg_bin, source_path, sample[0], sample[1]), samples)
        )
    duplicates = tuple(duplicates_of(hashes))
    repeated = [index for index, duplicate in enumerate(duplicates, start=1) if duplicate is not None]
    if repeated:
        warnings.append(
            "Repiten un plano ya propuesto las escenas #"
            + ", #".join(str(index) for index in repeated)
            + ": compara las dos antes de aprobarlas."
        )

    analysis = SceneAnalysis(
        source=source_path,
        out_dir=target,
        info=info,
        source_sha256=sha256_file(source_path),
        thresholds=limits,
        detection=detection,
        candidates=tuple(candidates),
        ffmpeg_version=version_of(ffmpeg_bin),
        warnings=tuple(warnings),
        hashes=hashes,
        duplicates=duplicates,
    )
    analysis.write()
    say(f"{len(candidates)} tramos propuestos")
    for warning in warnings:
        say(f"  aviso: {warning}")
    return analysis
