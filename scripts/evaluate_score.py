"""Evalúa el score del LLM contra el set dorado (F3 · P3-8 y P3-11).

    python scripts/evaluate_score.py --build          # genera los clips de partida
    python scripts/evaluate_score.py --json           # informe legible por máquina

Mide con `openranks rate` —el mismo camino que usa «Puntuar galería» en el panel, con
**una sola llamada** para todo el set— el score de cada clip, lo compara con el orden
humano (Spearman ≥ 0,6, RF-18) y
resume el p95 por clip y el coste estimado del refinamiento con LLM.

Necesita una clave real: el score ya no tiene respaldo local (P3-11) y este script no
inventa una. Sin clave, termina con un error legible antes de llamar al proveedor.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from openranks.core.llm import LlmSettings, estimate_cost  # noqa: E402
from openranks.golden import (  # noqa: E402
    GoldenError,
    build_clips,
    evaluate,
    load_golden,
)
from openranks.rate import RateError, rate_many  # noqa: E402

DEFAULT_SET = ROOT / "benchmark" / "golden" / "golden.json"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="evaluate_score",
        description="Evaluación del score del LLM sobre el set dorado (P3-8 y P3-11)",
    )
    parser.add_argument("--set", default=str(DEFAULT_SET), help="manifiesto del set dorado")
    parser.add_argument(
        "--build",
        action="store_true",
        help="genera los clips que falten a partir de las recetas del manifiesto",
    )
    parser.add_argument("--force", action="store_true", help="regenera aunque existan")
    parser.add_argument(
        "--min-spearman",
        type=float,
        default=None,
        help="código de salida 1 si la correlación queda por debajo (p. ej. 0.6)",
    )
    parser.add_argument("--json", action="store_true", help="informe legible por máquina")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        clips = load_golden(args.set)
    except GoldenError as exc:
        print(f"set dorado inválido: {exc}", file=sys.stderr)
        return 2

    if args.build:
        try:
            build_clips(
                clips,
                force=args.force,
                log=lambda message: print(message, file=sys.stderr, flush=True),
            )
        except GoldenError as exc:
            print(f"no se pudo generar el set: {exc}", file=sys.stderr)
            return 1

    missing = [clip.file.name for clip in clips if not clip.file.is_file()]
    if missing:
        print(
            "faltan clips del set dorado ("
            + ", ".join(missing)
            + "); ejecuta con --build o copia el material",
            file=sys.stderr,
        )
        return 2

    # Una sola llamada para todo el set, como en «Puntuar galería» (P3-6). El motor no
    # cronometra clip a clip, así que la latencia por clip es la del lote repartida.
    started = time.perf_counter()
    try:
        rated_clips = rate_many([clip.file for clip in clips])
    except RateError as exc:
        print(f"no se pudo puntuar el set dorado: {exc}", file=sys.stderr)
        return 1
    per_clip_ms = (time.perf_counter() - started) * 1000.0 / len(clips)

    scores: list[int] = []
    for clip, rated in zip(clips, rated_clips):
        if rated.score is None:
            print(f"no se pudo puntuar {clip.id}: {rated.error}", file=sys.stderr)
            return 1
        scores.append(int(rated.score))
    times = [per_clip_ms] * len(clips)

    settings = LlmSettings.from_env()
    try:
        report = evaluate(
            clips,
            scores,
            times_ms=times,
            llm_cost_usd=estimate_cost(settings, len(clips)),
            model=settings.model,
        )
    except GoldenError as exc:
        print(f"set dorado inválido: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report.to_json(), indent=2, ensure_ascii=False))
    else:
        print(report.summary())

    if args.min_spearman is not None:
        if report.spearman is None or report.spearman < args.min_spearman:
            print(
                f"Spearman {report.spearman} por debajo del mínimo {args.min_spearman:g}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
