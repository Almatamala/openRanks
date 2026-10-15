"""Especificación del overlay de L2 (plan §9.2–9.4).

Función pura y testeable sin FFmpeg (§7.6). Aquí vive la aritmética que en el
formato de referencia se rompe con facilidad: **las transiciones solapan clips**
(§18 B4), así que la ventana temporal de cada badge y de cada rótulo no es la suma
de los anteriores. Si el total se calcula mal, el último badge y el CTA se
desincronizan del vídeo.

El estilo es **bloqueado** (ADR-8): lo único que cambia entre rankings es el texto
(título y nombres de los puestos). Todo lo demás vive en el preset.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

from .config import Config

# Colores por posición (§3 y §9.2): #1 oro, #2 plata, #3 bronce, el resto azul.
RANK_COLORS: dict[int, str] = {
    1: "#D4AF37",
    2: "#C0C0C0",
    3: "#CD7F32",
    4: "#3B82F6",
    5: "#3B82F6",
}
LOW_RANK_COLOR = "#3B82F6"


class SpecError(ValueError):
    """El spec no se puede construir (input inválido, no un aviso)."""


@dataclass(frozen=True)
class ClipWindow:
    """Ventana temporal de un tramo dentro del vídeo ya unido.

    ``position == 0`` es el cold open (B1): se ve pero no lleva badge de posición.
    """

    position: int
    label: str
    from_s: float
    to_s: float

    @property
    def duration_s(self) -> float:
        return self.to_s - self.from_s

    @property
    def is_cold_open(self) -> bool:
        return self.position == 0


def timeline(segments: Sequence[dict], transition_s: float) -> tuple[ClipWindow, ...]:
    """Ventanas de reproducción a partir de los tramos del plan.

    Cada transición **consume** ``transition_s`` de la unión, así que el tramo
    siguiente empieza antes de que acabe el anterior (solape de ``xfade``).
    """
    if transition_s < 0:
        raise SpecError("la transición no puede ser negativa")
    windows: list[ClipWindow] = []
    cursor = 0.0
    for segment in segments:
        try:
            position = int(segment["position"])
            duration = float(segment["duration_s"])
        except (KeyError, TypeError, ValueError) as exc:
            raise SpecError(f"tramo incompleto en el plan: {segment!r}") from exc
        end = cursor + duration
        windows.append(
            ClipWindow(
                position=position,
                label=str(segment.get("label", "")),
                from_s=round(cursor, 3),
                to_s=round(end, 3),
            )
        )
        cursor = end - transition_s
    return tuple(windows)


def total_duration_s(windows: Sequence[ClipWindow], transition_s: float) -> float:
    """Duración real de la unión: la del último tramo, no la suma."""
    if not windows:
        return 0.0
    _ = transition_s  # documenta que el solape ya está incluido en las ventanas
    return windows[-1].to_s


# Un número suelto dentro del título ("TOP 5 GATOS") se pinta con su propio color
# (§3: "dos capas para dar color propio al número"). Solo el primero.
_NUMBER = re.compile(r"(\d+)")
# El operador marca qué palabras salen en acento: `*palabra*` → amarillo, `_palabra_` → azul.
_MARKED = re.compile(r"\*([^*]+)\*|_([^_]+)_")


def _plain_layers(text: str, base_color: str, accent_color: str) -> list[dict]:
    """Capas del texto **sin marcas**: el primer número va en acento y mayor (§3)."""
    match = _NUMBER.search(text)
    if match is None:
        return [{"text": text, "color": base_color}] if text else []
    layers: list[dict] = []
    before = text[: match.start()]
    if before:
        layers.append({"text": before, "color": base_color})
    layers.append({"text": match.group(1), "color": accent_color, "scale": 1.35})
    after = text[match.end() :]
    if after:
        layers.append({"text": after, "color": base_color})
    return layers


def title_layers(
    title: str,
    *,
    base_color: str,
    accent_color: str,
    blue_color: str = LOW_RANK_COLOR,
) -> tuple[dict, ...]:
    """Parte el título en capas de color.

    * el **número** suelto va en acento y con más cuerpo (§3);
    * `*palabra*` se pinta en el acento (amarillo);
    * `_palabra_` se pinta en azul.

    Las marcas **no se dibujan**: solo eligen color. Sin marcas ni número, el título
    queda como una sola capa.
    """
    layers: list[dict] = []
    cursor = 0
    for match in _MARKED.finditer(title):
        layers.extend(_plain_layers(title[cursor : match.start()], base_color, accent_color))
        text = match.group(1) if match.group(1) is not None else match.group(2)
        color = accent_color if match.group(1) is not None else blue_color
        if text:
            layers.append({"text": text, "color": color})
        cursor = match.end()
    layers.extend(_plain_layers(title[cursor:], base_color, accent_color))
    if not layers:
        return ({"text": title, "color": base_color},)
    return tuple(layers)


def rank_color(position: int) -> str:
    return RANK_COLORS.get(position, LOW_RANK_COLOR)


def badge_medal(position: int, ladder: dict) -> str | None:
    """Glifo de medalla del podio (🥇🥈🥉) o ``None`` si esa casilla no lleva."""
    medals = ladder.get("medals") or {}
    medal = medals.get(position, medals.get(str(position)))
    return str(medal) if medal else None


def badge_text(position: int, ladder: dict) -> str:
    """Rótulo de la casilla: medalla en el podio, el **número pelado** en el resto.

    Las medallas viven en el preset (`rank_ladder.medals`) porque el glifo depende de
    la fuente del render; con el mapa vacío la casilla vuelve a su número, sin `#`:
    el símbolo no aportaba nada y ensuciaba el render.
    """
    return badge_medal(position, ladder) or str(position)


def badge_y(position: int, ladder: dict) -> float:
    """Posición vertical del badge: ``#5`` abajo, ``#1`` arriba (§3)."""
    y_top = float(ladder["y_top"])
    y_bottom = float(ladder["y_bottom"])
    if ladder.get("orientation", "5_bottom") == "1_bottom":
        y_top, y_bottom = y_bottom, y_top
    steps = max(1, ladder.get("slots", 5) - 1)
    index = (ladder.get("slots", 5) - position)
    return round(y_bottom - (y_bottom - y_top) * (index / steps), 3)


