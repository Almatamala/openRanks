"""Huella perceptual de un fotograma (F3 · P3-3): planos repetidos sin salir de stdlib.

Un pHash de 64 bits resume la **estructura de brillo** de un fotograma: la muestra se pasa
a 32×32 en gris, se toman los coeficientes bajos de la DCT y se marca un bit por coeficiente
según quede por encima o por debajo de la mediana. Dos fotogramas del mismo plano quedan a
pocos bits aunque cambien el códec o la resolución; dos planos distintos quedan lejos.

El módulo es **puro**: recibe los bytes del fotograma ya decodificado y no toca FFmpeg ni
disco. Así los duplicados se prueban sin vídeo, sin red y sin dependencias, como el resto
del núcleo.
"""

from __future__ import annotations

import math
from statistics import median

# Lado de la muestra que entrega FFmpeg: 32×32 píxeles en gris = 1.024 bytes.
SAMPLE = 32
# Coeficientes que se conservan por eje: la DCT de 8×8 de frecuencias bajas.
TAKE = 8
BITS = TAKE * TAKE
# Dos huellas a esta distancia o menos son el mismo plano. Con 64 bits, 8 tolera una
# recodificación o un reescalado sin acercar planos que solo se parecen.
DUPLICATE_DISTANCE = 8
# Un fotograma casi liso (negro, blanco, un color plano) no distingue planos: su hash sería
# el mismo para cualquiera y marcaría duplicados falsos. Por debajo de esta desviación no
# hay huella.
FLAT_STDDEV = 4.0


def _basis() -> tuple[tuple[float, ...], ...]:
    """Cosenos de la DCT para los `TAKE` coeficientes bajos (tabla fija, sin numpy)."""
    return tuple(
        tuple(
            math.cos((2 * x + 1) * frequency * math.pi / (2 * SAMPLE))
            for x in range(SAMPLE)
        )
        for frequency in range(TAKE)
    )


_BASIS = _basis()


def phash(samples: bytes) -> str | None:
    """pHash de 16 dígitos hexadecimales de una muestra 32×32 en gris, o `None`.

    `None` cuando la muestra no mide lo que toca o es un plano liso: en los dos casos una
    huella no diría nada y solo serviría para marcar duplicados falsos.
    """
    if not isinstance(samples, (bytes, bytearray)) or len(samples) != SAMPLE * SAMPLE:
        return None

    mean = sum(samples) / len(samples)
    variance = sum((value - mean) ** 2 for value in samples) / len(samples)
    if math.sqrt(variance) < FLAT_STDDEV:
        return None

    # DCT separable: primero las filas (32×8), luego las columnas (8×8).
    rows: list[list[float]] = []
    for y in range(SAMPLE):
        row = samples[y * SAMPLE : (y + 1) * SAMPLE]
        rows.append([sum(b * r for b, r in zip(basis, row)) for basis in _BASIS])

    coefficients: list[float] = []
    for frequency in range(TAKE):
        basis = _BASIS[frequency]
        for column in range(TAKE):
            coefficients.append(sum(b * rows[y][column] for y, b in enumerate(basis)))

    # El coeficiente DC (0,0) es el brillo medio y manda sobre todos los demás: los bits
    # salen de comparar los 63 restantes con su mediana.
    alternating = coefficients[1:]
    threshold = median(alternating)
    bits = 0
    for index, value in enumerate(alternating):
        if value > threshold:
            bits |= 1 << index
    return f"{bits:016x}"


def hamming(left: str | None, right: str | None) -> int:
    """Bits distintos entre dos huellas; `BITS` si alguna no es válida."""
    if not left or not right:
        return BITS
    try:
        return (int(left, 16) ^ int(right, 16)).bit_count()
    except ValueError:
        return BITS


def duplicates_of(hashes, max_distance: int = DUPLICATE_DISTANCE) -> list[int | None]:
    """Para cada huella, el número (1..n) del **primer** plano anterior que la repite.

    El resultado se alinea con la parrilla: la posición `i` es la escena `i + 1`, y su valor
    es el número de la escena anterior con el mismo plano, o `None` si no repite nada.
    """
    values = list(hashes)
    result: list[int | None] = []
    for position, current in enumerate(values):
        repeated: int | None = None
        if current:
            for earlier in range(position):
                if hamming(values[earlier], current) <= max_distance:
                    repeated = earlier + 1
                    break
        result.append(repeated)
    return result
