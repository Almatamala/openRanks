"""Genera 5 clips sintéticos + un binding para probar L1 a mano.

    python scripts/make_test_clips.py --out demo --seconds 7

Con los defectos (5 clips de 7 s) el total cae dentro del objetivo de 30–58 s.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openranks.core.ffmpeg import ToolNotFound, resolve_binary  # noqa: E402


def _resolve_ffmpeg(explicit: str | None) -> str:
    """Como el producto, pero con el ffmpeg estático de desarrollo como red de seguridad."""
    try:
        return resolve_binary(explicit, "OPENRANKS_FFMPEG", "ffmpeg")
    except ToolNotFound:
        pass
    try:  # ffmpeg estático dentro del repo (extra de desarrollo)
        import static_ffmpeg

        static_ffmpeg.add_paths()
    except Exception as exc:  # pragma: no cover - entorno sin la dependencia
        raise SystemExit(
            "No hay ffmpeg. Instálalo en el PATH, define OPENRANKS_FFMPEG, "
            "o ejecuta: pip install static-ffmpeg && python -c \"import static_ffmpeg; static_ffmpeg.add_paths()\""
        ) from exc
    return resolve_binary(explicit, "OPENRANKS_FFMPEG", "ffmpeg")

SPECS = (
    ("clip-1.mp4", (320, 240), 440, "GATO VOLADOR"),
    ("clip-2.mp4", (240, 320), 330, "PERRO CAOS"),
    ("clip-3.mp4", (320, 320), None, "SORPRESA"),
    ("clip-4.mp4", (640, 360), 550, "ROBO"),
    ("clip-5.mp4", (480, 480), 660, "TERNERA"),
)


def make_clip(ffmpeg: str, path: Path, *, size: tuple[int, int], seconds: float, freq: int | None) -> None:
    argv = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"testsrc2=size={size[0]}x{size[1]}:rate=30",
    ]
    if freq is None:
        argv += ["-an"]
    else:
        argv += ["-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate=44100", "-map", "0:v:0", "-map", "1:a:0"]
    argv += ["-t", f"{seconds}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"]
    if freq is not None:
        argv += ["-c:a", "aac", "-b:a", "128k"]
    argv += [str(path)]
    subprocess.run(argv, check=True, capture_output=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Clips sintéticos para probar openRanks L1")
    parser.add_argument("--out", default="demo", help="directorio de salida")
    parser.add_argument("--seconds", type=float, default=7.0, help="duración de cada clip")
    parser.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    args = parser.parse_args(argv)

    ffmpeg = _resolve_ffmpeg(args.ffmpeg)
    out = Path(args.out)
    clips_dir = out / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    items = []
    for index, (name, size, freq, label) in enumerate(SPECS, start=1):
        path = clips_dir / name
        make_clip(ffmpeg, path, size=size, seconds=args.seconds, freq=freq)
        items.append({"position": index, "path": f"clips/{name}", "label": label})
        print(f"  creado {path.relative_to(out).as_posix()} ({size[0]}x{size[1]}, {args.seconds}s)")

    binding_path = out / "binding.json"
    binding_path.write_text(
        json.dumps({"title": "TOP 5 PRUEBAS", "items": items}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\nbinding: {binding_path}")
    print(f"prueba:  python -m openranks assemble --input {binding_path} --out {out / 'render'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