def build_spec(
    *,
    title: str,
    labels: dict[int, str],
    segments: Sequence[dict],
    transition_s: float,
    transition: str,
    cold_open_s: float,
    style: dict,
    config: Config,
    zoom: float = 0.0,
) -> dict:
    """Construye el ``spec.json`` que describe el overlay por completo.

    Reproducible: el mismo texto + el mismo preset producen el mismo spec y, por
    tanto, el mismo MP4 (§9.3).
    """
    windows = timeline(segments, transition_s)
    total = total_duration_s(windows, transition_s)
    if total <= 0:
        raise SpecError("el plan no tiene tramos: no hay nada que renderizar")

    title_style = style["title"]
    ladder = style["rank_ladder"]
    label_style = style["clip_label"]
    cta = style["cta"]

    label_dx = float(label_style.get("dx", 132))
    slots: list[dict] = []
    clips: list[dict] = []
    for window in windows:
        if window.is_cold_open:
            continue
        text = labels.get(window.position, window.label)
        y = badge_y(window.position, ladder)
        slots.append(
            {
                "position": window.position,
                # La casilla muestra medalla en el podio y el número pelado en el resto.
                "text": badge_text(window.position, ladder),
                "medal": badge_medal(window.position, ladder),
                "number": str(window.position),
                "y": y,
                "color": rank_color(window.position),
                # La escalera está **completa desde el primer fotograma**: las cinco
                # casillas ya están puestas y lo único que va llegando es su turno.
                "from_s": 0.0,
                "to_s": total,
                # Ventana en la que esta casilla es la activa (nítida); antes y después
                # de su turno se atenúa y se difumina.
                "active_from_s": window.from_s,
                "active_to_s": window.to_s,
            }
        )
        clips.append(
            {
                "position": window.position,
                "text": text,
                # El rótulo va **al lado** de su casilla, a su misma altura, y desde que
                # entra se queda: el texto solo se **acumula**, no se sustituye.
                "x": round(float(ladder["x"]) + label_dx, 3),
                "y": y,
                "from_s": window.from_s,
                "to_s": total,
            }
        )

    # El CTA se ve en el cierre. Su ventana no puede salirse del vídeo.
    cta_from = max(0.0, round(total - float(cta["hold_s"]), 3))
    return {
        "layer": "L2",
        "preset": style.get("theme", "top5-default"),
        "canvas": {"width": config.target_width, "height": config.target_height, "fps": config.fps},
        "total_duration_s": round(total, 3),
        "transition": {"type": transition, "duration_s": round(transition_s, 3)},
        "cold_open_s": round(cold_open_s, 3),
        "first_clip_zoom": round(zoom, 3),
        "title": {
            "text": title,
            "y": title_style["y"],
            "layers": list(
                title_layers(
                    title,
                    base_color=title_style["color"],
                    accent_color=title_style["accent"],
                    blue_color=title_style.get("accent_blue", LOW_RANK_COLOR),
                )
            ),
        },
        "rank_ladder": {
            "variant": ladder.get("variant", "ladder"),
            "x": ladder["x"],
            "slots": slots,
        },
        "clip_labels": clips,
        "cta": {"text": cta["text"], "y": cta["y"], "from_s": cta_from, "to_s": round(total, 3)},
        "editable_surface": {
            "fields": ["title", "labels"],
            "note": "(ADR-8) solo el título y el nombre de los puestos; el resto es el preset bloqueado",
        },
        "windows": [
            {
                "position": window.position,
                "kind": "cold_open" if window.is_cold_open else "ranking",
                "label": window.label,
                "from_s": window.from_s,
                "to_s": window.to_s,
            }
            for window in windows
        ],
    }


def labels_from_segments(segments: Iterable[dict]) -> dict[int, str]:
    """Etiquetas del plan, para re-renderizar sin volver a leer el binding."""
    return {int(segment["position"]): str(segment.get("label", "")) for segment in segments}
