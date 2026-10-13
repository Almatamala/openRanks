"""Fixtures de test: localización de FFmpeg, clips sintéticos y bindings.

Los tests de integración se saltan si no hay ffmpeg/ffprobe, de modo que la suite
del núcleo (sin FFmpeg, sin red) corre en cualquier sitio.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

# Tamaños con lado corto >= 240 (el mínimo que exige la validación de entrada),
# cubriendo horizontal, vertical y cuadrado.
CLIP_SPECS = (
    ("clip-1.mp4", (320, 240), 440),
    ("clip-2.mp4", (240, 320), 330),
    ("clip-3.mp4", (320, 320), None),  # sin audio: prueba la inyección de silencio
    ("clip-4.mp4", (640, 360), 550),
    ("clip-5.mp4", (480, 480), 660),
)

DEFAULT_LABELS = ("GATO VOLADOR", "PERRO CAOS", "SORPRESA", "ROBO", "TERNERA")


def _resolve(name: str, env_var: str) -> str | None:
    explicit = os.environ.get(env_var)
    if explicit and Path(explicit).is_file():
        return explicit
    found = shutil.which(name)
    if found:
        return found
    try:  # dependencia solo de desarrollo
        import static_ffmpeg

        static_ffmpeg.add_paths()
    except Exception:  # pragma: no cover - entorno sin la dependencia
        return None
    return shutil.which(name)


@pytest.fixture(scope="session")
def ffmpeg_bin() -> str:
    binary = _resolve("ffmpeg", "OPENRANKS_FFMPEG")
    if not binary:
        pytest.skip("ffmpeg no disponible (integración)")
    return binary


@pytest.fixture(scope="session")
def ffprobe_bin() -> str:
    binary = _resolve("ffprobe", "OPENRANKS_FFPROBE")
    if not binary:
        pytest.skip("ffprobe no disponible (integración)")
    return binary


@pytest.fixture()
def make_clip(ffmpeg_bin, tmp_path):
    """Crea un clip sintético del tamaño y duración pedidos."""

    def _make(name: str, *, size: tuple[int, int], seconds: float = 2.0, freq: int | None = 440) -> Path:
        path = tmp_path / name
        argv = [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size[0]}x{size[1]}:rate=30",
        ]
        if freq is not None:
            argv += ["-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100", "-map", "0:v:0", "-map", "1:a:0"]
        else:
            argv += ["-an"]
        argv += ["-t", f"{seconds}", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-pix_fmt", "yuv420p"]
        if freq is not None:
            argv += ["-c:a", "aac", "-b:a", "64k"]
        argv += [str(path)]
        subprocess.run(argv, check=True, capture_output=True)
        return path

    return _make


@pytest.fixture()
def synthetic_clips(make_clip, tmp_path) -> list[Path]:
    """Cinco clips: horizontal, vertical, cuadrado sin audio, ancho y grande."""
    return [make_clip(name, size=size, freq=freq) for name, size, freq in CLIP_SPECS]


@pytest.fixture()
def write_binding(tmp_path):
    """Escribe un binding JSON y devuelve su ruta."""

    def _write(clips: list[Path], *, title: str = "TOP 5 PRUEBAS", labels=None, filename: str = "binding.json") -> Path:
        entries = []
        for index, clip in enumerate(clips, start=1):
            label = (labels or DEFAULT_LABELS)[index - 1]
            entries.append({"position": index, "path": str(clip), "label": label})
        payload = {"title": title, "items": entries}
        path = tmp_path / filename
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    return _write
