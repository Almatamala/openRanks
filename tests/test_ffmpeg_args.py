"""Los comandos de FFmpeg se construyen sin ejecutarlos: aquí se revisan tal cual."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core import ffmpeg as ff
from openranks.core.config import Config
from openranks.core.framing import Crop

CONFIG = Config()

LOUDNORM_STDERR = """
[Parsed_loudnorm_0 @ 000001] 
{
\t"input_i" : "-13.75",
\t"input_tp" : "-0.81",
\t"input_lra" : "2.10",
\t"input_thresh" : "-24.05",
\t"output_i" : "-14.01",
\t"output_tp" : "-1.00",
\t"output_lra" : "2.10",
\t"output_thresh" : "-24.11",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.10"
}
"""


def test_video_filter_band_fills_the_band_and_crops_only_the_sides():
    chain = ff.video_filter(CONFIG, "band")
    # Se escala por el lado que más agrande: llenar el ancho (1080/iw) o la banda
    # (1184/ih), con el alto de la banda en la cadena.
    assert "max(1080/iw\\,1184/ih)" in chain
    assert ff.BAND_HEIGHT == 1184
    # El sobrante se recorta **solo** a lo ancho y se centra; el alto nunca se recorta.
    assert "crop=w='min(iw\\,1080)':h='min(ih\\,1920)'" in chain
    assert "x='(iw-ow)/2':y='(ih-oh)/2'" in chain
    # Lo que quede vacío arriba/abajo se rellena de negro (encaje centrado).
    assert "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black" in chain
    assert "setsar=1" in chain and "fps=30" in chain and "format=yuv420p" in chain


def test_video_filter_band_is_still_available_and_auto_is_resolved_before_it():
    assert ff.video_filter(CONFIG) == ff.video_filter(CONFIG, "band")
    assert CONFIG.fit == "auto"
    with pytest.raises(ValueError, match="fit='auto'"):
        ff.video_filter(CONFIG, "auto")


def test_video_filter_prepends_the_detected_crop():
    crop = Crop(w=608, h=1080, x=656, y=0)
    chain = ff.video_filter(CONFIG, "contain", crop)
    assert chain.startswith("crop=608:1080:656:0,")
    assert "scale=1080:1920:force_original_aspect_ratio=decrease" in chain
    assert "pad=1080:1920" in chain
    assert "setsar=1" in chain and "fps=30" in chain and "format=yuv420p" in chain


def test_video_filter_rejects_an_odd_crop():
    with pytest.raises(ValueError, match="pares"):
        ff.video_filter(CONFIG, "contain", Crop(w=607, h=1080, x=656, y=0))


def test_video_filter_cover_crops_to_the_vertical_frame():
    chain = ff.video_filter(CONFIG, "cover")
    assert "scale=1080:1920:force_original_aspect_ratio=increase" in chain
    assert "crop=1080:1920" in chain
    assert "setsar=1" in chain
    assert "fps=30" in chain
    assert "format=yuv420p" in chain


def test_video_filter_contain_pads_instead_of_cropping():
    chain = ff.video_filter(CONFIG, "contain")
    assert "force_original_aspect_ratio=decrease" in chain
    assert "pad=1080:1920" in chain


def test_video_filter_rejects_unknown_fit():
    with pytest.raises(ValueError, match="fit desconocido"):
        ff.video_filter(CONFIG, "stretch")


def test_normalize_argv_carries_the_l1_output_contract():
    argv = ff.normalize_argv("ffmpeg", Path("in.mp4"), Path("out.mp4"), config=CONFIG, has_audio=True)
    joined = " ".join(argv)
    assert "-vf" in argv and "format=yuv420p" in joined
    assert argv[argv.index("-crf") + 1] == "19"
    assert argv[argv.index("-pix_fmt") + 1] == "yuv420p"
    assert argv[argv.index("-ac") + 1] == "2"
    assert argv[argv.index("-ar") + 1] == "48000"
    assert argv[argv.index("-video_track_timescale") + 1] == "30000"
    # Nada de metadatos del origen (equivalente a METADATA_SCRUB) y mp4 optimizado.
    assert argv[argv.index("-map_metadata") + 1] == "-1"
    # La rotación ya se aplicó; el MP4 normalizado no la vuelve a declarar.
    assert argv[argv.index("-metadata:s:v:0") + 1] == "rotate=0"
    assert "+faststart" in argv
    assert "anullsrc" not in joined


def test_normalize_argv_carries_the_crop_into_the_filter():
    argv = ff.normalize_argv(
        "ffmpeg",
        Path("in.mp4"),
        Path("out.mp4"),
        config=CONFIG,
        has_audio=True,
        fit="contain",
        crop=Crop(w=608, h=1080, x=656, y=0),
    )
    chain = argv[argv.index("-vf") + 1]
    assert chain.startswith("crop=608:1080:656:0,")
    assert "force_original_aspect_ratio=decrease" in chain


def test_normalize_argv_injects_silence_for_a_clip_without_audio():
    argv = ff.normalize_argv("ffmpeg", Path("mudo.mp4"), Path("out.mp4"), config=CONFIG, has_audio=False)
    joined = " ".join(argv)
    assert "anullsrc=channel_layout=stereo:sample_rate=48000" in joined
    assert argv[argv.index("-map") + 1] == "0:v:0"
    assert "1:a:0" in argv
    assert "-shortest" in argv
    assert "loudnorm" not in joined


def test_normalize_bounds_the_output_duration():
    """Sin acotar, `loudnorm`/AAC dejan cola y el tramo crece ~100 ms (padding por corte)."""
    argv = ff.normalize_argv("ffmpeg", Path("in.mp4"), Path("out.mp4"), config=CONFIG, has_audio=True, duration_s=7.0)
    assert argv[-3:-1] == ["-t", "7.000"]
    assert "-shortest" not in argv


def test_loudnorm_single_pass_has_no_linear_flag():
    assert "linear=true" not in ff.loudnorm_filter(CONFIG)
    assert "I=-14.0" in ff.loudnorm_filter(CONFIG)


def test_loudnorm_second_pass_uses_measured_values():
    measured = ff.parse_loudnorm_json(LOUDNORM_STDERR)
    assert measured is not None
    chain = ff.loudnorm_filter(CONFIG, measured)
    assert "measured_I=-13.75" in chain
    assert "measured_thresh=-24.05" in chain
    assert "offset=0.10" in chain
    assert "linear=true" in chain


def test_measure_argv_writes_no_output():
    argv = ff.measure_loudness_argv("ffmpeg", Path("in.mp4"), CONFIG)
    assert argv[-2:] == ["null", "-"]
    assert "print_format=json" in argv[argv.index("-af") + 1]


def test_parse_loudnorm_json_handles_missing_or_silent_audio():
    assert ff.parse_loudnorm_json("sin json aquí") is None
    assert ff.parse_loudnorm_json('{ "input_i" : "-inf", "target_offset" : "0.0" }') is None


def test_concat_list_escapes_quotes():
    text = ff.concat_list_text([Path("normal.mp4"), Path("con'apostrofo.mp4")])
    lines = text.strip().splitlines()
    assert len(lines) == 2
    assert lines[0].startswith("file '") and lines[0].endswith("'")
    assert "'\\''" in lines[1]


def test_concat_copy_is_the_only_union_and_does_not_reencode():
    """El montaje es siempre de corte seco: la unión es una copia de streams, sin
    transiciones ni recodificación."""
    argv = ff.concat_copy_argv("ffmpeg", Path("lista.txt"), Path("union.mp4"))
    assert argv[argv.index("-c") + 1] == "copy"
    assert "-f" in argv and argv[argv.index("-f") + 1] == "concat"
    assert "-filter_complex" not in argv
    # El motor ya no ofrece transiciones: ni la tabla ni el constructor de xfade existen.
    assert not hasattr(ff, "TRANSITIONS")
    assert not hasattr(ff, "transition_argv")
