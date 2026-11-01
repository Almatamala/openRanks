"""Segmentación en escenas (P3-3): umbral adaptativo, destellos, fundidos y banda.

Pruebas **puras**: no necesitan FFmpeg ni archivos. La integración real se prueba en
`test_scenes_e2e.py`.
"""

from __future__ import annotations

from openranks.core.scenes import (
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


def _series(values, fps: float = 30.0, start: float = 0.0):
    """Serie (segundos, valor) de una lista de valores a `fps` fotogramas por segundo."""
    return [(start + index / fps, value) for index, value in enumerate(values)]


def test_defaults_are_the_product_band():
    limits = Thresholds()
    assert (limits.min_clip_s, limits.max_clip_s) == (1.0, 30.0)
    # El suelo va en la escala de `scdet` (MAFD), no en la 0-1 de `select`.
    assert limits.scene_floor == 10.0
    assert limits.scene_k == 3.0
    assert limits.flash_max_s == 0.5
    assert limits.fade_luma == 24.0


def test_env_overrides_the_thresholds_without_touching_code(monkeypatch):
    monkeypatch.setenv("OPENRANKS_SCENE_FLOOR", "14")
    monkeypatch.setenv("OPENRANKS_SCENE_K", "4")
    monkeypatch.setenv("OPENRANKS_FLASH_MAX_SECONDS", "0.3")
    monkeypatch.setenv("OPENRANKS_FADE_LUMA", "20")
    monkeypatch.setenv("OPENRANKS_MIN_CLIP_SECONDS", "2")
    monkeypatch.setenv("OPENRANKS_MAX_CLIP_SECONDS", "20")

    limits = Thresholds.from_env()
    assert limits.scene_floor == 14
    assert limits.scene_k == 4
    assert limits.flash_max_s == 0.3
    assert limits.fade_luma == 20
    assert limits.min_clip_s == 2
    assert limits.max_clip_s == 20
    assert limits.to_manifest()["scene_floor"] == 14


def test_invalid_env_values_fall_back_to_defaults(monkeypatch):
    monkeypatch.setenv("OPENRANKS_SCENE_FLOOR", "-1")
    monkeypatch.setenv("OPENRANKS_SCENE_K", "no")
    monkeypatch.setenv("OPENRANKS_MIN_CLIP_SECONDS", "no")
    assert Thresholds.from_env().scene_floor == 10.0
    assert Thresholds.from_env().scene_k == 3.0
    assert Thresholds.from_env().min_clip_s == 1.0


def test_cuts_are_cleaned_sorted_and_kept_inside_the_video():
    assert clean_cuts([12, 3, 3, -2, 0, 120, "x"], 100) == [3, 12]


def test_every_candidate_is_inside_the_band_and_they_do_not_overlap():
    cuts = [0.5, 1.2, 8.0, 40.0, 41.0, 75.5]
    segments = build_segments(cuts, 120.0)

    assert segments
    for segment in segments:
        assert segment.start_s >= 0
        assert segment.end_s <= 120.0
        assert 1.0 <= segment.duration_s <= 30.0
    for previous, following in zip(segments, segments[1:]):
        assert previous.end_s <= following.start_s


def test_short_fragments_merge_with_their_neighbour():
    # Un plano de 0,4 s entre dos planos largos no puede proponerse solo: se fusiona con
    # el anterior en vez de dejar un candidato por debajo de 1 s.
    segments = build_segments([10.0, 10.6, 30.0], 40.0)
    assert all(segment.duration_s >= 1.0 for segment in segments)
    assert len(segments) == 3
    assert segments[0].end_s == 10.6


def test_long_fragments_are_split_evenly():
    segments = build_segments([], 65.0)
    assert len(segments) == 3
    assert all(segment.duration_s <= 30.0 for segment in segments)
    assert segments[-1].end_s == 65.0


def test_every_cut_falls_exactly_on_the_image_change():
    segments = build_segments([10.0, 25.0], 40.0)
    assert segments[0].start_s == 0.0
    # El tramo siguiente arranca justo en el cambio, sin margen que retrase el corte.
    assert segments[0].end_s == 10.0
    assert segments[1].start_s == 10.0
    assert segments[2] == Segment(25.0, 40.0)


def test_the_same_cuts_and_thresholds_give_the_same_plan():
    cuts = [3.3, 9.1, 18.4, 30.2]
    first = build_segments(cuts, 44.0)
    second = build_segments(list(reversed(cuts)), 44.0)
    assert first == second


def test_a_video_without_cuts_is_one_segment_or_a_split_one():
    assert build_segments([], 12.0) == [Segment(0.0, 12.0)]
    assert len(build_segments([], 31.0)) == 2


def test_a_dropped_dark_span_does_not_extend_the_previous_clip():
    # El fundido [2,4, 3,0] se descarta sin arrastrar su cola oscura al clip anterior.
    segments = build_segments([2.4, 3.0, 3.3], 5.0, dark_spans=[(2.4, 3.0)])
    assert segments == [Segment(0.0, 2.4), Segment(3.0, 5.0)]


def test_a_clear_change_cuts_where_the_score_peaks():
    scores = _series([0.2] * 60 + [40.0] + [0.2] * 60)
    cuts = adaptive_cuts(scores)
    assert len(cuts) == 1
    assert abs(cuts[0] - 2.0) <= 1e-6


def test_a_small_blip_never_cuts():
    # Por debajo del suelo absoluto de `scdet` no hay escena nueva, aunque sea un pico.
    assert adaptive_cuts(_series([0.2] * 60 + [4.0] + [0.2] * 60)) == []


def test_a_busy_scene_needs_a_bigger_change_than_a_quiet_one():
    # Con la mediana local en 6, el umbral sube a 18: un 12 no corta.
    assert adaptive_cuts(_series([6.0] * 60 + [12.0] + [6.0] * 60)) == []
    # El mismo 12 en una escena tranquila sí corta.
    assert len(adaptive_cuts(_series([0.2] * 60 + [12.0] + [0.2] * 60))) == 1


def test_flash_pairs_are_dropped_and_a_later_cut_survives():
    # Dos cortes más juntos que 0,5 s son un fogonazo: se van los dos.
    assert drop_flash_cuts([2.0, 2.07, 5.0]) == [5.0]
    assert drop_flash_cuts([1.0, 1.02]) == []
    # Dos escenas de verdad se quedan.
    assert drop_flash_cuts([2.0, 5.0]) == [2.0, 5.0]


def test_a_dark_valley_between_two_lit_shots_is_a_fade():
    spans = luma_spans(_series([80.0] * 60 + [18.0] * 30 + [80.0] * 60))
    assert len(spans) == 1
    start, end = spans[0]
    assert abs(start - 2.0) <= 1e-6
    assert end - start >= 0.5


def test_a_night_scene_is_not_a_fade():
    # Todo oscuro y sin imagen clara alrededor: no hay fundido que cortar.
    assert luma_spans(_series([18.0] * 90)) == []


def test_a_blink_under_the_minimum_is_not_a_fade():
    assert luma_spans(_series([80.0] * 15 + [18.0] * 2 + [80.0] * 15)) == []


def test_dark_spans_that_touch_are_one_gap():
    spans = merge_spans([(1.0, 2.0), (1.5, 3.0), (5.0, 5.5)])
    assert spans == [(1.0, 3.0), (5.0, 5.5)]
    assert span_edges(spans) == [1.0, 3.0, 5.0, 5.5]


def _metadata_stderr(frames):
    """stderr mínimo de `metadata=print` con score y luminancia por fotograma."""
    lines: list[str] = []
    for index, (when, score, yavg) in enumerate(frames):
        lines.append(f"[Parsed_metadata_1 @ 0x1] frame:{index} pts:0 pts_time:{when:.6f}")
        lines.append(f"[Parsed_metadata_1 @ 0x1] lavfi.scd.score={score:.3f}")
        lines.append(f"[Parsed_metadata_2 @ 0x1] frame:{index} pts:0 pts_time:{when:.6f}")
        lines.append(f"[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YAVG={yavg:.3f}")
    return "\n".join(lines)


def test_the_container_start_time_is_subtracted_from_the_cuts():
    from openranks.scenes import parse_detection

    # Fuente que arranca en 10 s: sin restar el `start_time`, el corte caería en 12 s y
    # el divisor lo descartaría por estar fuera del vídeo.
    frames = [(10.0 + index / 30.0, 40.0 if index == 60 else 0.2, 80.0) for index in range(90)]
    detection = parse_detection(_metadata_stderr(frames), 2.9, start_time_s=10.0)
    assert len(detection.scene_cuts) == 1
    assert abs(detection.scene_cuts[0] - 2.0) <= 1e-3


def test_the_analysis_pass_reads_score_luma_and_black(tmp_path):
    from openranks.scenes import analysis_argv

    argv = analysis_argv("ffmpeg", tmp_path / "video.mp4", Thresholds())
    assert argv[argv.index("-map") + 1] == "0:v:0"
    assert "0:a:0" not in argv
    assert "-an" in argv
    assert argv[argv.index("-fps_mode") + 1] == "passthrough"
    chain = argv[argv.index("-vf") + 1]
    assert "blackdetect" in chain
    assert "scdet" in chain
    assert "lavfi.scd.score" in chain
    assert "signalstats" in chain
    assert "lavfi.signalstats.YAVG" in chain
    assert "select=" not in chain
    assert not any("silencedetect" in part for part in argv)
