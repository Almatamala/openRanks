"""Integración real de L2: la edición del estándar sobre la unión de L1.

Comprueba el criterio de §9.4 (``ranking.mp4`` 1080x1920 con overlay y ``spec.json``,
sin portada: el único entregable es el vídeo final) y que el overlay **dibuja de
verdad**: sin texto, la edición no existe aunque el MP4 sea válido.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from openranks.assemble import assemble
from openranks.core.binding import load_binding
from openranks.core.config import Config
from openranks.core.media import probe
from openranks.overlay import OverlayError, preview, render

pytestmark = pytest.mark.integration


def _fast(**overrides) -> Config:
    settings = {"crf": 32, "preset": "ultrafast"}
    settings.update(overrides)
    return replace(Config(), **settings)


def _region(ffmpeg_bin: str, video: Path, *, at_s: float, crop: str, out: Path) -> bytes:
    """Luma de una región del fotograma, en crudo, para poder comparar."""
    subprocess.run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{at_s}",
            "-i",
            str(video),
            "-vf",
            f"crop={crop},format=gray",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-y",
            str(out),
        ],
        check=True,
        capture_output=True,
    )
    return out.read_bytes()


@pytest.fixture()
def l1_out(ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path) -> Path:
    """Una salida de L1 ya hecha (union.mp4 + manifest.json)."""
    binding = load_binding(write_binding(synthetic_clips), _fast())
    out = tmp_path / "out"
    assemble(binding, out, config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
    return out


def test_assemble_with_edit_produces_the_ranking_without_a_cover(
    ffmpeg_bin, ffprobe_bin, synthetic_clips, write_binding, tmp_path
):
    binding = load_binding(write_binding(synthetic_clips, title="TOP 5 GATOS"), _fast())
    result = assemble(binding, tmp_path / "out", config=_fast(), ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin, edit=True)

    assert result.overlay is not None
    ranking = result.overlay.ranking
    assert ranking.is_file() and result.overlay.spec_path.is_file()
    # El único entregable es el ranking final: ni portada ni fotogramas sueltos.
    assert not (tmp_path / "out" / "cover.jpg").exists()

    info = probe(ffprobe_bin, ranking)
    assert (info.width, info.height) == (1080, 1920)
    assert info.fps == pytest.approx(30, abs=0.05)
    assert info.pix_fmt == "yuv420p"
    assert info.has_audio
    # El overlay no cambia la duración: 5 clips de 2 s = 10 s.
    assert info.duration_s == pytest.approx(10.0, abs=0.15)

    # El manifiesto gana el bloque de L2 y el spec dice que solo el texto es editable.
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest["render"]["layer"] == "L2"
    assert manifest["render"]["ranking"]["file"] == "ranking.mp4"
    spec = json.loads(result.overlay.spec_path.read_text(encoding="utf-8"))
    assert spec["editable_surface"]["fields"] == ["title", "subtitle", "labels"]
    assert spec["title"]["text"] == "TOP 5 GATOS"


def test_the_overlay_actually_draws_text(ffmpeg_bin, l1_out, tmp_path):
    """Un MP4 válido no basta: la región del título tiene que cambiar de verdad."""
    render(l1_out, title="TOP 5 GATOS", ffmpeg=ffmpeg_bin, config=_fast())
    region = "700:170:190:80"

    before = _region(ffmpeg_bin, l1_out / "union.mp4", at_s=1.0, crop=region, out=tmp_path / "union.raw")
    after = _region(ffmpeg_bin, l1_out / "ranking.mp4", at_s=1.0, crop=region, out=tmp_path / "ranking.raw")

    assert len(before) == len(after) > 0
    # El título lleva trazo negro y relleno blanco: muchos píxeles cambian a lo bruto.
    changed = sum(1 for left, right in zip(before, after) if abs(left - right) > 60)
    assert changed > 200, f"el overlay no parece haber dibujado texto ({changed} píxeles cambiados)"


def test_render_rewrites_only_the_overlay_with_the_new_texts(ffmpeg_bin, l1_out, tmp_path):
    first = render(l1_out, ffmpeg=ffmpeg_bin, config=_fast())
    assert first.spec["title"]["text"] == "TOP 5 PRUEBAS"

    # Cambiar textos no vuelve a tocar el montaje: union.mp4 sigue siendo el mismo.
    union_before = (l1_out / "union.mp4").read_bytes()
    second = render(
        l1_out,
        title="TOP 3 CAOS",
        labels={1: "GATO FINAL", 5: "PERRO LOCO"},
        ffmpeg=ffmpeg_bin,
        config=_fast(),
    )
    assert (l1_out / "union.mp4").read_bytes() == union_before
    assert second.spec["title"]["text"] == "TOP 3 CAOS"
    labels = {item["position"]: item["text"] for item in second.spec["clip_labels"]}
    assert labels[1] == "GATO FINAL" and labels[5] == "PERRO LOCO"
    assert second.spec["rank_ladder"]["slots"][-1]["color"] == "#D4AF37"


def test_render_requires_a_union(ffmpeg_bin, tmp_path):
    with pytest.raises(OverlayError, match="union.mp4"):
        render(tmp_path / "vacio", ffmpeg=ffmpeg_bin, config=_fast())


def test_preview_draws_the_preset_over_black_without_any_clip(ffmpeg_bin, tmp_path):
    """La vista previa no necesita clips: dibuja el preset sobre negro y se ve."""
    result = preview(
        tmp_path / "preview.png",
        title="TOP *5* _GATOS_",
        labels={1: "GATO VOLADOR"},
        ffmpeg=ffmpeg_bin,
        config=_fast(),
    )
    assert result.path.is_file()
    assert result.path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    raw = tmp_path / "preview.raw"
    subprocess.run(
        [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-i", str(result.path), "-vf", "format=gray", "-f", "rawvideo", "-y", str(raw)],
        check=True,
        capture_output=True,
    )
    pixels = raw.read_bytes()
    # Sobre negro, si el overlay no se dibujara no habría ni un píxel encendido.
    assert len(pixels) > 0 and max(pixels) > 0


def test_preview_cli_reports_the_real_title_height_band(ffmpeg_bin, tmp_path, capsys):
    """El panel limita el deslizador de altura a la banda que publica el motor."""
    from openranks.cli import main

    code = main(
        [
            "preview",
            "--out",
            str(tmp_path / "preview.png"),
            "--title",
            "TOP 5 MOMENTOS",
            "--ffmpeg",
            ffmpeg_bin,
            "--json",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    band = payload["title_y"]
    assert band["min"] < band["max"]
    assert band["min"] >= 96


def test_render_cli_updates_the_texts(ffmpeg_bin, ffprobe_bin, l1_out, capsys):
    from openranks.cli import main

    code = main(
        [
            "render",
            "--dir",
            str(l1_out),
            "--title",
            "TOP 5 DESDE CLI",
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
    assert Path(payload["ranking"]).is_file()
    spec = json.loads((l1_out / "spec.json").read_text(encoding="utf-8"))
    assert spec["title"]["text"] == "TOP 5 DESDE CLI"
    assert {item["position"]: item["text"] for item in spec["clip_labels"]}[1] == "CIERRE"
