"""Set dorado del score (P3-8): manifiesto, evaluación y generación de clips.

La parte pura no toca FFmpeg. La integración genera dos clips de partida con FFmpeg, los
puntúa con el LLM (servidor local) y comprueba que el informe sale medido y sin rutas del host.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openranks.golden import (
    MIN_SPEARMAN,
    GoldenError,
    build_clips,
    evaluate,
    load_golden,
)


def _write_manifest(tmp_path: Path, clips: list[dict], *, version: int = 1) -> Path:
    path = tmp_path / "golden.json"
    path.write_text(
        json.dumps({"version": version, "clips": clips}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def _clips(count: int = 3) -> list[dict]:
    return [
        {
            "id": f"g{index:02d}",
            "file": f"g{index:02d}.mp4",
            "human_rank": index,
            "recipe": {"video": "flat", "audio": "none", "duration_s": 1},
        }
        for index in range(1, count + 1)
    ]


def test_manifest_loads_relative_files_and_the_human_order(tmp_path):
    clips = load_golden(_write_manifest(tmp_path, _clips(3)))
    assert [clip.id for clip in clips] == ["g01", "g02", "g03"]
    assert [clip.human_rank for clip in clips] == [1, 2, 3]
    assert clips[0].file == tmp_path / "g01.mp4"
    assert clips[0].recipe["video"] == "flat"


@pytest.mark.parametrize(
    "payload",
    [
        json.dumps({"version": 2, "clips": _clips(2)}),  # versión desconocida
        json.dumps({"version": 1, "clips": _clips(1)}),  # menos de dos clips
        json.dumps({"version": 1, "clips": [{"id": "a"}, {"id": "b"}]}),  # sin archivo
        json.dumps(
            {
                "version": 1,
                "clips": [
                    {"id": "a", "file": "a.mp4", "human_rank": 1},
                    {"id": "a", "file": "b.mp4", "human_rank": 2},
                ],
            }
        ),  # id repetido
        json.dumps(
            {
                "version": 1,
                "clips": [
                    {"id": "a", "file": "a.mp4", "human_rank": 1},
                    {"id": "b", "file": "b.mp4", "human_rank": 1},
                ],
            }
        ),  # orden humano repetido
        "no es json",
    ],
)
def test_invalid_manifests_fail_with_a_clear_message(tmp_path, payload):
    path = tmp_path / "golden.json"
    path.write_text(payload, encoding="utf-8")
    with pytest.raises(GoldenError):
        load_golden(path)


def test_evaluate_correlates_the_score_with_the_human_order(tmp_path):
    clips = load_golden(_write_manifest(tmp_path, _clips(4)))

    agree = evaluate(clips, [90, 70, 50, 10], times_ms=[100, 200, 300, 400])
    assert agree.spearman == pytest.approx(1.0)
    assert agree.passed is (agree.spearman >= MIN_SPEARMAN)
    assert agree.p95_ms == pytest.approx(385.0)
    assert agree.rows[0]["file"] == "g01.mp4"
    assert "/" not in json.dumps(agree.to_json()["rows"])

    inverted = evaluate(clips, [10, 50, 70, 90])
    assert inverted.spearman == pytest.approx(-1.0)
    assert not inverted.passed


def test_evaluate_rejects_scores_out_of_range_or_missing(tmp_path):
    clips = load_golden(_write_manifest(tmp_path, _clips(2)))
    with pytest.raises(GoldenError):
        evaluate(clips, [120, 10])
    with pytest.raises(GoldenError):
        evaluate(clips, [50])
    with pytest.raises(GoldenError):
        evaluate(clips, ["80", 10])


def test_report_without_times_or_correlation_is_explicit(tmp_path):
    clips = load_golden(_write_manifest(tmp_path, _clips(3)))
    report = evaluate(clips, [60, 60, 60], llm_cost_usd=0.0011, model="claude-haiku-5.5")
    assert report.spearman is None, "sin variación no se puede afirmar correlación"
    assert not report.passed
    assert report.p95_ms is None
    document = report.to_json()
    assert document["llm_cost_usd"] == pytest.approx(0.0011)
    assert document["model"] == "claude-haiku-5.5"
    assert "sin datos" in report.summary()


@pytest.mark.integration
def test_generated_clips_are_rated_without_host_paths(tmp_path, ffmpeg_bin):
    manifest = _write_manifest(
        tmp_path,
        [
            {
                "id": "movido",
                "file": "movido.mp4",
                "human_rank": 1,
                "recipe": {"video": "testsrc2", "audio": "loud", "duration_s": 3},
            },
            {
                "id": "quieto",
                "file": "quieto.mp4",
                "human_rank": 2,
                "recipe": {"video": "flat", "audio": "none", "duration_s": 3},
            },
        ],
    )
    clips = load_golden(manifest)
    written = build_clips(clips, ffmpeg=ffmpeg_bin)
    assert all(path.is_file() and path.stat().st_size > 0 for path in written)

    from openranks.rate import rate_many

    scores = []
    for clip in clips:
        rated = rate_many([clip.file], ffmpeg=ffmpeg_bin)[0]
        assert rated.score is not None, rated.error
        assert 0 <= rated.score <= 100
        scores.append(rated.score)

    report = evaluate(clips, scores)
    assert report.clips == 2
    assert report.spearman is not None
    document = json.dumps(report.to_json(), ensure_ascii=False)
    assert str(tmp_path) not in document
