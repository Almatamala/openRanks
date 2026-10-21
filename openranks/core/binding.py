"""Binding: la parte *editable* del render (ADR-8).

Solo texto entra desde fuera: el **título del vídeo**, su **subtítulo opcional** y el
**nombre de cada puesto**. Este módulo lo valida contra los límites del RPD §9.5 antes de
tocar FFmpeg, porque si el texto no cabe, el error es del input y no del render.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .config import Config


class BindingError(ValueError):
    """El binding no cumple el contrato de entrada."""


@dataclass(frozen=True)
class ClipItem:
    """Un puesto del ranking."""

    position: int
    path: Path
    label: str


@dataclass(frozen=True)
class Binding:
    """Título del vídeo + subtítulo opcional + los puestos (de 5 a 10), con sus nombres."""

    title: str
    items: tuple[ClipItem, ...]
    # Opcional: si viene vacío no se dibuja. Va siempre debajo del título (§9.2).
    subtitle: str = ""

    @property
    def ordered(self) -> tuple[ClipItem, ...]:
        """Los puestos en orden de reproducción: ``#5`` primero, ``#1`` al final."""
        return tuple(sorted(self.items, key=lambda item: item.position, reverse=True))

    @property
    def best(self) -> ClipItem:
        """El ``#1`` (el que cierra el vídeo y alimenta el cold open)."""
        for item in self.items:
            if item.position == 1:
                return item
        raise BindingError("#1 no está en el binding")


def visible_length(text: str) -> int:
    """Caracteres que se dibujan: las marcas de color (`*`/`_`) no cuentan.

    Espeja `visibleLength` del panel (`web/lib/title.ts`): si el panel acepta el texto,
    el motor también. Si no fuera así, el formulario dejaría pasar algo que el render
    rechaza y el operador vería el error en el peor momento.
    """
    return len(text.replace("*", "").replace("_", ""))


def slugify(text: str, *, fallback: str = "clip", max_len: int = 32) -> str:
    """Nombre de archivo legible y seguro a partir del rótulo del puesto."""
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    ascii_text = ascii_text.lower()
    ascii_text = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    ascii_text = re.sub(r"-{2,}", "-", ascii_text)[:max_len].strip("-")
    return ascii_text or fallback


def validate_binding(binding: Binding, config: Config | None = None, *, check_paths: bool = True) -> None:
    """Valida posiciones, textos y (opcionalmente) que los archivos existan."""
    cfg = config or Config()
    errors: list[str] = []

    title = binding.title.strip()
    if not title:
        errors.append("el título del vídeo está vacío")
    else:
        length = visible_length(title)
        if length > cfg.title_layer_chars:
            errors.append(
                f"el título tiene {length} caracteres; el máximo es {cfg.title_layer_chars}"
            )

    subtitle = binding.subtitle.strip()
    if subtitle and len(subtitle) > cfg.title_layer_chars:
        errors.append(f"el subtítulo tiene {len(subtitle)} caracteres; el máximo es {cfg.title_layer_chars}")

    if not cfg.items_min <= cfg.items <= cfg.items_max:
        errors.append(
            f"el ranking admite de {cfg.items_min} a {cfg.items_max} puestos y se configuraron {cfg.items}"
        )
    elif len(binding.items) != cfg.items:
        errors.append(f"se esperan {cfg.items} puestos y llegaron {len(binding.items)}")

    positions = [item.position for item in binding.items]
    if sorted(positions) != list(range(1, cfg.items + 1)):
        errors.append(f"las posiciones deben ser exactamente {list(range(1, cfg.items + 1))} y llegaron {sorted(positions)}")

    for item in binding.items:
        label = item.label.strip()
        if not label:
            errors.append(f"el puesto #{item.position} no tiene nombre")
            continue
        if len(label) > cfg.label_chars:
            errors.append(
                f"el nombre del puesto #{item.position} tiene {len(label)} caracteres; el máximo es {cfg.label_chars}"
            )
        if len(label.split()) > cfg.label_words:
            errors.append(
                f"el nombre del puesto #{item.position} tiene {len(label.split())} palabras; el máximo es {cfg.label_words}"
            )
        if check_paths and not item.path.is_file():
            errors.append(f"no existe el archivo del puesto #{item.position}: {item.path.name}")

    if errors:
        raise BindingError("; ".join(errors))


def load_binding(path: str | Path, config: Config | None = None) -> Binding:
    """Lee el binding en JSON y lo valida.

    Las rutas de los clips se resuelven **relativas al propio JSON**, para que el
    archivo sea portable entre máquinas.
    """
    binding_path = Path(path)
    try:
        payload = json.loads(binding_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BindingError(f"no existe el binding: {binding_path}") from exc
    except json.JSONDecodeError as exc:
        raise BindingError(f"el binding no es JSON válido: {exc}") from exc

    if not isinstance(payload, dict):
        raise BindingError("el binding debe ser un objeto JSON")

    base_dir = binding_path.parent
    items: list[ClipItem] = []
    for raw in payload.get("items") or []:
        if not isinstance(raw, dict):
            raise BindingError("cada item debe ser un objeto con position, path y label")
        try:
            position = int(raw["position"])
            raw_path = str(raw["path"])
        except (KeyError, TypeError, ValueError) as exc:
            raise BindingError(f"item incompleto: {raw!r}") from exc
        clip_path = Path(raw_path)
        if not clip_path.is_absolute():
            clip_path = (base_dir / clip_path).resolve()
        items.append(ClipItem(position=position, path=clip_path, label=str(raw.get("label", ""))))

    title = str(payload.get("title", ""))
    subtitle = str(payload.get("subtitle", ""))

    binding = Binding(title=title, items=tuple(items), subtitle=subtitle)
    validate_binding(binding, config)
    return binding
