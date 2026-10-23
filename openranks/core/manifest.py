"""Manifiesto del render: trazabilidad sin filtrar rutas del host.

Regla de repositorio público (RPD §17.1): el manifiesto guarda **nombres** de archivo
y hashes, nunca rutas absolutas.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_file(path: str | Path, *, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def build_manifest(
    *,
    plan,
    sources: list[dict],
    outputs: list[dict],
    ffmpeg_version: str,
    tool_version: str,
    config,
    started_at: str,
    finished_at: str,
    total_measured_s: float | None = None,
    loudness_measured: dict | None = None,
) -> dict:
    """Ensambla el manifiesto. ``plan`` es un ``AssemblyPlan`` (duck-typed)."""
    return {
        "tool": "openRanks",
        "tool_version": tool_version,
        "layer": "L1",
        "started_at": started_at,
        "finished_at": finished_at,
        "ffmpeg": ffmpeg_version,
        "config": config.to_manifest(),
        "plan": plan.to_manifest(),
        "editable_surface": {
            "title": plan.title,
            "subtitle": getattr(plan, "subtitle", ""),
            "labels": {segment.output_name: segment.label for segment in plan.segments},
            "note": "(ADR-8) lo único editable es el título, el subtítulo opcional y el nombre de los puestos; el render es automático",
        },
        "sources": sources,
        "outputs": outputs,
        "measured": {
            "total_duration_s": None if total_measured_s is None else round(total_measured_s, 3),
            "loudness": loudness_measured or {},
        },
    }


def write_manifest(path: str | Path, payload: dict) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target
