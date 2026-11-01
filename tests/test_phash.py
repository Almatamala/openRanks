"""Huella perceptual (P3-3): planos repetidos con DCT, sin FFmpeg ni dependencias.

Pruebas **puras**: el módulo recibe los 1.024 bytes del fotograma ya decodificado, así que
aquí no hace falta vídeo. La integración con FFmpeg se prueba en `test_scenes_e2e.py`.
"""

from __future__ import annotations

import math

from openranks.core.phash import (
    BITS,
    DUPLICATE_DISTANCE,
    duplicates_of,
    hamming,
    phash,
)


def _frame(shift: int = 0) -> bytes:
    """32×32 en gris con un patrón suave: mover `shift` lo convierte en otro plano."""
    values = bytearray()
    for y in range(32):
        for x in range(32):
            value = 128 + 60 * math.sin((x + shift) / 5) + 50 * math.cos((y + shift) / 7)
            values.append(max(0, min(255, int(value))))
    return bytes(values)


def _frame_hash() -> str | None:
    return phash(_frame())


def test_the_hash_is_sixteen_hex_digits_and_deterministic():
    sample = _frame()
    first = phash(sample)
    assert first is not None
    assert len(first) == 16
    assert first == phash(bytes(sample))


def test_the_same_shot_with_a_small_change_stays_close():
    original = _frame()
    tweaked = bytearray(original)
    for index in (5, 700, 1020):
        tweaked[index] = min(255, tweaked[index] + 1)

    distance = hamming(phash(original), phash(bytes(tweaked)))
    assert distance <= DUPLICATE_DISTANCE


def test_different_shots_land_far_apart():
    # Mover el patrón media muestra cambia la estructura de brillo: no es el mismo plano.
    assert hamming(phash(_frame()), phash(_frame(shift=16))) > DUPLICATE_DISTANCE


def test_a_flat_frame_has_no_hash():
    # Negro, blanco y un color plano no distinguen planos: sin huella, sin duplicados falsos.
    assert phash(bytes(32 * 32)) is None
    assert phash(bytes([255]) * (32 * 32)) is None
    assert phash(bytes([120]) * (32 * 32)) is None


def test_a_sample_of_the_wrong_size_has_no_hash():
    assert phash(b"") is None
    assert phash(bytes(1023)) is None


def test_hamming_rejects_unknown_values():
    assert hamming(None, _frame_hash()) == BITS
    assert hamming("no-es-una-huella", _frame_hash()) == BITS
    assert hamming(_frame_hash(), _frame_hash()) == 0


def test_duplicates_point_to_the_first_earlier_shot():
    repeated = _frame_hash()
    other = phash(_frame(shift=16))
    assert duplicates_of([repeated, other, repeated]) == [None, None, 1]
    assert duplicates_of([repeated, repeated]) == [None, 1]


def test_a_missing_hash_never_marks_a_duplicate():
    assert duplicates_of([None, None]) == [None, None]
    assert duplicates_of([_frame_hash(), None]) == [None, None]
