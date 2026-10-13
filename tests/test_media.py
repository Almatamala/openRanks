"""Parseo de ffprobe y validaciones de formato, sin ejecutar FFmpeg."""

from __future__ import annotations

from pathlib import Path

from openranks.core.config import Config
from openranks.core.media import MediaInfo, parse_probe, validate_normalized, validate_ready_clip

VIDEO_AND_AUDIO = {
    "format": {"duration": "7.500000", "size": "1234567"},
    "streams": [
        {
            "codec_type": "video",
            "codec_name": "h264",
            "width": 1920,
            "height": 1080,
            "pix_fmt": "yuv420p",
            "avg_frame_rate": "30000/1001",
            "r_frame_rate": "30/1",
            "duration": "7.300000",
            "nb_frames": "219",
        },
        {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2},
    ],
}

VIDEO_ONLY = {
    "format": {"duration": "3.0"},
    "streams": [{"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "pix_fmt": "yuv420p", "r_frame_rate": "30/1"}],
}

NO_VIDEO = {"format": {"duration": "2.0"}, "streams": [{"codec_type": "audio", "codec_name": "mp3"}]}


def test_parse_probe_reads_video_and_audio():
    info = parse_probe(Path("a.mp4"), VIDEO_AND_AUDIO)
    assert info.duration_s == 7.5
    assert (info.width, info.height) == (1920, 1080)
    assert info.fps is not None and abs(info.fps - 29.97) < 0.01
    assert info.has_audio
    assert info.size_bytes == 1234567
    # Duración declarada del vídeo y tasa nominal: la que manda para fotogramas y cortes.
    assert info.video_duration_s == 7.3
    assert info.nominal_fps == 30.0
    assert info.nb_frames == 219
    assert info.usable_duration_s == 7.3


def test_usable_duration_falls_back_to_the_container():
    info = parse_probe(Path("b.mp4"), {"format": {"duration": "5.0"}, "streams": [{"codec_type": "video", "codec_name": "h264"}]})
    assert info.video_duration_s is None
    assert info.usable_duration_s == 5.0


def test_parse_probe_without_audio():
    info = parse_probe(Path("b.mp4"), VIDEO_ONLY)
    assert info.has_audio is False
    assert info.audio_codec is None
    assert info.fps == 30.0


def test_parse_probe_without_video_has_no_short_side():
    info = parse_probe(Path("c.mp4"), NO_VIDEO)
    assert info.video_codec is None
    assert info.short_side == 0


def test_parse_probe_missing_duration_is_zero():
    info = parse_probe(Path("d.mp4"), {"format": {}, "streams": []})
    assert info.duration_s == 0.0


def _info(**overrides) -> MediaInfo:
    base = dict(
        path=Path("clip.mp4"),
        duration_s=6.0,
        width=1080,
        height=1920,
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


def test_ready_clip_accepts_a_normal_clip():
    assert validate_ready_clip(_info(), Config()).ok


def test_ready_clip_rejects_too_short_and_too_long():
    assert not validate_ready_clip(_info(duration_s=0.5), Config()).ok
    assert not validate_ready_clip(_info(duration_s=45.0), Config()).ok


def test_ready_clip_rejects_tiny_short_side():
    check = validate_ready_clip(_info(width=100, height=200), Config())
    assert not check.ok
    assert "lado corto" in check.errors[0]


def test_ready_clip_warns_but_accepts_missing_audio():
    check = validate_ready_clip(_info(audio_codec=None, sample_rate=None, channels=None), Config())
    assert check.ok
    assert any("silencio" in warning for warning in check.warnings)


def test_normalized_requires_exact_output_format():
    assert validate_normalized(_info(), Config()).ok
    assert not validate_normalized(_info(width=1080, height=1080), Config()).ok
    assert not validate_normalized(_info(fps=25.0), Config()).ok
    assert not validate_normalized(_info(pix_fmt="yuv444p"), Config()).ok
    assert not validate_normalized(_info(audio_codec=None), Config()).ok


def test_normalized_uses_the_declared_rate_and_warns_about_drift():
    # Un contenedor con padding (o VFR) desvía la media pero la tasa declarada sigue siendo 30.
    drifted = _info(fps=29.0, nominal_fps=30.0)
    check = validate_normalized(drifted, Config())
    assert check.ok
    assert any("se desvía" in warning for warning in check.warnings)

    # Si la tasa declarada no es la del contrato, sí es un error.
    assert not validate_normalized(_info(nominal_fps=25.0, fps=25.0), Config()).ok


def test_source_entry_carries_no_absolute_path():
    entry = _info().to_source_entry(position=3, sha256="abc")
    assert entry["file"] == "clip.mp4"
    assert "/" not in entry["file"] and "\\" not in entry["file"]
