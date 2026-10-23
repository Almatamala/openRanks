"""Análisis de encuadre sin ejecutar FFmpeg: muestreo, refino y payload JSON."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core.framing import Crop, GrayFrame
from openranks.core.media import MediaInfo
from openranks.framing import (
    analysis_size,
    frame_argv,
    refine_crop,
    sample_window,
    visible_size,
)


def _info(**overrides) -> MediaInfo:
    base = dict(
        path=Path("clip.mp4"),
        duration_s=10.0,
        width=1920,
        height=1080,
        fps=30.0,
        video_codec="h264",
        pix_fmt="yuv420p",
        audio_codec="aac",
        sample_rate=48000,
        channels=2,
        size_bytes=1000,
    )
    base.update(overrides)
    return MediaInfo(**base)  # type: ignore[arg-type]


def _full_frame(width: int, height: int, *, left: int, right: int) -> GrayFrame:
    pixels = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            if left <= x < right:
                value = 30 + ((x * 73 + y * 151 + x * y * 17) % 200)
            else:
                value = 90 + (24 * x // max(1, width - 1))
            pixels[y * width + x] = max(0, min(255, value))
    return GrayFrame(width=width, height=height, pixels=bytes(pixels))


def test_frame_sampling_avoids_the_extremes_and_uses_one_pass():
    start, span, count = sample_window(10.0)
    assert start == pytest.approx(0.2)
    assert start + span == pytest.approx(9.8)
    assert count == 12

    argv = frame_argv(
        "ffmpeg",
        Path("in.mp4"),
        width=192,
        height=108,
        count=10,
        start_s=start,
        span_s=10.0,
    )
    joined = " ".join(argv)
    assert argv[argv.index("-ss") + 1] == "0.200"
    assert argv.index("-ss") < argv.index("-i")
    assert argv.index("-t") > argv.index("-i")
    assert "fps=1.000000" in joined
    assert "scale=192:108" in joined and "format=gray" in joined
    assert argv[argv.index("-frames:v") + 1] == "10"
    assert argv[-2:] == ["rawvideo", "-"]


def test_short_clips_use_the_whole_window():
    start, span, count = sample_window(0.4)
    assert (start, span) == (0.0, 0.4)
    assert count == 6


def test_analysis_size_keeps_the_aspect_and_even_sides():
    assert analysis_size((1920, 1080)) == (192, 108)
    assert analysis_size((1080, 1920)) == (192, 340)
    assert analysis_size((100, 100)) == (100, 100)


def test_visible_size_honours_rotation():
    assert visible_size(_info()) == (1920, 1080)
    assert visible_size(_info(rotation=90, display_width=1080, display_height=1920)) == (1080, 1920)


def test_refine_crop_finds_the_full_resolution_edge():
    frame = _full_frame(640, 360, left=200, right=440)
    refined, warnings = refine_crop(Crop(w=244, h=360, x=198, y=0), [frame, frame], (640, 360))
    assert refined.x == pytest.approx(202, abs=4)
    assert refined.right == pytest.approx(438, abs=4)
    assert refined.h == 360
    assert refined.w % 2 == 0 and refined.x % 2 == 0
    assert not warnings


def test_refine_crop_keeps_the_coarse_crop_if_it_is_not_credible():
    frame = _full_frame(640, 360, left=200, right=440)
    coarse = Crop(w=244, h=360, x=198, y=0)
    refined, warnings = refine_crop(coarse, [frame], (200, 100))
    assert refined == coarse
    assert warnings
