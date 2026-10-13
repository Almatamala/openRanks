"""Ejecución de procesos externos con errores útiles."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ToolError(RuntimeError):
    """Un comando externo falló. Guarda el argv y la cola del stderr."""

    message: str
    argv: tuple[str, ...] = ()
    returncode: int | None = None
    stderr_tail: str = ""
    extra: dict = field(default_factory=dict)

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
        raise ToolError(f"no se encontró el ejecutable: {argv[0]}", argv=tuple(argv)) from exc
    except subprocess.TimeoutExpired as exc:
        raise ToolError(
            f"el comando excedió {timeout_s}s",
            argv=tuple(argv),
            stderr_tail=tail_lines((exc.stderr or "") if isinstance(exc.stderr, str) else ""),
        ) from exc

    if check and completed.returncode != 0:
        raise ToolError(
            "el comando externo falló",
            argv=tuple(argv),
            returncode=completed.returncode,
            stderr_tail=tail_lines(completed.stderr or ""),
        )
    return completed


def version_of(binary: str, *, timeout_s: int = 30) -> str:
    """Primera línea de ``<binary> -version`` (para el manifiesto)."""
    completed = run([binary, "-version"], timeout_s=timeout_s, check=False)
    first = (completed.stdout or "").splitlines()
    return first[0].strip() if first else "desconocida"
