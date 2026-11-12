"""Métricas del set dorado (P3-8): Spearman con empates, percentiles y media.

Todo puro: sin FFmpeg, sin red y sin archivos.
"""

from __future__ import annotations

import pytest

from openranks.metrics import average_ranks, mean, percentile, spearman


def test_average_ranks_shares_tied_positions():
    assert average_ranks([10, 20, 30]) == [1.0, 2.0, 3.0]
    assert average_ranks([20, 10, 20]) == [2.5, 1.0, 2.5]
    assert average_ranks([5, 5, 5, 5]) == [2.5, 2.5, 2.5, 2.5]
    assert average_ranks([]) == []


def test_average_ranks_rejects_non_numbers_and_non_finite_values():
    with pytest.raises(ValueError):
        average_ranks([1, "no"])
    with pytest.raises(ValueError):
        average_ranks([1, float("nan")])


def test_spearman_is_one_for_the_same_order_and_minus_one_for_the_reverse():
    human = [1, 2, 3, 4, 5]
    assert spearman(human, [10, 20, 30, 40, 50]) == pytest.approx(1.0)
    assert spearman(human, [50, 40, 30, 20, 10]) == pytest.approx(-1.0)
    # Monótona no lineal: Spearman no cambia; Pearson sí.
    assert spearman(human, [1, 8, 27, 64, 125]) == pytest.approx(1.0)


def test_spearman_handles_ties_without_inflating_the_correlation():
    # Rangos del score: [1.5, 1.5, 3.5, 3.5] contra [1, 2, 3, 4].
    assert spearman([1, 1, 2, 2], [1, 2, 3, 4]) == pytest.approx(0.8944, abs=1e-4)


def test_spearman_is_undefined_without_variation_or_data():
    assert spearman([1, 1, 1], [1, 2, 3]) is None
    assert spearman([1, 2, 3], [5, 5, 5]) is None
    assert spearman([1], [2]) is None
    assert spearman([1, 2], [1, 2, 3]) is None


def test_percentile_interpolates_and_clamps():
    assert percentile([1, 2, 3, 4], 0.95) == pytest.approx(3.85)
    assert percentile([1, 2, 3, 4], 0.5) == pytest.approx(2.5)
    assert percentile([7], 0.95) == 7.0
    assert percentile([], 0.95) is None
    assert percentile([1, 2, 3, 4], 2.0) == 4.0
    assert percentile([1, 2, 3, 4], -1.0) == 1.0


def test_mean_ignores_non_finite_values():
    assert mean([10, 20, 30]) == pytest.approx(20.0)
    assert mean([]) is None
    assert mean([float("nan"), 6]) == pytest.approx(6.0)
