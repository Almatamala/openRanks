"""Genera clips sintéticos + un binding para probar L1 a mano.

    python scripts/make_test_clips.py --out demo --seconds 7
    python scripts/make_test_clips.py --out demo10 --positions 7 --seconds 6

Con los defectos (5 clips de 7 s) el total cae dentro del objetivo de 30–58 s. Con
`--positions` se puede montar cualquier ranking del formato, del TOP 5 al TOP 10.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openranks.core.ffmpeg import ToolNotFound, resolve_binary  # noqa: E402
from openranks.core.specs import MAX_POSITIONS, MIN_POSITIONS  # noqa: E402


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

# Formas de clip: horizontal, vertical, cuadrado sin audio, ancho y grande.
SPECS = (
    ((320, 240), 440),
    ((240, 320), 330),
    ((320, 320), None),  # sin audio: prueba la inyección de silencio
    ((640, 360), 550),
    ((480, 480), 660),
)

LABELS = ("GATO VOLADOR", "PERRO CAOS", "SORPRESA", "ROBO", "TERNERA")


def clip_plan(count: int) -> list[tuple[str, tuple[int, int], int | None, str]]:
    """`count` clips: las cinco formas de siempre y, si el ranking es más largo, se repiten.

    Los nombres de los cinco primeros puestos son los de siempre; del 6 en adelante se
    numeran (`PUESTO 6`) para no repetir etiquetas.
    """
    plan: list[tuple[str, tuple[int, int], int | None, str]] = []
    for index in range(1, count + 1):
        size, freq = SPECS[(index - 1) % len(SPECS)]
        label = LABELS[index - 1] if index <= len(LABELS) else f"PUESTO {index}"
        plan.append((f"clip-{index}.mp4", size, freq, label))
    return plan


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
    parser.add_argument(
        "--positions", type=int, choices=range(MIN_POSITIONS, MAX_POSITIONS + 1), default=5, help="puestos del ranking"
    )
    parser.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    args = parser.parse_args(argv)

    ffmpeg = _resolve_ffmpeg(args.ffmpeg)
    out = Path(args.out)
    clips_dir = out / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    items = []
    for index, (name, size, freq, label) in enumerate(clip_plan(args.positions), start=1):
        path = clips_dir / name
        make_clip(ffmpeg, path, size=size, seconds=args.seconds, freq=freq)
        items.append({"position": index, "path": f"clips/{name}", "label": label})
        print(f"  creado {path.relative_to(out).as_posix()} ({size[0]}x{size[1]}, {args.seconds}s)")

    binding_path = out / "binding.json"
    binding_path.write_text(
        json.dumps({"title": f"TOP {args.positions} PRUEBAS", "items": items}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\nbinding: {binding_path}")
    print(
        f"prueba:  python -m openranks prepare --input {clips_dir / 'clip-1.mp4'} "
        f"--out {out / 'render'} --position 1 --items {args.positions}"
    )
    print(
        "         (repite con cada clip y su puesto) y luego: "
        f"python -m openranks join --out {out / 'render'} --items {args.positions}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
