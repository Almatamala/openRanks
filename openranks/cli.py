"""Interfaz de línea de comandos de L1.

    python -m openranks assemble --input binding.json --out out/run1
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import TOOL_VERSION
from .assemble import AssemblyError, assemble
from .core.binding import BindingError, load_binding
from .core.config import Config
from .core.ffmpeg import TRANSITIONS, ToolNotFound, TransitionError
from .core.plan import PlanError
from .core.runner import ToolError

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BAD_INPUT = 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openranks",
        description="openRanks — L1: 5 clips listos y su unión en un solo vídeo vertical",
    )
    parser.add_argument("--version", action="version", version=f"openranks {TOOL_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    assembly = subparsers.add_parser("assemble", help="normaliza los 5 clips y los une en vertical")
    assembly.add_argument("--input", required=True, help="binding JSON: {title, items:[{position,path,label}]}")
    assembly.add_argument("--out", required=True, help="directorio de salida (clips/, union.mp4, manifest.json)")
    assembly.add_argument("--fit", choices=("cover", "contain"), default="cover", help="cover recorta, contain añade barras")
    assembly.add_argument("--transition-seconds", type=float, default=0.0, help="solape entre clips (0 = corte seco, unión por copia)")
    assembly.add_argument("--transition", choices=TRANSITIONS, default="slideup", help="tipo de transición si hay solape")
    assembly.add_argument("--cold-open-seconds", type=float, default=0.0, help="adelanto del #1 al principio (B1 del plan); 0 = desactivado")
    assembly.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    assembly.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    assembly.add_argument("--json", action="store_true", help="salida legible por máquina")
    assembly.add_argument("--quiet", action="store_true", help="sin progreso")

    probe = subparsers.add_parser("probe", help="inspecciona archivos con ffprobe")
    probe.add_argument("files", nargs="+")
    probe.add_argument("--ffprobe", default=None)
    probe.add_argument("--json", action="store_true")
    probe.add_argument(
        "--check",
        action="store_true",
        help="aplica el contrato de clip de entrada (duración máxima, lado corto, ...) y devuelve 2 si falla",
    )
    return parser


def _configure_output() -> None:
    """Evita que la consola mate el programa.

    En Windows el stdout por defecto es cp1252 y cualquier carácter no representable
    (una flecha, un rótulo con acentos) lanzaba ``UnicodeEncodeError``. Se fuerza UTF-8
    con reemplazo en vez de dejarlo al criterio del terminal.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover - stream ya cerrado o no soportado
            continue


def main(argv: list[str] | None = None) -> int:
    _configure_output()
    args = _build_parser().parse_args(argv)
    if args.command == "probe":
        return _run_probe(args)
    return _run_assemble(args)


def _run_assemble(args: argparse.Namespace) -> int:
    config = Config.from_env()
    say = (lambda _: None) if args.quiet else (lambda message: print(message, flush=True))
    try:
        binding = load_binding(args.input, config)
        result = assemble(
            binding,
            args.out,
            config=config,
            ffmpeg=args.ffmpeg,
            ffprobe=args.ffprobe,
            fit=args.fit,
            transition_s=args.transition_seconds,
            transition=args.transition,
            cold_open_s=args.cold_open_seconds,
            log=say,
        )
    except (BindingError, PlanError) as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except (AssemblyError, ToolError, ToolNotFound, TransitionError) as exc:
        print(f"fallo el ensamblado: {exc}", file=sys.stderr)
        return EXIT_FAILED

    if args.json:
        print(
            json.dumps(
                {
                    "out_dir": str(result.out_dir),
                    "clips": [str(path) for path in result.clips],
                    "union": str(result.union),
                    "manifest": str(result.manifest_path),
                    "total_duration_s": result.total_measured_s,
                    "loudness_lufs": result.loudness.get("input_i"),
                    "warnings": list(result.warnings),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(result.summary())
    return EXIT_OK


def _run_probe(args: argparse.Namespace) -> int:
    """Inspección informativa.

    Por defecto **no** juzga: un ``union.mp4`` de 35 s es una salida legítima y no un
    "clip de entrada" demasiado largo. Con ``--check`` sí aplica el contrato de entrada.
    """
    from .core import ffmpeg as ff
    from .core.media import Check, probe, validate_ready_clip

    config = Config.from_env()
    try:
        ffprobe_bin = ff.resolve_binary(args.ffprobe, "OPENRANKS_FFPROBE", "ffprobe")
    except ToolNotFound as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_FAILED

    payload = []
    failed = False
    for raw in args.files:
        path = Path(raw)
        try:
            info = probe(ffprobe_bin, path)
        except RuntimeError as exc:
            print(f"no se pudo leer {path.name}: {exc}", file=sys.stderr)
            return EXIT_FAILED
        check = validate_ready_clip(info, config) if args.check else Check()
        failed = failed or not check.ok
        payload.append(
            {
                **info.to_source_entry(position=0, sha256=""),
                "path": str(path),
                "checks": {"errors": list(check.errors), "warnings": list(check.warnings)},
            }
        )

    if args.json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        for entry in payload:
            print(f"{entry['path']}: {entry['width']}x{entry['height']} {entry['duration_s']}s audio={entry['has_audio']}")
            for problem in entry["checks"]["errors"]:
                print(f"  error: {problem}")
            for warning in entry["checks"]["warnings"]:
                print(f"  aviso: {warning}")
    return EXIT_BAD_INPUT if failed else EXIT_OK


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
