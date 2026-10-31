"""Recorte de un tramo aprobado (P3-4): solo el trozo que entra en la galería."""

from __future__ import annotations

from pathlib import Path

from openranks.cut import CutError, cut_clip


def test_cut_extracts_only_the_approved_segment(make_clip, tmp_path, ffmpeg_bin, ffprobe_bin):
    source = make_clip("source.mp4", size=(320, 240), seconds=6)
    destination = tmp_path / "tramo.mp4"

    result = cut_clip(source, destination, 2.0, 4.5, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    assert destination.is_file()
    assert 2.0 <= result.duration_s <= 3.0, result.duration_s
    assert result.info.has_audio
    assert result.to_manifest()["file"] == "tramo.mp4"


def test_cut_rejects_an_impossible_range(make_clip, tmp_path, ffmpeg_bin, ffprobe_bin):
    source = make_clip("source.mp4", size=(320, 240), seconds=2)

    try:
        cut_clip(source, tmp_path / "x.mp4", 3, 2, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    except CutError as error:
        assert "imposible" in str(error)
    else:  # pragma: no cover - el test falla si no lanza
        raise AssertionError("un rango invertido no puede cortarse")
