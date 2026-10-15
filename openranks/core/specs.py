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

# Posiciones del ranking: el formato va del TOP 5 al TOP 10 (§3). Los límites salen de
# `Config` (una sola definición) para que no haya dos «5 a 10» que se desincronicen.
_FORMAT = Config()
MIN_POSITIONS = _FORMAT.items_min
MAX_POSITIONS = _FORMAT.items_max

# Colores por posición (§3 y §9.2): #1 oro, #2 plata, #3 bronce. **Del 4 en adelante el
# número va en blanco**: el azul competía con el rótulo y se leía peor sobre el vídeo.
RANK_COLORS: dict[int, str] = {
    1: "#D4AF37",
    2: "#C0C0C0",
    3: "#CD7F32",
    **{position: "#FFFFFF" for position in range(4, MAX_POSITIONS + 1)},
}
LOW_RANK_COLOR = "#FFFFFF"
# Segundo acento del título (`_palabra_`). No depende del color de los puestos.
ACCENT_BLUE = "#3B82F6"

# Título: dónde puede dibujarse y cómo se reparte cuando no cabe en un renglón (§9.1).
SAFE_TOP = 96  # zona segura: por encima de esto hay UI de la plataforma
TITLE_SIDE_MARGIN = 96  # zona segura: `x > 960` es botonera; simétrico a la izquierda
TITLE_BOTTOM_GAP = 24  # aire entre el título y la primera casilla de la escalera
TITLE_LINE_HEIGHT = 1.16  # interlineado, en múltiplos del tamaño de la fuente
TITLE_MIN_SIZE = 40  # por debajo de esto el título no se lee


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


# Ancho de cada carácter, como fracción del tamaño de fuente. libass no expone la medida
# del texto, así que el encaje del título se apoya en esta estimación (una sans-serif en
# negrita, en mayúsculas). Se queda corta antes que larga: pasarse significa que el texto
# se sale del marco.
_NARROW = ".,:;!|'’¡¿()[]-"
_THIN = "iIl1fjrt"
_WIDE = "MWmw@%"


def estimate_width(text: str, size: float, scale: float = 1.0) -> float:
    """Ancho aproximado de un texto, en píxeles del lienzo."""
    factor = 0.0
    for char in text:
        if char == " " or char in _NARROW:
            factor += 0.30
        elif char in _THIN:
            factor += 0.38
        elif char in _WIDE:
            factor += 0.88
        elif char.isupper() or char.isdigit():
            factor += 0.68
        else:
            factor += 0.56
    return size * scale * factor


def _title_tokens(layers: Sequence[dict]) -> list[dict]:
    """Palabras del título con su color y su escala: es la unidad que se reparte."""
    tokens: list[dict] = []
    for layer in layers:
        colour = str(layer.get("color", ""))
        scale = float(layer.get("scale", 1.0) or 1.0)
        for word in str(layer.get("text", "")).split():
            tokens.append({"text": word, "color": colour, "scale": scale})
    return tokens


def title_line_width(tokens: Sequence[dict], size: float) -> float:
    """Ancho estimado de un renglón del título, contando los espacios entre palabras."""
    return sum(estimate_width(token["text"], size, float(token.get("scale", 1.0))) for token in tokens) + estimate_width(
        " ", size
    ) * max(0, len(tokens) - 1)


def _wrap_title(tokens: Sequence[dict], *, size: float, max_width: float) -> list[list[dict]]:
    """Reparte las palabras en renglones por anchura (el que no cabe, baja)."""
    lines: list[list[dict]] = []
    current: list[dict] = []
    for token in tokens:
        if current and title_line_width([*current, token], size) > max_width:
            lines.append(current)
            current = []
        current.append(token)
    if current:
        lines.append(current)
    return lines


