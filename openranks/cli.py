"""Interfaz de línea de comandos de L1.

    python -m openranks assemble --input binding.json --out out/run1
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

from . import TOOL_VERSION
from .assemble import AssemblyError, assemble
from .core.binding import BindingError, load_binding
from .core.config import Config
from .core.ffmpeg import ToolNotFound
from .core.plan import PlanError
from .core.progress import PROGRESS_PREFIX, ProgressEvent
from .core.runner import ToolError
from .core.specs import MAX_POSITIONS, MIN_POSITIONS
from .overlay import OverlayError, preview, render

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BAD_INPUT = 2


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="openranks",
        description="openRanks — L1: los clips del ranking y su unión en un solo vídeo vertical",
    )
    parser.add_argument("--version", action="version", version=f"openranks {TOOL_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    assembly = subparsers.add_parser(
        "assemble", help="normaliza los clips del ranking (5 a 10) y los une en vertical con corte seco"
    )
    assembly.add_argument("--input", required=True, help="binding JSON: {title, items:[{position,path,label}]}")
    assembly.add_argument("--out", required=True, help="directorio de salida (clips/, union.mp4, manifest.json)")
    assembly.add_argument(
        "--items",
        type=int,
        choices=range(MIN_POSITIONS, MAX_POSITIONS + 1),
        default=None,
        help="puestos del ranking, de 5 a 10 (por defecto 5; el panel lo fija por trabajo)",
    )
    assembly.add_argument(
        "--fit",
        choices=("auto", "band", "contain", "cover"),
        default=None,
        help="auto (por defecto) detecta el área útil y recorta el fondo borroso; band agranda hasta la banda "
        "central de 1184 px y recorta laterales; contain lo encaja entero sin recortar; cover recorta para llenar todo el marco",
    )
    assembly.add_argument("--cold-open-seconds", type=float, default=0.0, help="adelanto del #1 al principio; 0 = desactivado (por defecto)")
    assembly.add_argument("--edit", action="store_true", help="encadena L2: añade la edición del estándar (ranking.mp4 + cover)")
    assembly.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    assembly.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    assembly.add_argument(
        "--progress",
        action="store_true",
        help="emite el avance en porcentaje real por stderr (lo consume el panel para la barra y el tiempo restante)",
    )
    assembly.add_argument("--json", action="store_true", help="salida legible por máquina")
    assembly.add_argument("--quiet", action="store_true", help="sin progreso")

    render_cmd = subparsers.add_parser(
        "render",
        help="L2 solo: re-compone la edición sobre un union.mp4 ya ensamblado (segundos, no minutos)",
    )
    render_cmd.add_argument("--dir", required=True, help="directorio que ya produjo `assemble` (con union.mp4 y manifest.json)")
    render_cmd.add_argument("--input", default=None, help="binding JSON opcional del que tomar los textos (título y nombres)")
    render_cmd.add_argument("--title", default=None, help="sobrescribe el título del vídeo")
    render_cmd.add_argument(
        "--label",
        action="append",
        default=None,
        metavar="POS=TEXTO",
        help="sobrescribe el nombre de un puesto (repetible), p. ej. --label 1=GATO VOLADOR",
    )
    render_cmd.add_argument("--font", default=None, help="familia tipográfica del overlay (por defecto Arial)")
    render_cmd.add_argument(
        "--italic",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="letras cursivas en el overlay (por defecto, lo que diga el preset)",
    )
    render_cmd.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    render_cmd.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    render_cmd.add_argument("--progress", action="store_true", help="emite el avance en porcentaje real por stderr")
    render_cmd.add_argument("--json", action="store_true", help="salida legible por máquina")
    render_cmd.add_argument("--quiet", action="store_true", help="sin progreso")

    preview_cmd = subparsers.add_parser(
        "preview",
        help="vista previa del overlay sobre fondo negro (PNG), sin clips ni vídeo montado",
    )
    preview_cmd.add_argument("--out", required=True, help="ruta del PNG de salida")
    preview_cmd.add_argument("--title", default="", help="título a dibujar")
    preview_cmd.add_argument(
        "--label",
        action="append",
        default=None,
        metavar="POS=TEXTO",
        help="nombre de un puesto (repetible), p. ej. --label 1=GATO VOLADOR",
    )
    preview_cmd.add_argument("--font", default=None, help="familia tipográfica del overlay")
    preview_cmd.add_argument(
        "--italic",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="letras cursivas en el overlay (por defecto, lo que diga el preset)",
    )
    preview_cmd.add_argument(
        "--items",
        type=int,
        choices=range(MIN_POSITIONS, MAX_POSITIONS + 1),
        default=None,
        help="puestos que dibuja la vista previa, de 5 a 10 (por defecto 5)",
    )
    preview_cmd.add_argument("--at", type=float, default=None, help="segundo del fotograma (por defecto, el final)")
    preview_cmd.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    preview_cmd.add_argument("--json", action="store_true", help="salida legible por máquina (la usa el panel)")

    preset = subparsers.add_parser(
        "preset",
        help="enseña los ajustes de la plantilla de la edición (L2) y dónde se cambian",
    )
    preset.add_argument("--json", action="store_true", help="salida legible por máquina (la usa el panel)")

    probe = subparsers.add_parser("probe", help="inspecciona archivos con ffprobe")
    probe.add_argument("files", nargs="+")
    probe.add_argument("--ffprobe", default=None)
    probe.add_argument("--json", action="store_true")
    probe.add_argument(
        "--check",
        action="store_true",
        help="aplica el contrato de clip de entrada (duración máxima, lado corto, ...) y devuelve 2 si falla",
    )

    fit = subparsers.add_parser(
        "fit",
        help="analiza el encuadre de un clip y devuelve el crop y la confianza en JSON",
    )
    fit.add_argument("file", help="clip de entrada a analizar")
    fit.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    fit.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    return parser


def _progress_sink() -> "callable[[ProgressEvent], None]":
    """Reporter que escribe una línea JSON por evento en **stderr**.

    En stderr para que stdout siga siendo solo el resultado (`--json`) y para que el
    panel pueda separarlo de los avisos de FFmpeg por el prefijo.
    """

    def _emit(event: ProgressEvent) -> None:
        print(PROGRESS_PREFIX + json.dumps(event.to_json(), ensure_ascii=False), file=sys.stderr, flush=True)

    return _emit


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
    if args.command == "fit":
        return _run_fit(args)
    if args.command == "render":
        return _run_render(args)
    if args.command == "preset":
        return _run_preset(args)
    if args.command == "preview":
        return _run_preview(args)
    return _run_assemble(args)


def _run_preset(args: argparse.Namespace) -> int:
    """Listado de los ajustes del preset bloqueado (ADR-8): qué es cada uno y dónde vive."""
    from .core.overlay import (
        EDITABLE_SECTIONS,
        EDITABLE_TOP_LEVEL,
        FONT_FAMILIES,
        FONT_NOTES,
        describe_style,
        get_style,
    )

    style = get_style()
    rows = describe_style(style)
    if args.json:
        print(
            json.dumps(
                {
                    "preset": style.get("theme"),
                    "font": style.get("font"),
                    "where": "openranks/core/overlay.py (DEFAULT_STYLE) · openranks/core/specs.py (RANK_COLORS)",
                    "settings": rows,
                    # Lo que el panel puede cambiar y guardar, ya resuelto.
                    "editable": {
                        "font": style.get("font"),
                        "italic": bool(style.get("italic", False)),
                        "title": {
                            "size": style["title"]["size"],
                            "background": bool(style["title"]["background"]),
                        },
                        "rank_ladder": {
                            "size": style["rank_ladder"]["size"],
                            "x": style["rank_ladder"]["x"],
                            "y_top": style["rank_ladder"]["y_top"],
                            "y_bottom": style["rank_ladder"]["y_bottom"],
                        },
                    },
                    # Familias que ofrece el panel, con la nota de cada una.
                    "fonts": list(FONT_FAMILIES),
                    "font_notes": dict(FONT_NOTES),
                    "editable_keys": {
                        "top": list(EDITABLE_TOP_LEVEL),
                        **{section: list(keys) for section, keys in EDITABLE_SECTIONS.items()},
                    },
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return EXIT_OK

    group = None
    for row in rows:
        if row["group"] != group:
            group = row["group"]
            print(f"\n{group}")
            print(f"  {row['where']}")
        print(f"  {row['key']:<26} {row['value']}")
    return EXIT_OK


def _run_preview(args: argparse.Namespace) -> int:
    """Vista previa del preset sobre negro: no monta nada, solo dibuja el overlay."""
    config = _config_with_items(Config.from_env(), args.items)
    try:
        labels = _parse_label_overrides(args.label)
        result = preview(
            args.out,
            title=args.title or "",
            labels=labels or None,
            style_overrides=_style_overrides(args.italic),
            font=args.font,
            at_s=args.at,
            config=config,
            ffmpeg=args.ffmpeg,
        )
    except BindingError as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except (OverlayError, ToolError, ToolNotFound) as exc:
        print(f"fallo la vista previa: {exc}", file=sys.stderr)
        return EXIT_FAILED

    if args.json:
        print(
            json.dumps(
                {
                    "path": str(result.path),
                    "at_s": result.at_s,
                    "preset": result.spec.get("preset"),
                    "total_duration_s": result.spec["total_duration_s"],
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(result.summary())
    return EXIT_OK


def _run_assemble(args: argparse.Namespace) -> int:
    config = _config_with_items(Config.from_env(), args.items)
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
            cold_open_s=args.cold_open_seconds,
            edit=args.edit,
            log=say,
            progress=_progress_sink() if args.progress else None,
        )
    except (BindingError, PlanError) as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except (AssemblyError, ToolError, ToolNotFound) as exc:
        print(f"fallo el ensamblado: {exc}", file=sys.stderr)
        return EXIT_FAILED

    if args.json:
        payload = {
            "out_dir": str(result.out_dir),
            "clips": [str(path) for path in result.clips],
            "union": str(result.union),
            "manifest": str(result.manifest_path),
            "total_duration_s": result.total_measured_s,
            "loudness_lufs": result.loudness.get("input_i"),
            "warnings": list(result.warnings),
        }
        if result.overlay is not None:
            payload.update(
                {
                    "ranking": str(result.overlay.ranking),
                    "cover": None if result.overlay.cover is None else str(result.overlay.cover),
                    "spec": str(result.overlay.spec_path),
                }
            )
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(result.summary())
    return EXIT_OK


def _config_with_items(config: Config, items: int | None) -> Config:
    """El CLI fija los puestos del ranking sin tocar el entorno (`--items`)."""
    if items is None or items == config.items:
        return config
    return replace(config, items=items)


def _style_overrides(italic: bool | None) -> dict | None:
    """`--italic` / `--no-italic`: un ajuste suelto del preset, sin tocar el archivo."""
    return None if italic is None else {"italic": italic}


def _parse_label_overrides(raw: list[str] | None) -> dict[int, str]:
    labels: dict[int, str] = {}
    for entry in raw or []:
        position, _, text = entry.partition("=")
        if not _:
            raise BindingError(f"--label espera POS=TEXTO y llegó {entry!r}")
        try:
            labels[int(position)] = text
        except ValueError as exc:
            raise BindingError(f"--label con posición no numérica: {position!r}") from exc
    return labels


def _run_render(args: argparse.Namespace) -> int:
    """L2 solo: cambia textos o rehace la edición sin volver a montar el vídeo."""
    config = Config.from_env()
    say = (lambda _: None) if args.quiet else (lambda message: print(message, flush=True))
    try:
        labels = _parse_label_overrides(args.label)
        title = args.title
        if args.input:
            binding = load_binding(args.input, config)
            title = title if title is not None else binding.title
            for item in binding.items:
                labels.setdefault(item.position, item.label)
        result = render(
            args.dir,
            title=title,
            labels=labels or None,
            style_overrides=_style_overrides(args.italic),
            font=args.font,
            config=config,
            ffmpeg=args.ffmpeg,
            ffprobe=args.ffprobe,
            log=say,
            progress=_progress_sink() if args.progress else None,
        )
    except BindingError as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except (OverlayError, ToolError, ToolNotFound) as exc:
        print(f"fallo el render: {exc}", file=sys.stderr)
        return EXIT_FAILED

    if args.json:
        print(
            json.dumps(
                {
                    "ranking": str(result.ranking),
                    "cover": None if result.cover is None else str(result.cover),
                    "spec": str(result.spec_path),
                    "total_duration_s": result.spec["total_duration_s"],
                    "warnings": list(result.warnings),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(result.summary())
    return EXIT_OK


def _run_fit(args: argparse.Namespace) -> int:
    """Analiza el encuadre de un clip. La salida es **solo** el JSON pedido."""
    from .core import ffmpeg as ff
    from .core.framing import FramingError, needs_analysis
    from .core.media import probe
    from .framing import analyze, decision_payload

    config = Config.from_env()
    path = Path(args.file)
    try:
        ffprobe_bin = ff.resolve_binary(args.ffprobe, "OPENRANKS_FFPROBE", "ffprobe")
        info = probe(ffprobe_bin, path)
    except (RuntimeError, ToolNotFound) as exc:
        print(f"no se pudo leer {path.name}: {exc}", file=sys.stderr)
        return EXIT_FAILED

    width, height = info.visible_size
    if not width or not height or not info.video_codec:
        print(f"{path.name} no tiene una pista de vídeo con resolución legible", file=sys.stderr)
        return EXIT_BAD_INPUT

    ffmpeg_bin = ""
    try:
        if needs_analysis((width, height), config.total):
            ffmpeg_bin = ff.resolve_binary(args.ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
        decision = analyze(ffmpeg_bin, path, info, config=config)
        payload = decision_payload(decision, source=path, info=info, config=config)
    except (FramingError, OSError) as exc:
        print(f"no se pudo analizar el encuadre: {exc}", file=sys.stderr)
        return EXIT_FAILED
    except ToolNotFound as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_FAILED

    print(json.dumps(payload, indent=2, ensure_ascii=False))
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
