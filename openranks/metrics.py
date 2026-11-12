"""Métricas de la evaluación del score (F3 · P3-8).

Módulo **puro**: sin FFmpeg, sin red y sin dependencias. Es lo que usa el script
`scripts/evaluate_score.py` sobre el set dorado y lo que prueban `tests/test_metrics.py`
y `tests/test_golden.py`.

- `spearman`: la correlación de rangos de RF-18, con **empates** compartidos (dos clips
  con el mismo score no inflan ni hunden la correlación).
- `percentile`: el p95 de latencia con interpolación lineal, para no redondear a favor.
- Un set sin variación (todos los scores iguales) o de menos de dos clips **no** tiene
  correlación: devuelve `None`, que el informe enseña como «sin datos», nunca como 0.
"""

from __future__ import annotations

import math
from collections.abc import Sequence


def average_ranks(values: Sequence[float]) -> list[float]:
    """Rango 1..n de cada valor; los empates comparten la media de sus posiciones."""
    numbers: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ValueError("las puntuaciones deben ser números") from None
        if not math.isfinite(number):
            raise ValueError("las puntuaciones deben ser finitas")
        numbers.append(number)
    if not numbers:
        return []

    order = sorted(range(len(numbers)), key=lambda index: numbers[index])
    ranks = [0.0] * len(numbers)
    position = 0
    while position < len(order):
        end = position
        while end + 1 < len(order) and numbers[order[end + 1]] == numbers[order[position]]:
            end += 1
        # Posiciones 1-based de `position` a `end`: todas reciben su media.
        shared = (position + end) / 2.0 + 1.0
        for index in range(position, end + 1):
            ranks[order[index]] = shared
        position = end + 1
    return ranks


def _pearson(left: Sequence[float], right: Sequence[float]) -> float | None:
    """Pearson sobre dos listas del mismo tamaño; `None` si alguna es constante."""
    if len(left) != len(right) or len(left) < 2:
        return None
    mean_left = sum(left) / len(left)
    mean_right = sum(right) / len(right)
    covariance = sum((a - mean_left) * (b - mean_right) for a, b in zip(left, right))
    var_left = sum((a - mean_left) ** 2 for a in left)
    var_right = sum((b - mean_right) ** 2 for b in right)
    if var_left <= 0 or var_right <= 0:
        return None
    return covariance / math.sqrt(var_left * var_right)


def spearman(left: Sequence[float], right: Sequence[float]) -> float | None:
    """Correlación de Spearman (Pearson sobre rangos), en −1..1.

    Devuelve `None` si faltan datos, si los tamaños no coinciden o si una de las dos
    series no varía: la correlación no está definida y el informe lo dice así.
    """
    if len(left) != len(right) or len(left) < 2:
        return None
    return _pearson(average_ranks(left), average_ranks(right))


def percentile(values: Sequence[float], fraction: float) -> float | None:
    """Percentil con interpolación lineal; `fraction=0.95` es el p95."""
    numbers = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not numbers:
        return None
    position = min(1.0, max(0.0, float(fraction))) * (len(numbers) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return numbers[int(position)]
    weight = position - low
    return numbers[low] * (1.0 - weight) + numbers[high] * weight


def mean(values: Sequence[float]) -> float | None:
    """Media de los valores finitos; `None` si no hay ninguno."""
    numbers = [float(value) for value in values if math.isfinite(float(value))]
    if not numbers:
        return None
    return sum(numbers) / len(numbers)
