"""Set dorado del score (F3 · P3-8): manifiesto, generación y evaluación.

El set dorado es un `golden.json` con **clips de material propio o licenciado** y el
orden que les dio una persona (`human_rank`, `1` = el clip que iría al #1). Sobre él se
mide lo que RF-18 promete y no se puede suponer: la **correlación de Spearman** del score
con el orden humano, el **p95** por clip y el **coste estimado** del refinamiento con LLM.

Las recetas del manifiesto (`recipe`) permiten generar los clips de partida con FFmpeg:
son material generado por el propio proyecto (CC0) y sirven de base reproducible hasta
que el operador añada clips propios o licenciados. El orden humano se fija **antes** de
medir; cambiar la receta de un clip cambia el set y hay que volver a puntuarlo a mano.

Este módulo no puntúa nada: lee, genera y resume. Los scores los mide
`scripts/evaluate_score.py` con el mismo `openranks rate` que usa el panel.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

from .core.ffmpeg import ToolNotFound, resolve_binary
from .metrics import mean, percentile, spearman

GOLDEN_VERSION = 1
# Mínimo de RF-18 sobre el set dorado.
MIN_SPEARMAN = 0.6

Logger = Callable[[str], None]

# Recetas de vídeo disponibles para generar los clips de partida.
VIDEO_SOURCES = {
    # Movimiento, color y bordes: el clip «vivo» del set.
    "testsrc2": "testsrc2=size={width}x{height}:rate=30",
    # Color plano con muchas barras: bordes fijos, como un rótulo en pantalla.
    "smptebars": "smptebars=size={width}x{height}:rate=30",
    # Tono de piel plano: activa la señal de caras sin movimiento.
    "skin": "color=c=0xE0B090:size={width}x{height}:rate=30",
    # Color plano sin nada: el clip flojo.
    "flat": "color=c=0x1E3A8A:size={width}x{height}:rate=30",
}
# Ganancia del tono de prueba por receta; `None` deja el clip sin audio.
AUDIO_GAIN = {"none": None, "quiet": 0.05, "normal": 0.25, "loud": 0.9}


class GoldenError(RuntimeError):
    """El set dorado no se puede leer, generar o evaluar; el mensaje es para el operador."""


@dataclass(frozen=True)
class GoldenClip:
    """Un clip del set dorado, con el orden que le dio una persona."""

    id: str
    file: Path
    human_rank: int
    recipe: dict

    def to_json(self) -> dict:
        return {"id": self.id, "file": self.file.name, "human_rank": self.human_rank}


@dataclass(frozen=True)
class GoldenReport:
    """Resultado medido sobre el set dorado, listo para el JSON y para la consola."""

    clips: int
    spearman: float | None
    p95_ms: float | None = None
    mean_ms: float | None = None
    llm_cost_usd: float | None = None
    model: str | None = None
    rows: tuple[dict, ...] = ()

    @property
    def passed(self) -> bool:
        """Cumple el mínimo de RF-18 (con `None` no se puede afirmar que cumpla)."""
        return self.spearman is not None and self.spearman >= MIN_SPEARMAN

    def to_json(self) -> dict:
        return {
            "clips": self.clips,
            "spearman": None if self.spearman is None else round(self.spearman, 4),
            "spearman_min": MIN_SPEARMAN,
            "p95_ms": None if self.p95_ms is None else round(self.p95_ms, 1),
            "mean_ms": None if self.mean_ms is None else round(self.mean_ms, 1),
            "llm_cost_usd": (
                None if self.llm_cost_usd is None else round(self.llm_cost_usd, 6)
            ),
            "model": self.model,
            "rows": list(self.rows),
        }

    def summary(self) -> str:
        correlation = (
            "sin datos" if self.spearman is None else f"{self.spearman:.3f}"
        )
        cost = (
            "—" if self.llm_cost_usd is None else f"{self.llm_cost_usd:.4f} USD"
        )
        lines = [
            f"{self.clips} clips · Spearman {correlation} (mínimo {MIN_SPEARMAN:g}) "
            f"{'OK' if self.passed else 'NO CUMPLE'}",
            f"p95 {self.p95_ms or 0.0:.0f} ms por clip · coste estimado con {self.model}: {cost}",
        ]
        for row in self.rows:
            latency = "—" if row["ms"] is None else f"{row['ms']:.0f} ms"
            lines.append(
                f"  #{row['human_rank']:<2} {row['id']}: score {row['score']} ({latency})"
            )
        return "\n".join(lines)


def load_golden(path: str | Path) -> list[GoldenClip]:
    """Lee y valida el manifiesto; los errores dicen qué corregir, sin rutas absolutas."""
    target = Path(path)
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
    except OSError:
        raise GoldenError("no se pudo leer el manifiesto del set dorado") from None
    except ValueError:
        raise GoldenError("el manifiesto del set dorado no es JSON válido") from None

    if not isinstance(document, dict) or document.get("version") != GOLDEN_VERSION:
        raise GoldenError(f"el set dorado debe declarar la versión {GOLDEN_VERSION}")
    raw = document.get("clips")
    if not isinstance(raw, list) or len(raw) < 2:
        raise GoldenError("el set dorado necesita al menos dos clips")

    base = target.parent
    clips: list[GoldenClip] = []
    ids: set[str] = set()
    for position, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            raise GoldenError(f"clip {position}: la entrada no es un objeto")
        ident = entry.get("id")
        if not isinstance(ident, str) or not ident.strip() or ident in ids:
            raise GoldenError(f"clip {position}: id vacío o repetido")
        name = entry.get("file")
        if not isinstance(name, str) or not name.strip():
            raise GoldenError(f"clip {position}: falta el archivo")
        rank = entry.get("human_rank")
        if isinstance(rank, bool) or not isinstance(rank, int) or rank < 1:
            raise GoldenError(f"clip {position}: human_rank debe ser un entero >= 1")
        recipe = entry.get("recipe")
        ids.add(ident)
        clips.append(
            GoldenClip(
                id=ident.strip(),
                file=base / name.strip(),
                human_rank=rank,
                recipe=dict(recipe) if isinstance(recipe, dict) else {},
            )
        )

    if len({clip.human_rank for clip in clips}) != len(clips):
        raise GoldenError("human_rank no puede repetirse: el orden del set es estricto")
    return clips


def _size(raw: object) -> tuple[int, int]:
    """«320x240» → (320, 240); cualquier otro formato es un error del manifiesto."""
    if isinstance(raw, str) and "x" in raw:
        width, _, height = raw.partition("x")
        try:
            return max(16, int(width)), max(16, int(height))
        except ValueError:
            pass
    raise GoldenError(f"tamaño de clip inválido: {raw!r}")


def clip_argv(ffmpeg: str, clip: GoldenClip, output: str | Path) -> list[str]:
    """`argv` de FFmpeg que genera un clip del set a partir de su receta."""
    recipe = clip.recipe
    video = str(recipe.get("video", "testsrc2"))
    if video not in VIDEO_SOURCES:
        raise GoldenError(f"clip {clip.id}: fuente de vídeo desconocida ({video})")
    width, height = _size(recipe.get("size", "320x240"))
    try:
        duration = float(recipe.get("duration_s", 6.0))
    except (TypeError, ValueError):
        raise GoldenError(f"clip {clip.id}: duración inválida") from None
    if duration <= 0:
        raise GoldenError(f"clip {clip.id}: la duración debe ser positiva")

    argv = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        VIDEO_SOURCES[video].format(width=width, height=height),
    ]
    gain = AUDIO_GAIN.get(str(recipe.get("audio", "normal")))
    if gain is None:
        argv += ["-an"]
    else:
        argv += [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-af",
            f"volume={gain}",
        ]
    argv += [
        "-t",
        f"{duration:g}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-pix_fmt",
        "yuv420p",
    ]
    if gain is not None:
        argv += ["-c:a", "aac", "-b:a", "64k"]
    argv.append(str(output))
    return argv


def build_clips(
    clips: Iterable[GoldenClip],
    *,
    ffmpeg: str | None = None,
    force: bool = False,
    log: Logger | None = None,
) -> list[Path]:
    """Genera con FFmpeg los clips que falten; devuelve los archivos del set."""
    say = log or (lambda _: None)
    try:
        binary = resolve_binary(ffmpeg, "OPENRANKS_FFMPEG", "ffmpeg")
    except ToolNotFound as exc:
        raise GoldenError(f"no se encontró FFmpeg para generar el set: {exc}") from None

    written: list[Path] = []
    for clip in clips:
        if clip.file.is_file() and not force:
            written.append(clip.file)
            continue
        if not clip.recipe:
            raise GoldenError(f"clip {clip.id}: falta el archivo y no hay receta para generarlo")
        clip.file.parent.mkdir(parents=True, exist_ok=True)
        say(f"Generando {clip.id} ({clip.file.name})")
        try:
            subprocess.run(
                clip_argv(binary, clip, clip.file), check=True, capture_output=True
            )
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or b"").decode("utf-8", "replace").strip()
            raise GoldenError(f"FFmpeg no pudo generar {clip.id}: {detail[:200]}") from None
        written.append(clip.file)
    return written


def evaluate(
    clips: Sequence[GoldenClip],
    scores: Sequence[int],
    *,
    times_ms: Sequence[float] = (),
    llm_cost_usd: float | None = None,
    model: str | None = None,
) -> GoldenReport:
    """Correlación con el orden humano, latencia y coste de un set ya puntuado.

    El orden humano se convierte a puntuación (`-human_rank`): el #1 es el valor más alto,
    así que una correlación **positiva** significa que el score coincide con la persona.
    """
    if len(scores) != len(clips):
        raise GoldenError("faltan scores para algún clip del set dorado")
    measured: list[int] = []
    for clip, score in zip(clips, scores):
        if isinstance(score, bool) or not isinstance(score, int):
            raise GoldenError(f"clip {clip.id}: el score no es un entero")
        if not 0 <= score <= 100:
            raise GoldenError(f"clip {clip.id}: el score está fuera de 0-100")
        measured.append(score)

    times = [float(value) for value in times_ms]
    rows = tuple(
        {
            "id": clip.id,
            "file": clip.file.name,
            "human_rank": clip.human_rank,
            "score": score,
            "ms": round(times[index], 1) if index < len(times) else None,
        }
        for index, (clip, score) in enumerate(zip(clips, measured))
    )
    return GoldenReport(
        clips=len(measured),
        spearman=spearman([float(-clip.human_rank) for clip in clips], measured),
        p95_ms=percentile(times, 0.95) if times else None,
        mean_ms=mean(times) if times else None,
        llm_cost_usd=llm_cost_usd,
        model=model,
        rows=rows,
    )
