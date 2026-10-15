"""Integración real: FFmpeg de verdad sobre clips sintéticos.

Aquí se comprueba el criterio de salida de L1 (§12): 1080x1920, 30 fps, yuv420p,
audio presente, un solo ``union.mp4`` y los 5 clips listos.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from openranks import assemble as assemble_module
from openranks.assemble import AssemblyError, assemble
from openranks.cli import main
from openranks.core.binding import load_binding
from openranks.core.config import Config
from openranks.core.media import probe

pytestmark = pytest.mark.integration


def _fast(**overrides) -> Config:
    """Config rápida para los tests: mismo contrato, menos CPU."""
    settings = {"crf": 32, "preset": "ultrafast"}
    settings.update(overrides)
    return replace(Config(), **settings)


def _small() -> Config:
    return _fast(target_width=180, target_height=320)


def test_full_size_assembly_meets_the_l1_criterion(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    binding = load_binding(write_binding(synthetic_clips), _fast())
    result = assemble(binding, tmp_path / "out", config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    # 5 archivos listos, nombrados por posición y en orden de reproducción (#5 → #1).
    assert len(result.clips) == 5
    assert all(clip.is_file() for clip in result.clips)
    assert result.clips[0].name.startswith("05-")
    assert result.clips[-1].name.startswith("01-")

    union = probe(ffprobe_bin, result.union)
    assert (union.width, union.height) == (1080, 1920)
    assert union.fps == pytest.approx(30, abs=0.05)
    assert union.pix_fmt == "yuv420p"
    assert union.has_audio

    # Exactitud de la unión: 5 clips de 2 s a 30 fps = 300 fotogramas y 10 s clavados.
    # (Sin acotar cada tramo, `loudnorm` dejaba cola de audio y el contenedor crecía.)
    assert union.nb_frames == 300
    assert union.duration_s == pytest.approx(10.0, abs=0.15)

    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert payload["layer"] == "L1"
    assert payload["plan"]["clip_count"] == 5
    assert payload["measured"]["total_duration_s"] is not None
    # 5 clips + la unión, y 5 fuentes medidas.
    assert len(payload["outputs"]) == 6
    assert len(payload["sources"]) == 5


def test_normalized_clips_are_already_ready(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    binding = load_binding(write_binding(synthetic_clips), _fast())
    result = assemble(binding, tmp_path / "out", config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    for clip in result.clips:
        info = probe(ffprobe_bin, clip)
        assert (info.width, info.height) == (1080, 1920)
        assert info.pix_fmt == "yuv420p"
        assert info.has_audio


def test_silence_is_injected_for_a_clip_without_audio(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    # clip-3.mp4 se genera sin audio: la unión debe tener audio igualmente.
    binding = load_binding(write_binding(synthetic_clips), _small())
    result = assemble(binding, tmp_path / "out", config=_small(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    assert probe(ffprobe_bin, result.union).has_audio


def test_transitions_shorten_the_union(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    binding = load_binding(write_binding(synthetic_clips), _small())
    result = assemble(
        binding,
        tmp_path / "out",
        config=_small(),
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
        transition_s=0.5,
        transition="slideup",
    )
    total = sum(probe(ffprobe_bin, clip).duration_s for clip in synthetic_clips)
    assert result.plan.overlaps_s == pytest.approx(2.0)
    assert result.total_measured_s == pytest.approx(total - 2.0, abs=0.5)
    # El solape consume fotogramas: la expectativa sale del plan, no de la suma de tramos.
    assert probe(ffprobe_bin, result.union).nb_frames == round(result.plan.total_duration_s * 30)
    assert not any("fotogramas" in warning for warning in result.warnings)


def test_cold_open_prepends_the_best_clip(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    binding = load_binding(write_binding(synthetic_clips), _small())
    result = assemble(
        binding,
        tmp_path / "out",
        config=_small(),
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
        cold_open_s=1.0,
    )
    assert result.plan.segments[0].position == 0
    total = sum(probe(ffprobe_bin, clip).duration_s for clip in synthetic_clips)
    assert result.total_measured_s == pytest.approx(total + 1.0, abs=0.15)
    assert probe(ffprobe_bin, result.union).nb_frames == round(result.plan.total_duration_s * 30)


def test_loudness_lands_on_the_target(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path):
    binding = load_binding(write_binding(synthetic_clips), _small())
    result = assemble(binding, tmp_path / "out", config=_small(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    # La unión se midió al final: debe caer en −14 LUFS (±2).
    assert result.loudness.get("input_i") is not None
    assert float(result.loudness["input_i"]) == pytest.approx(-14.0, abs=2.0)


def test_a_clip_that_breaks_the_contract_aborts_the_whole_run(
    ffmpeg_bin, ffprobe_bin, make_clip, write_binding, tmp_path
):
    clips = [
        make_clip("ok-1.mp4", size=(320, 240)),
        make_clip("ok-2.mp4", size=(320, 240)),
        make_clip("demasiado-corto.mp4", size=(320, 240), seconds=0.4),
        make_clip("ok-4.mp4", size=(320, 240)),
        make_clip("ok-5.mp4", size=(320, 240)),
    ]
    binding = load_binding(write_binding(clips, labels=("UNO", "DOS", "TRES", "CUATRO", "CINCO")), _small())
    with pytest.raises(AssemblyError, match="contrato de L1"):
        assemble(binding, tmp_path / "out", config=_small(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)


def test_cli_assemble_writes_the_union(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path, monkeypatch, capsys):
    # El CLI lee el formato del entorno: aquí se reduce para que el test sea barato.
    monkeypatch.setenv("OPENRANKS_WIDTH", "180")
    monkeypatch.setenv("OPENRANKS_HEIGHT", "320")
    monkeypatch.setenv("OPENRANKS_CRF", "32")
    monkeypatch.setenv("OPENRANKS_PRESET", "ultrafast")
    binding_path = write_binding(synthetic_clips)

    code = main(
        [
            "assemble",
            "--input",
            str(binding_path),
            "--out",
            str(tmp_path / "cli"),
            "--ffmpeg",
            ffmpeg_bin,
            "--ffprobe",
            ffprobe_bin,
            "--json",
            "--quiet",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert Path(payload["union"]).is_file()
    assert len(payload["clips"]) == 5
    assert payload["loudness_lufs"] is not None


def test_cli_progress_is_a_real_growing_percentage(
    ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path, monkeypatch, capsys
):
    """La barra del panel se alimenta de esto: porcentaje medido, nunca inventado."""
    from openranks.core.progress import parse_event

    monkeypatch.setenv("OPENRANKS_WIDTH", "180")
    monkeypatch.setenv("OPENRANKS_HEIGHT", "320")
    monkeypatch.setenv("OPENRANKS_CRF", "34")
    monkeypatch.setenv("OPENRANKS_PRESET", "ultrafast")
    code = main(
        [
            "assemble",
            "--input",
            str(write_binding(synthetic_clips)),
            "--out",
            str(tmp_path / "prog"),
            "--edit",
            "--progress",
            "--quiet",
            "--ffmpeg",
            ffmpeg_bin,
            "--ffprobe",
            ffprobe_bin,
        ]
    )
    assert code == 0
    events = [parse_event(line) for line in capsys.readouterr().err.splitlines()]
    events = [event for event in events if event]

    percents = [event["percent"] for event in events]
    assert len(events) >= 8, events
    assert percents == sorted(percents), percents  # nunca hacia atrás
    assert percents[0] == 5.0  # arranca al medir los clips
    assert percents[-1] == 100.0  # y termina en el 100
    assert len(set(percents)) > 5  # granular: da para estimar el tiempo restante
    assert all(event["label"] for event in events)  # cada avance se puede leer


def test_cli_reports_bad_input(tmp_path, ffmpeg_bin, ffprobe_bin):
    broken = tmp_path / "broken.json"
    broken.write_text("{no soy json", encoding="utf-8")
    code = main(["assemble", "--input", str(broken), "--out", str(tmp_path / "out")])
    assert code == 2


def test_cli_probe_reports_a_clip(ffprobe_bin, synthetic_clips, capsys):
    code = main(["probe", str(synthetic_clips[0]), "--ffprobe", ffprobe_bin, "--json", "--check"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["width"] == 320 and payload[0]["height"] == 240
    assert payload[0]["checks"]["errors"] == []


def test_cli_probe_is_informative_without_check(ffprobe_bin, make_clip, capsys):
    # Un vídeo de 31 s no es un "clip de entrada" demasiado largo: sin --check, no juzga.
    long_clip = make_clip("largo.mp4", size=(320, 240), seconds=31.0)
    assert main(["probe", str(long_clip), "--ffprobe", ffprobe_bin, "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["duration_s"] == pytest.approx(31.0, abs=0.1)
    assert payload[0]["checks"]["errors"] == []
    # Con --check sí aplica el contrato de entrada.
    assert main(["probe", str(long_clip), "--ffprobe", ffprobe_bin, "--json", "--check"]) == 2
    payload = json.loads(capsys.readouterr().out)
    assert any("máximo por clip" in error for error in payload[0]["checks"]["errors"])


def test_module_exposes_the_assembler():
    assert callable(assemble_module.assemble)
