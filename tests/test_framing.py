"""Encuadre sin FFmpeg: clasificación, área útil, confianza y recorte par."""

from __future__ import annotations

import pytest

from openranks.core.framing import (
    Crop,
    FramingError,
    GrayFrame,
    _detached_islands,
    analyze_frames,
    classify_size,
    decision_without_analysis,
    fallback_decision,
    needs_analysis,
    refine_edge,
)


def _frame(
    *,
    width: int = 128,
    height: int = 72,
    left: int = 40,
    right: int = 88,
    top: int = 0,
    bottom: int | None = None,
    island: tuple[int, int] | None = None,
) -> GrayFrame:
    """Fondo suave + bloque central de tablero (nitidez alta).

    El tablero genera gradientes fuertes; el fondo, un gradiente lineal suave. Es el
    caso mínimo de un clip vertical centrado sobre un fondo borroso.
    """
    bottom = height if bottom is None else bottom
    pixels = bytearray(width * height)
    for y in range(height):
        for x in range(width):
            inside = left <= x < right and top <= y < bottom
            extra = island is not None and island[0] <= x < island[1]
            if inside or extra:
                # Ruido determinista: da gradiente alto en horizontal y en vertical.
                value = 30 + ((x * 73 + y * 151 + x * y * 17) % 200)
            else:
                value = 90 + (24 * x // max(1, width - 1)) + (12 * y // max(1, height - 1))
            pixels[y * width + x] = max(0, min(255, value))
    return GrayFrame(width=width, height=height, pixels=bytes(pixels))


def _analyze(**kwargs) -> dict:
    frame = _frame(**kwargs)
    decision = analyze_frames(
        [frame, frame, frame],
        input_size=(1920, 1080),
        visible_size=(1920, 1080),
    )
    return decision


def test_an_exact_1080x1920_is_type_b_without_analysis():
    decision = analyze_frames([], input_size=(1080, 1920), visible_size=(1080, 1920))
    assert decision.classification == "B"
    assert decision.fit == "sin_cambios"
    assert decision.crop is None
    assert decision.confidence == 1.0


def test_a_vertical_clip_of_another_size_only_scales():
    decision = decision_without_analysis(
        input_size=(720, 1280),
        visible_size=(720, 1280),
        rotation=0,
    )
    assert decision.classification == "B"
    assert decision.crop is None
    assert decision.fit == "contain"
    assert "vertical" in decision.reason


def test_classification_distinguishes_horizontal_and_vertical():
    assert classify_size((1920, 1080))[0] == "A"
    assert classify_size((1080, 1080))[0] == "A"
    assert classify_size((1080, 1920))[0] == "B"
    assert classify_size((720, 1280))[0] == "B"
    assert needs_analysis((1920, 1080)) is True
    assert needs_analysis((1080, 1920)) is False


def test_a_clear_pillarboxed_clip_is_detected_and_cropped():
    decision = _analyze()
    assert decision.classification == "A"
    assert decision.crop is not None
    # El bloque nítido está entre las columnas 40 y 88 de 128 (escala 15x).
    assert decision.crop.x == pytest.approx(600, abs=30)
    assert decision.crop.w == pytest.approx(720, abs=35)
    assert decision.crop.y == 0
    assert decision.crop.h == 1080
    assert decision.confidence >= 0.80
    assert decision.fit == "contain"


def test_the_crop_is_even_and_inside_the_frame():
    decision = _analyze(left=37, right=91)
    crop = decision.crop
    assert crop is not None
    assert all(value % 2 == 0 for value in (crop.w, crop.h, crop.x, crop.y))
    assert crop.right <= 1920 and crop.bottom <= 1080


def test_a_full_frame_without_blur_is_not_cropped():
    decision = _analyze(left=0, right=128, top=0, bottom=72)
    assert decision.classification == "A"
    assert decision.crop is None
    assert "fondo borroso" in decision.reason
    assert any("sin fondo borroso" in warning for warning in decision.warnings)


def test_a_watermark_island_does_not_extend_the_crop():
    decision = _analyze(island=(104, 111))
    assert decision.crop is not None
    assert decision.crop.x == pytest.approx(600, abs=30)
    assert decision.crop.w == pytest.approx(720, abs=35)
    assert any("marca de agua" in warning for warning in decision.warnings)


def test_a_narrow_off_center_area_is_not_cropped():
    decision = _analyze(left=5, right=30)
    assert decision.crop is None
    assert decision.confidence < 0.60
    assert decision.warnings


def test_a_dark_or_flat_frame_falls_back_without_cropping():
    frame = GrayFrame(width=32, height=24, pixels=bytes(32 * 24))
    decision = analyze_frames([frame], input_size=(1920, 1080), visible_size=(1920, 1080))
    assert decision.crop is None
    assert decision.confidence < 0.30
    assert any("nitidez" in warning for warning in decision.warnings)


def test_rows_are_cropped_when_the_blur_is_above_and_below():
    decision = _analyze(left=30, right=98, top=10, bottom=62)
    assert decision.crop is not None
    assert decision.crop.y == pytest.approx(150, abs=30)
    assert decision.crop.h == pytest.approx(780, abs=35)
    assert any("más ancha que 9:16" in warning for warning in decision.warnings)


def test_islands_inside_the_gap_closed_area_are_not_watermarks():
    # El área útil se cerró sobre un hueco plano (columnas 25), así que aparece
    # partida en dos tramos: no son islas, son el mismo clip.
    scores = [0.05] * 20 + [0.5] * 5 + [0.1] + [0.5] * 5 + [0.05] * 20
    assert _detached_islands(scores, 0.3, (20, 31)) == []
    # Una zona nítida separada del área útil sí se reporta.
    scores[38:42] = [0.6] * 4
    assert _detached_islands(scores, 0.3, (20, 31)) == [(38, 42)]


def test_refine_edge_finds_the_rising_and_falling_steps():
    scores = [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0]
    assert refine_edge(scores, 3, rising=True, radius=2) == 3
    assert refine_edge(scores, 7, rising=False, radius=2) == 7


def test_a_fallback_is_conservative_and_warns():
    decision = fallback_decision(
        input_size=(1920, 1080),
        visible_size=(1920, 1080),
        rotation=0,
        reason="no se pudo analizar",
        warning="sin análisis",
    )
    assert decision.classification == "A"
    assert decision.crop is None
    assert decision.fit == "contain"
    assert decision.warnings


def test_an_empty_frame_set_is_an_error_only_when_analysis_is_needed():
    with pytest.raises(FramingError, match="fotogramas"):
        analyze_frames([], input_size=(1920, 1080), visible_size=(1920, 1080))


def test_crop_rejects_negative_origin():
    with pytest.raises(ValueError):
        Crop(w=10, h=10, x=-1, y=0)
