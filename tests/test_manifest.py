"""El manifiesto: trazabilidad completa sin rutas del host."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from openranks.core.binding import Binding, ClipItem
from openranks.core.config import Config
from openranks.core.manifest import build_manifest, sha256_file, utc_now, write_manifest
from openranks.core.media import MediaInfo
from openranks.core.plan import build_plan


def _plan():
    items = tuple(ClipItem(position=index, path=Path(f"{index}.mp4"), label=f"PUESTO {index}") for index in range(1, 6))
    infos = {
        position: MediaInfo(
            path=Path(f"{position}.mp4"),
            duration_s=6.0,
            width=1920,
            height=1080,
            fps=30.0,
            video_codec="h264",
            pix_fmt="yuv420p",
            audio_codec="aac",
            sample_rate=48000,
            channels=2,
            size_bytes=100,
        )
        for position in range(1, 6)
    }
    return build_plan(Binding(title="TOP 5 GATOS", items=items), infos, config=Config())


def test_sha256_matches_hashlib(tmp_path):
    target = tmp_path / "dato.bin"
    target.write_bytes(b"openRanks L1\n")
    assert sha256_file(target) == hashlib.sha256(b"openRanks L1\n").hexdigest()


def test_utc_now_is_parseable_isoformat():
    stamp = utc_now()
    assert datetime.fromisoformat(stamp).tzinfo is not None


def test_manifest_declares_the_editable_surface_and_the_plan():
    payload = build_manifest(
        plan=_plan(),
        sources=[{"position": 5, "file": "quinto.mp4", "sha256": "a"}],
        outputs=[{"kind": "union", "file": "union.mp4", "sha256": "b"}],
        ffmpeg_version="ffmpeg version X",
        tool_version="0.1.0",
        config=Config(),
        started_at=utc_now(),
        finished_at=utc_now(),
        total_measured_s=30.012,
        loudness_measured={"input_i": "-13.9"},
    )
    assert payload["layer"] == "L1"
    assert payload["config"]["target"] == "1080x1920"
    assert payload["plan"]["clip_count"] == 5
    assert payload["editable_surface"]["title"] == "TOP 5 GATOS"
    assert payload["measured"]["total_duration_s"] == 30.012
    assert "rutas" not in json.dumps(payload)


def test_manifest_fields_carry_only_file_names():
    plan = _plan()
    payload = build_manifest(
        plan=plan,
        sources=[{"position": 1, "file": "clip.mp4", "sha256": "a"}],
        outputs=[],
        ffmpeg_version="ffmpeg version X",
        tool_version="0.1.0",
        config=Config(),
        started_at=utc_now(),
        finished_at=utc_now(),
    )
    for entry in payload["sources"]:
        assert len(entry["file"].split("/")) == 1
        assert "\\" not in entry["file"]


def test_write_manifest_is_readable_and_keeps_accents(tmp_path):
    target = tmp_path / "sub" / "manifest.json"
    write_manifest(target, {"title": "TOP 5 GATOS ¡¡CAOS!!"})
    text = target.read_text(encoding="utf-8")
    assert text.endswith("\n")
    assert "¡¡CAOS!!" in text
    assert json.loads(text)["title"] == "TOP 5 GATOS ¡¡CAOS!!"
