"""Integración real del encuadre: fondo borroso + clip vertical nítido.

Se salta si no hay FFmpeg/ffprobe, como el resto de la suite de integración.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from openranks.cli import main
from openranks.core import ffmpeg as ff
from openranks.core.config import Config
from openranks.core.media import probe
from openranks.framing import analyze

pytestmark = pytest.mark.integration


def _make_pillarbox(ffmpeg_bin: str, path: Path) -> Path:
    """640x360 con un clip vertical nítido de 200x360 centrado y fondo desenfocado."""
    argv = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=200x360:rate=30",
        "-filter_complex",
        "[0:v]boxblur=30:3[bg];[1:v]scale=200:360[fg];[bg][fg]overlay=220:0:shortest=1[out]",
        "-map",
        "[out]",
        "-t",
        "2",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        str(path),
    ]
    subprocess.run(argv, check=True, capture_output=True)
    return path


def _fast() -> Config:
    return Config(target_width=180, target_height=320, crf=32, preset="ultrafast")


def test_detects_the_useful_area_and_normalizes_it(ffmpeg_bin, ffprobe_bin, tmp_path):
    source = _make_pillarbox(ffmpeg_bin, tmp_path / "pillarbox.mp4")
    info = probe(ffprobe_bin, source)
    config = _fast()

    decision = analyze(ffmpeg_bin, source, info, config=config)
    assert decision.classification == "A"
    assert decision.crop is not None
    # El bloque nítido está en x=220..420; el refino no debe irse más de unos píxeles.
    assert decision.crop.x == pytest.approx(220, abs=8)
    assert decision.crop.w == pytest.approx(200, abs=10)
    assert decision.crop.y == 0
    assert decision.crop.h == 360
    assert decision.confidence >= 0.60

    destination = tmp_path / "out.mp4"
    argv = ff.normalize_argv(
        ffmpeg_bin,
        source,
        destination,
        config=config,
        has_audio=info.has_audio,
        fit="contain",
        crop=decision.crop,
    )
    subprocess.run(argv, check=True, capture_output=True)
    normalized = probe(ffprobe_bin, destination)
    assert (normalized.width, normalized.height) == (180, 320)
    assert normalized.pix_fmt == "yuv420p"
    assert normalized.has_audio


def test_the_fit_command_prints_json_and_the_detected_crop(ffmpeg_bin, ffprobe_bin, tmp_path, capsys):
    source = _make_pillarbox(ffmpeg_bin, tmp_path / "cli-pillarbox.mp4")
    code = main(["fit", str(source), "--ffmpeg", ffmpeg_bin, "--ffprobe", ffprobe_bin])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["clasificacion"] == "A"
    assert payload["crop"]["w"] > 0 and payload["crop"]["x"] > 0
    assert payload["comando_ffmpeg"] and "crop=" in payload["comando_ffmpeg"]


def test_a_vertical_clip_is_not_analyzed_or_cropped(ffmpeg_bin, ffprobe_bin, make_clip):
    config = _fast()
    source = make_clip("vertical.mp4", size=(180, 320), freq=None)
    info = probe(ffprobe_bin, source)
    decision = analyze(ffmpeg_bin, source, info, config=config)
    assert decision.classification == "B"
    assert decision.crop is None
    assert decision.fit == "sin_cambios"


def test_a_rotated_clip_uses_the_visible_size_and_drops_the_rotation(
    ffmpeg_bin, ffprobe_bin, make_clip, tmp_path
):
    base = make_clip("base.mp4", size=(320, 240))
    rotated = tmp_path / "rotated.mp4"
    # `-display_rotation` es una opción de entrada: deja la matriz de visualización.
    subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(rotated)],
        check=True,
        capture_output=True,
    )
    info = probe(ffprobe_bin, rotated)
    assert info.rotation in (90, 270)
    assert info.visible_size == (240, 320)

    config = _fast()
    decision = analyze(ffmpeg_bin, rotated, info, config=config)
    assert decision.classification == "B"
    assert decision.crop is None

    destination = tmp_path / "rotated-out.mp4"
    argv = ff.normalize_argv(
        ffmpeg_bin,
        rotated,
        destination,
        config=config,
        has_audio=info.has_audio,
        fit="contain",
        crop=None,
    )
    subprocess.run(argv, check=True, capture_output=True)
    normalized = probe(ffprobe_bin, destination)
    assert (normalized.width, normalized.height) == (180, 320)
    assert normalized.rotation == 0
