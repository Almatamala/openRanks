"""Flujo por etapas con FFmpeg real: preparar al entrar, unir y solo montar la edición.

Es el camino del panel: cada clip se normaliza cuando llega (tick), la unión se hace
cuando están todos y «Montar» únicamente compone el overlay. Aquí se comprueba que
cada etapa entrega **exactamente** lo que la siguiente necesita.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from openranks.cli import main
from openranks.core.config import Config
from openranks.core.media import probe
from openranks.join import JoinError, join
from openranks.overlay import render
from openranks.prepare import prepare_clip, prepared_file, write_metadata

pytestmark = pytest.mark.integration


def _fast(**overrides) -> Config:
    settings = {"crf": 32, "preset": "ultrafast"}
    settings.update(overrides)
    return replace(Config(), **settings)


def _prepare_all(clips, out: Path, *, config: Config, ffmpeg: str, ffprobe: str) -> None:
    for position, source in zip(range(1, len(clips) + 1), clips):
        clip = prepare_clip(
            source,
            prepared_file(out, position),
            position=position,
            config=config,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
        )
        write_metadata(out, clip)


def test_prepare_leaves_the_clip_ready_before_the_join(ffmpeg_bin, ffprobe_bin, synthetic_clips, tmp_path):
    out = tmp_path / "job"
    _prepare_all(synthetic_clips, out, config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    for position in range(1, 6):
        clip = prepared_file(out, position)
        assert clip.is_file()
        # El tick del panel significa que el clip ya está en el formato final.
        info = probe(ffprobe_bin, clip)
        assert (info.width, info.height) == (1080, 1920)
        assert info.fps == pytest.approx(30, abs=0.05)
        assert info.pix_fmt == "yuv420p"
        assert info.has_audio
        # Y lo medido queda al lado, para unir sin volver a sondear la fuente.
        assert (out / "prepared" / f"{position:02d}.json").is_file()


def test_join_stitches_the_prepared_clips_and_writes_the_manifest(
    ffmpeg_bin, ffprobe_bin, synthetic_clips, tmp_path
):
    out = tmp_path / "job"
    config = _fast()
    _prepare_all(synthetic_clips, out, config=config, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    result = join(
        out,
        title="TOP 5 PRUEBAS",
        labels={position: f"PUESTO {position}" for position in range(1, 6)},
        positions=5,
        config=config,
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
    )

    info = probe(ffprobe_bin, result.union)
    assert (info.width, info.height) == (1080, 1920)
    assert info.nb_frames == 300  # 5 clips de 2 s a 30 fps, sin recodificar
    assert info.duration_s == pytest.approx(10.0, abs=0.15)

    payload = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert payload["layer"] == "L1"
    assert [segment["position"] for segment in payload["plan"]["segments"]] == [5, 4, 3, 2, 1]
    assert payload["plan"]["title"] == "TOP 5 PRUEBAS"
    assert payload["editable_surface"]["labels"]["05.mp4"] == "PUESTO 5"
    # La unión no vuelve a mirar los originales: las fuentes salen de lo medido al preparar.
    assert [source["file"] for source in payload["sources"]]


def test_join_refuses_to_run_while_a_slot_has_no_tick(ffmpeg_bin, ffprobe_bin, synthetic_clips, tmp_path):
    out = tmp_path / "job"
    _prepare_all(synthetic_clips[:3], out, config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    with pytest.raises(JoinError, match="faltan los clips preparados"):
        join(out, positions=5, config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)


def test_render_only_adds_the_overlay_on_top_of_the_join(
    ffmpeg_bin, ffprobe_bin, synthetic_clips, tmp_path
):
    out = tmp_path / "job"
    config = _fast()
    _prepare_all(synthetic_clips, out, config=config, ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    join(
        out,
        title="TOP 5 PRUEBAS",
        labels={position: f"PUESTO {position}" for position in range(1, 6)},
        positions=5,
        config=config,
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
    )
    union_bytes = (out / "union.mp4").read_bytes()

    result = render(
        out,
        title="TOP 5 DESDE EL PANEL",
        labels={1: "CIERRE"},
        config=config,
        ffmpeg=ffmpeg_bin,
        ffprobe=ffprobe_bin,
    )

    # Montar no vuelve a montar: la unión queda intacta y solo aparece el ranking.
    assert (out / "union.mp4").read_bytes() == union_bytes
    assert result.ranking.is_file()
    assert result.spec["title"]["text"] == "TOP 5 DESDE EL PANEL"
    assert {item["position"]: item["text"] for item in result.spec["clip_labels"]}[1] == "CIERRE"
    # La edición recodifica una generación: el contenedor puede arrastrar un fotograma,
    # pero la duración tiene que seguir siendo la de la unión.
    assert probe(ffprobe_bin, result.ranking).duration_s == pytest.approx(10.0, abs=0.15)
    # Sin portada: el entregable principal es el ranking final; la unión se sirve aparte.
    assert not (out / "cover.jpg").exists()


def test_cli_prepare_and_join(ffmpeg_bin, ffprobe_bin, synthetic_clips, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("OPENRANKS_WIDTH", "180")
    monkeypatch.setenv("OPENRANKS_HEIGHT", "320")
    monkeypatch.setenv("OPENRANKS_CRF", "34")
    monkeypatch.setenv("OPENRANKS_PRESET", "ultrafast")
    monkeypatch.setenv("OPENRANKS_ITEMS", "5")
    out = tmp_path / "job"

    for position, source in zip(range(1, 6), synthetic_clips):
        code = main(
            [
                "prepare",
                "--input",
                str(source),
                "--out",
                str(out),
                "--position",
                str(position),
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
        assert Path(payload["file"]).is_file()

    code = main(
        [
            "join",
            "--out",
            str(out),
            "--title",
            "TOP 5 PRUEBAS",
            "--label",
            "1=CIERRE",
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
    assert payload["total_duration_s"] == pytest.approx(10.0, abs=0.2)
    assert probe(ffprobe_bin, Path(payload["union"])).nb_frames == 300


def test_cli_join_without_every_tick_is_bad_input(ffmpeg_bin, ffprobe_bin, tmp_path, capsys):
    code = main(["join", "--out", str(tmp_path / "vacio"), "--ffmpeg", ffmpeg_bin, "--ffprobe", ffprobe_bin])
    assert code == 2
    assert "faltan los clips preparados" in capsys.readouterr().err
