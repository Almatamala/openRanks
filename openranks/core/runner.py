"""Ejecución de procesos externos con errores útiles."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ToolError(RuntimeError):
    """Un comando externo falló. Guarda el código de salida y la cola del stderr."""

    message: str
    returncode: int | None = None
    stderr_tail: str = ""

    def __str__(self) -> str:  # pragma: no cover - solo formato
        parts = [self.message]
        if self.returncode is not None:
            parts.append(f"(exit {self.returncode})")
        if self.stderr_tail:
            parts.append(f"\n--- stderr (cola) ---\n{self.stderr_tail}")
        return " ".join(parts)


def tail_lines(text: str, limit: int = 20) -> str:
    """Últimas ``limit`` líneas no vacías de un texto."""
    lines = [line for line in (text or "").splitlines() if line.strip()]
    return "\n".join(lines[-limit:])


# Avisos de FFmpeg que no rompen el resultado. La unión por copia de streams reetiqueta
# el DTS del AAC (+1 tick) y no queremos repetir esa línea por cada tramo.
BENIGN_FFMPEG_MARKERS: tuple[str, ...] = ("Non-monotonic DTS",)


def stderr_warnings(stderr: str | None, *, where: str) -> list[str]:
    """Convierte el stderr de FFmpeg en avisos para el manifiesto y el panel.

    Los avisos conocidos y benignos se resumen en una línea; el resto se conserva con
    su cola. Es el mismo criterio para L1 y L2, así que un mensaje no cambia de forma
    según la capa que lo produjo.
    """
    lines = [line for line in (stderr or "").splitlines() if line.strip()]
    if not lines:
        return []
    benign = [line for line in lines if any(marker in line for marker in BENIGN_FFMPEG_MARKERS)]
    other = [line for line in lines if not any(marker in line for marker in BENIGN_FFMPEG_MARKERS)]
    warnings: list[str] = []
    if benign:
        warnings.append(
            f"{where}: {len(benign)} avisos benignos de ffmpeg (DTS no monótono al unir AAC "
            "por copia; ffmpeg lo reetiqueta y la unión queda monótona)"
        )
    if other:
        warnings.append(f"{where}: ffmpeg avisó -> {tail_lines(chr(10).join(other), 3)}")
    return warnings


def run(
    argv: list[str] | tuple[str, ...],
    *,
    timeout_s: int = 900,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Ejecuta ``argv`` sin shell y devuelve el proceso completado."""
    argv = [str(part) for part in argv]
    try:
        completed = subprocess.run(  # noqa: S603 - argv explícito, shell=False
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            cwd=None if cwd is None else str(cwd),
            check=False,
        )
    except FileNotFoundError as exc:
        raise ToolError(f"no se encontró el ejecutable: {argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(
            f"el comando excedió {timeout_s}s",
            stderr_tail=tail_lines((exc.stderr or "") if isinstance(exc.stderr, str) else ""),
        ) from exc

    if check and completed.returncode != 0:
        raise ToolError(
            "el comando externo falló",
            returncode=completed.returncode,
            stderr_tail=tail_lines(completed.stderr or ""),
        )
    return completed


def version_of(binary: str, *, timeout_s: int = 30) -> str:
    """Primera línea de ``<binary> -version`` (para el manifiesto)."""
    completed = run([binary, "-version"], timeout_s=timeout_s, check=False)
    first = (completed.stdout or "").splitlines()
    return first[0].strip() if first else "desconocida"
