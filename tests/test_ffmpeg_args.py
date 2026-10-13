"""Los comandos de FFmpeg se construyen sin ejecutarlos: aquí se revisan tal cual."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core import ffmpeg as ff
from openranks.core.config import Config

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
    assert "+faststart" in argv
    assert "anullsrc" not in joined


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


def test_normalize_with_a_limit_bounds_input_and_output():
    argv = ff.normalize_argv(
        "ffmpeg",
        Path("mudo.mp4"),
        Path("out.mp4"),
        config=CONFIG,
        has_audio=False,
        limit_s=1.5,
        duration_s=1.5,
    )
    assert argv.index("-t") < argv.index("-i")  # recorte barato en la entrada
    assert argv.count("-t") == 2  # y cota de la salida (el silencio inyectado es infinito)


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


def test_concat_copy_does_not_reencode():
    argv = ff.concat_copy_argv("ffmpeg", Path("lista.txt"), Path("union.mp4"))
    assert argv[argv.index("-c") + 1] == "copy"
    assert "-f" in argv and argv[argv.index("-f") + 1] == "concat"


def test_transition_offsets_account_for_the_overlap():
    # 3 clips de 10 s con 1 s de solape: 10 - 1 = 9, y (10 + 10 - 1) - 1 = 18.
    assert ff.transition_offsets([10.0, 10.0, 10.0], 1.0) == [9.0, 18.0]
    # 5 clips de 6 s con 0.35 s de solape: cada offset es la longitud acumulada menos el solape.
    assert ff.transition_offsets([6.0, 6.0, 6.0, 6.0, 6.0], 0.35) == pytest.approx([5.65, 11.3, 16.95, 22.6])


def test_transition_offsets_reject_negative_duration():
    with pytest.raises(ff.TransitionError):
        ff.transition_offsets([10.0, 10.0], -0.35)


def test_transition_argv_chains_xfade_and_acrossfade():
    argv = ff.transition_argv(
        "ffmpeg",
        [Path("a.mp4"), Path("b.mp4"), Path("c.mp4")],
        Path("out.mp4"),
        config=CONFIG,
        durations=[10.0, 10.0, 10.0],
        transition="slideup",
        transition_s=1.0,
    )
    graph = argv[argv.index("-filter_complex") + 1]
    assert graph.count("xfade=transition=slideup") == 2
    assert graph.count("acrossfade") == 2
    assert "offset=9.000" in graph and "offset=18.000" in graph
    assert argv[argv.index("-map") + 1] == "[vx2]"


def test_transition_argv_validates_its_input():
    with pytest.raises(ff.TransitionError):
        ff.transition_argv("ffmpeg", [Path("a.mp4")], Path("o.mp4"), config=CONFIG, durations=[1.0])
    with pytest.raises(ff.TransitionError, match="no soportada"):
        ff.transition_argv(
            "ffmpeg",
            [Path("a.mp4"), Path("b.mp4")],
            Path("o.mp4"),
            config=CONFIG,
            durations=[5.0, 5.0],
            transition="magic",
        )


def test_slideup_is_offered_as_the_pull_in_equivalent():
    assert "slideup" in ff.TRANSITIONS
