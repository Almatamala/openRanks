"""Interfaz de línea de comandos del motor.

    python -m openranks prepare --input clip.mp4 --out out/run1 --position 1
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace

from . import TOOL_VERSION
from .core.binding import BindingError, load_binding
from .core.config import Config
from .core.ffmpeg import ToolNotFound
from .core.plan import PlanError
from .core.progress import PROGRESS_PREFIX, SPAN_PREPARE, Progress, ProgressEvent
from .core.runner import ToolError
from .core.specs import MAX_POSITIONS, MIN_POSITIONS
from .join import JoinError, join
from .overlay import OverlayError, preview, render
from .prepare import PrepareError, prepare_clip, prepared_file, write_metadata

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

    prepare_cmd = subparsers.add_parser(
        "prepare",
        help="prepara **un** clip al entrar (encuadre + 1080x1920 + audio): deja el tick listo",
    )
    prepare_cmd.add_argument("--input", required=True, help="clip de entrada ya listo para el ranking")
    prepare_cmd.add_argument("--out", required=True, help="directorio del trabajo (deja prepared/NN.mp4 y NN.json)")
    prepare_cmd.add_argument(
        "--position",
        type=int,
        required=True,
        choices=range(1, MAX_POSITIONS + 1),
        help="puesto del ranking al que pertenece el clip",
    )
    prepare_cmd.add_argument(
        "--items",
        type=int,
        choices=range(MIN_POSITIONS, MAX_POSITIONS + 1),
        default=None,
        help="puestos del ranking, de 5 a 10 (por defecto 5; el panel lo fija por trabajo)",
    )
    prepare_cmd.add_argument(
        "--fit",
        choices=("auto", "band", "contain", "cover"),
        default=None,
        help="auto (por defecto) detecta el área útil; band/contain/cover son elecciones explícitas",
    )
    prepare_cmd.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    prepare_cmd.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    prepare_cmd.add_argument("--progress", action="store_true", help="emite el avance en porcentaje real por stderr")
    prepare_cmd.add_argument("--json", action="store_true", help="salida legible por máquina")
    prepare_cmd.add_argument("--quiet", action="store_true", help="sin progreso")

    join_cmd = subparsers.add_parser(
        "join",
        help="une los clips ya preparados en union.mp4 (sin recodificar ni volver a mirar los originales)",
    )
    join_cmd.add_argument("--out", required=True, help="directorio del trabajo con prepared/NN.mp4")
    join_cmd.add_argument(
        "--items",
        type=int,
        choices=range(MIN_POSITIONS, MAX_POSITIONS + 1),
        default=None,
        help="puestos del ranking, de 5 a 10 (por defecto 5; el panel lo fija por trabajo)",
    )
    join_cmd.add_argument("--title", default="", help="título del vídeo (queda en el manifiesto; L2 lo puede cambiar)")
    join_cmd.add_argument("--subtitle", default="", help="subtítulo opcional")
    join_cmd.add_argument(
        "--label",
        action="append",
        default=None,
        metavar="POS=TEXTO",
        help="nombre de un puesto (repetible), p. ej. --label 1=GATO VOLADOR",
    )
    join_cmd.add_argument("--ffmpeg", default=None, help="ruta explícita a ffmpeg")
    join_cmd.add_argument("--ffprobe", default=None, help="ruta explícita a ffprobe")
    join_cmd.add_argument("--progress", action="store_true", help="emite el avance en porcentaje real por stderr")
    join_cmd.add_argument("--json", action="store_true", help="salida legible por máquina")
    join_cmd.add_argument("--quiet", action="store_true", help="sin progreso")

    render_cmd = subparsers.add_parser(
        "render",
        help="L2 solo: re-compone la edición sobre un union.mp4 ya ensamblado (segundos, no minutos)",
    )
    render_cmd.add_argument("--dir", required=True, help="directorio que ya produjo `assemble` (con union.mp4 y manifest.json)")
    render_cmd.add_argument(
        "--input", default=None, help="binding JSON opcional del que tomar los textos (título, subtítulo y nombres)"
    )
    render_cmd.add_argument("--title", default=None, help="sobrescribe el título del vídeo")
    render_cmd.add_argument(
        "--subtitle", default=None, help="sobrescribe el subtítulo (opcional; vacío = sin subtítulo)"
    )
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
    preview_cmd.add_argument("--subtitle", default="", help="subtítulo opcional a dibujar (va debajo del título)")
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
    handlers = {
        "render": _run_render,
        "prepare": _run_prepare,
        "join": _run_join,
        "preset": _run_preset,
        "preview": _run_preview,
    }
    return handlers[args.command](args)


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
                            "y": style["title"]["y"],
                        },
                        "subtitle": {
                            "size": style["subtitle"]["size"],
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
            subtitle=args.subtitle or "",
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
                    # Recorrido real del ajuste de altura del título: lo usa el panel
                    # para que el deslizador no tenga tramos muertos.
                    "title_y": {
                        "min": result.spec["title"]["y_min"],
                        "max": result.spec["title"]["y_max"],
                    },
                },
                indent=2,
                ensure_ascii=False,
            )
        )
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
        subtitle = args.subtitle
        if args.input:
            binding = load_binding(args.input, config)
            title = title if title is not None else binding.title
            subtitle = subtitle if subtitle is not None else binding.subtitle
            for item in binding.items:
                labels.setdefault(item.position, item.label)
        result = render(
            args.dir,
            title=title,
            subtitle=subtitle,
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


def _run_prepare(args: argparse.Namespace) -> int:
    """Prepara **un** clip al entrar: es lo que dispara el tick del panel.

    El archivo de salida depende solo del puesto (``prepared/05.mp4``), así que el
    rótulo se puede escribir después sin volver a normalizar nada.
    """
    config = _config_with_items(Config.from_env(), args.items)
    say = (lambda _: None) if args.quiet else (lambda message: print(message, flush=True))
    tracker = Progress(_progress_sink() if args.progress else None, span=SPAN_PREPARE)
    tracker.preparing(f"Preparando el puesto #{args.position}")
    try:
        clip = prepare_clip(
            args.input,
            prepared_file(args.out, args.position),
            position=args.position,
            config=config,
            ffmpeg=args.ffmpeg,
            ffprobe=args.ffprobe,
            fit=args.fit,
            log=say,
        )
        metadata = write_metadata(args.out, clip)
    except PrepareError as exc:
        print(f"fallo la preparación: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT if exc.reasons else EXIT_FAILED
    except (ToolError, ToolNotFound) as exc:
        print(f"fallo la preparación: {exc}", file=sys.stderr)
        return EXIT_FAILED

    tracker.normalizing(1, 1, "Clip listo")
    tracker.finishing("Clip listo")
    if args.json:
        print(
            json.dumps(
                {
                    "position": clip.position,
                    "file": str(clip.output),
                    "duration_s": round(clip.duration_s, 3),
                    "has_audio": clip.normalized.has_audio,
                    "metadata": str(metadata),
                    "warnings": list(clip.warnings),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(f"OK {clip.output} ({clip.duration_s:.2f}s, puesto #{clip.position})")
        for warning in clip.warnings:
            print(f"   aviso: {warning}")
    return EXIT_OK


def _run_join(args: argparse.Namespace) -> int:
    """Une los clips ya preparados: el paso barato del montaje."""
    config = _config_with_items(Config.from_env(), args.items)
    say = (lambda _: None) if args.quiet else (lambda message: print(message, flush=True))
    try:
        labels = _parse_label_overrides(args.label)
        result = join(
            args.out,
            title=args.title or "",
            subtitle=args.subtitle or "",
            labels=labels,
            positions=config.items,
            config=config,
            ffmpeg=args.ffmpeg,
            ffprobe=args.ffprobe,
            log=say,
            progress=_progress_sink() if args.progress else None,
        )
    except (BindingError, PlanError) as exc:
        print(f"entrada inválida: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except JoinError as exc:
        # Toda causa de JoinError es del material de entrada (falta un tick, un clip no
        # cumple el formato): se informa como entrada inválida.
        print(f"fallo la unión: {exc}", file=sys.stderr)
        return EXIT_BAD_INPUT
    except (ToolError, ToolNotFound) as exc:
        print(f"fallo la unión: {exc}", file=sys.stderr)
        return EXIT_FAILED

    if args.json:
        print(
            json.dumps(
                {
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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