def fit_title(
    layers: Sequence[dict],
    *,
    size: float,
    max_width: float,
    max_lines: int,
    max_height: float,
    min_size: int = TITLE_MIN_SIZE,
) -> dict:
    """Encaja el título en el hueco que tiene: **añade renglones** y, si aun así no cabe,
    baja el tamaño.

    Devuelve el tamaño definitivo, los renglones (cada uno, palabras con su color) y la
    altura de línea. El tamaño pedido se respeta mientras quepa; en cuanto no cabe, se
    reparte en renglones y solo se reduce cuando ni con ``max_lines`` entra en el marco.
    """
    tokens = _title_tokens(layers)
    if not tokens:
        return {"size": int(round(size)), "lines": [], "line_height": round(size * TITLE_LINE_HEIGHT, 3)}

    chosen = max(int(min_size), int(round(size)))
    while True:
        lines = _wrap_title(tokens, size=chosen, max_width=max_width)
        line_height = chosen * TITLE_LINE_HEIGHT
        fits = (
            len(lines) <= max(1, max_lines)
            and all(title_line_width(line, chosen) <= max_width for line in lines)
            and len(lines) * line_height <= max_height
        )
        if fits or chosen <= max(1, int(min_size)):
            break
        chosen = max(int(min_size), chosen - max(1, round(chosen * 0.05)))

    return {
        "size": chosen,
        "lines": [[{**token} for token in line] for line in lines],
        "line_height": round(chosen * TITLE_LINE_HEIGHT, 3),
    }


def title_anchor_y(*, lines: int, line_height: float, y: float, bottom_limit: float) -> float:
    """Altura del **centro** del bloque de título, sin salirse de la zona segura.

    El preset fija ``title.y`` para el primer renglón; si el bloque (varios renglones o
    un tamaño grande) se saldría por arriba o chocaría con la escalera, se desliza hasta
    caber. El tamaño ya viene reducido por ``fit_title``, así que siempre hay hueco.
    """
    block = max(line_height, line_height * max(1, lines))
    top = min(max(y - line_height / 2, SAFE_TOP), max(SAFE_TOP, bottom_limit - block))
    return round(top + block / 2, 3)


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


def badge_y(position: int, ladder: dict, *, slots: int | None = None) -> float:
    """Posición vertical del badge: el último abajo, el ``1`` arriba (§3).

    ``slots`` es cuántas casillas tiene la escalera. Por defecto, las del preset; el spec
    le pasa los puestos reales del ranking (de 5 a 10), así que la columna se reparte sola.
    """
    y_top = float(ladder["y_top"])
    y_bottom = float(ladder["y_bottom"])
    if ladder.get("orientation", "5_bottom") == "1_bottom":
        y_top, y_bottom = y_bottom, y_top
    count = int(slots or ladder.get("slots", 5))
    steps = max(1, count - 1)
    index = count - position
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
    # Copia: la escalera lleva tantas casillas como puestos tenga **este** ranking (de 5
    # a 10), no las del preset, para que la columna se reparta sola entre las alturas.
    ladder = dict(style["rank_ladder"])
    label_style = style["clip_label"]
    cta = style["cta"]

    positions = [window.position for window in windows if not window.is_cold_open]
    ladder["slots"] = max(1, len(positions))

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
                # La escalera está **completa desde el primer fotograma**: todas las
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
                # Mientras su puesto tiene el turno se ve nítido…
                "active_to_s": window.to_s,
                # …y a partir de ahí se queda atenuado (como su casilla) hasta el final.
                "to_s": total,
            }
        )

    # Título: se reparte en renglones y baja de tamaño hasta caber en el hueco de arriba
    # (§9.1). Con el tamaño pedido y un renglón, la geometría no cambia.
    title_layers_list = list(
        title_layers(
            title,
            base_color=title_style["color"],
            accent_color=title_style["accent"],
            blue_color=title_style.get("accent_blue", ACCENT_BLUE),
        )
    )
    bottom_limit = float(ladder["y_top"]) - TITLE_BOTTOM_GAP
    fitted = fit_title(
        title_layers_list,
        size=float(title_style["size"]),
        max_width=max(1.0, config.target_width - 2 * TITLE_SIDE_MARGIN),
        max_lines=config.title_layers_max,
        max_height=max(1.0, bottom_limit - SAFE_TOP),
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
            # Lo que de verdad se dibuja: tamaño ya ajustado, renglones y altura del
            # centro del bloque. `layers` se mantiene para leer el título de un vistazo.
            "size": fitted["size"],
            "line_height": fitted["line_height"],
            "anchor_y": title_anchor_y(
                lines=len(fitted["lines"]), line_height=fitted["line_height"], y=float(title_style["y"]), bottom_limit=bottom_limit
            ),
            "lines": fitted["lines"],
            "layers": title_layers_list,
        },
        "rank_ladder": {
            "variant": ladder.get("variant", "ladder"),
            "x": ladder["x"],
            "count": ladder["slots"],
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
