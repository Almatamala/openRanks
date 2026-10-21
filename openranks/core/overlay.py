"""Render del overlay de L2 (RPD §9.2, §9.3).

Igual que ``core/ffmpeg.py``: este módulo **no ejecuta nada**, devuelve ``argv`` y
texto para que el núcleo se pueda testear sin FFmpeg.

El camino elegido es el renderer que documenta el plan (§9.3): un script **ASS**
dibujado por ``libass`` encima del ``union.mp4`` que ya produjo L1. Frente a
``drawtext`` tiene tres ventajas que importan aquí:

* el color del número dentro del título se cambia *inline* (``{\\c&H..&}5``), sin
  tener que medir el ancho del texto para colocar dos ``drawtext``;
* la posición es exacta (``\\pos``) y las animaciones de entrada son relativas al
  tiempo de vídeo, así que el resultado es determinista;
* no hay que escapar la ruta de la fuente en la cadena de filtros (libass resuelve
  la fuente **por nombre**, p. ej. ``Arial``).

No necesita Node ni assets: el mismo motor que hace L1 (Python + FFmpeg) dibuja
también L2, así que el panel no arrastra un segundo runtime ni una segunda imagen.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import Config
from .ffmpeg import base_argv, video_encode_argv
from .specs import RANK_COLORS

# Familias que el panel ofrece y que la imagen de Docker trae instaladas. La de fábrica
# es `Arial` (font por defecto del preset); en el contenedor manda `OPENRANKS_FONT`. La
# **sans-serif geométrica** es `URW Gothic` (§9.2): trazos circulares tipo Avant Garde,
# con su propia cursiva (`Book Oblique` / `Demi Oblique`).
GEOMETRIC_FONT = "URW Gothic"
FONT_FAMILIES: tuple[str, ...] = ("DejaVu Sans", "Liberation Sans", "DejaVu Serif", GEOMETRIC_FONT, "Symbola")
FONT_NOTES: dict[str, str] = {
    "DejaVu Sans": "Grotesca; la fuente con la que renderiza el contenedor.",
    "Liberation Sans": "Grotesca, clon de Arial: la más parecida a Windows.",
    "DejaVu Serif": "Con serifas: más editorial.",
    GEOMETRIC_FONT: "Sans-serif **geométrica** (círculos, tipo Avant Garde) y con cursiva propia.",
    "Symbola": "Símbolos y emoji monocromos (las medallas del podio).",
}

# Preset bloqueado (§9.2). El estilo NO es editable por vídeo (ADR-8): solo cambia
# el texto. Las coordenadas están en el lienzo de 1080x1920.
DEFAULT_STYLE: dict = {
    "theme": "top5-default",
    "font": "Arial",
    # Cursiva (itálica) en todo el texto del overlay. Las familias que no traen itálica
    # de verdad (Symbola, con las medallas) se quedan como están: es cosa de la fuente.
    "italic": False,
    "palette": {
        "badge_text": "#FFFFFF",
        "stroke": "#000000",
        "accent": "#FFD60A",
    },
    "title": {
        "y": 168,
        "size": 104,
        "color": "#FFFFFF",
        "accent": "#FFD60A",
        # Segundo acento: el operador marca palabras con `_asi_`.
        "accent_blue": "#3B82F6",
        "stroke_px": 9,
        "fade_ms": 400,
    },
    # Subtítulo opcional: va **siempre debajo del título** y tiene su propio tamaño.
    "subtitle": {
        "size": 64,
        "color": "#FFFFFF",
        "stroke_px": 7,
        "fade_ms": 400,
    },
    "rank_ladder": {
        "x": 176,
        "y_top": 392,
        "y_bottom": 1496,
        # Casillas que caben en el recorrido de la escalera. Es solo el valor de
        # referencia: el render usa los puestos reales del ranking (de 5 a 10).
        "slots": 5,
        "orientation": "5_bottom",
        "variant": "ladder",
        "size": 132,
        "stroke_px": 10,
        "fade_ms": 180,
        # Podio con medallas (por posición); vacío = solo números. Configurable
        # porque el glifo depende de que la fuente del render lo traiga.
        "medals": {1: "🥇", 2: "🥈", 3: "🥉"},
        # Fuente del glifo de medalla. Tiene que ser **monocroma**: la de color
        # (Noto Color Emoji) la dibuja libass como una caja vacía.
        "medal_font": "Symbola",
        # Cuando termina su turno, la casilla se atenúa y se difumina: la activa resalta.
        "dim_alpha": 150,
        "dim_blur": 6,
    },
    "clip_label": {
        "size": 64,
        "color": "#FFFFFF",
        "stroke_px": 8,
        "fade_ms": 220,
        # Separación horizontal entre el centro de la casilla y el rótulo
        "dx": 85,
    },
}


# Claves que el panel puede cambiar y **guardar** en un preset propio
# (`OPENRANKS_PRESET_FILE`). Todo lo demás del preset sigue siendo fijo.
EDITABLE_SECTIONS: dict[str, tuple[str, ...]] = {
    # Altura (y) y tamaño del título, y tamaño del subtítulo: el texto del subtítulo
    # entra por ranking, no por preset (ADR-8).
    "title": ("size", "y"),
    "subtitle": ("size",),
    "rank_ladder": ("size", "x", "y_top", "y_bottom"),
}

# Claves de primer nivel que el panel puede cambiar y guardar (la fuente y la cursiva).
EDITABLE_TOP_LEVEL: tuple[str, ...] = ("font", "italic")


# Dónde se toca cada grupo del preset. El operador pregunta "¿dónde ajusto esto?":
# la respuesta tiene que estar en el propio listado, no en la cabeza de nadie.
STYLE_SOURCES: dict[str, str] = {
    "Fuente": "openranks/core/overlay.py → DEFAULT_STYLE[\"font\"] (o OPENRANKS_FONT)",
    "Título": "openranks/core/overlay.py → DEFAULT_STYLE[\"title\"]",
    "Subtítulo": "openranks/core/overlay.py → DEFAULT_STYLE[\"subtitle\"]",
    "Escalera": "openranks/core/overlay.py → DEFAULT_STYLE[\"rank_ladder\"]",
    "Rótulo": "openranks/core/overlay.py → DEFAULT_STYLE[\"clip_label\"] (texto al lado de su casilla)",
    "Colores": "openranks/core/specs.py → RANK_COLORS (color por puesto)",
}


def describe_style(style: dict | None = None) -> list[dict]:
    """Listado legible de los ajustes del preset: qué es cada uno y dónde se cambia.

    Es lo que el panel enseña en la tarjeta «Plantilla de la edición» y lo que
    imprime `openranks preset`.
    """
    current = style or get_style()
    title = current["title"]
    subtitle = current["subtitle"]
    ladder = current["rank_ladder"]
    label = current["clip_label"]
    rows: list[tuple[str, str, object, str]] = [
        ("Fuente", "font", current["font"], "Tipografía del overlay; libass la busca **por nombre** (Arial, DejaVu Sans…)."),
        (
            "Fuente",
            "italic",
            current.get("italic", False),
            "Cursiva (itálica) en todo el texto del overlay. Cada familia trae la suya; una que no la tenga se queda recta.",
        ),
        (
            "Fuente",
            "font.opciones",
            " · ".join(FONT_FAMILIES),
            "Familias que ofrece el panel, con la nota de cada una en el menú de la plantilla.",
        ),
        (
            "Fuente",
            "font.geometrica",
            GEOMETRIC_FONT,
            "Sans-serif **geométrica** (círculos y trazos uniformes, tipo Avant Garde), con cursiva propia.",
        ),
        ("Título", "title.y", title["y"], "Altura del título (píxeles desde arriba, lienzo 1080x1920)."),
        ("Título", "title.size", title["size"], "Tamaño del título, en píxeles de alto."),
        ("Título", "title.color", title["color"], "Color del texto del título."),
        ("Título", "title.accent", title["accent"], "Color del **número** dentro del título (§3: dos capas) y de lo marcado con `*palabra*`."),
        ("Título", "title.accent_blue", title["accent_blue"], "Segundo acento, azul: pinta lo marcado con `_palabra_`."),
        ("Título", "title.marcas", "*amarillo* · _azul_", "Marca en el propio título las palabras que salen en otro color (base blanco)."),
        ("Título", "title.stroke_px", title["stroke_px"], "Grosor del contorno negro: es lo que hace legible el texto sobre vídeo."),
        ("Título", "title.fade_ms", title["fade_ms"], "Duración del fundido de entrada del título."),
        (
            "Subtítulo",
            "subtitle.size",
            subtitle["size"],
            "Tamaño del subtítulo, independiente del título. Es opcional: sin texto no se dibuja; con él, va siempre debajo.",
        ),
        ("Subtítulo", "subtitle.color", subtitle["color"], "Color del texto del subtítulo."),
        ("Subtítulo", "subtitle.stroke_px", subtitle["stroke_px"], "Grosor del contorno del subtítulo."),
        ("Subtítulo", "subtitle.fade_ms", subtitle["fade_ms"], "Duración del fundido de entrada del subtítulo."),
        ("Escalera", "rank_ladder.x", ladder["x"], "Centro horizontal de la columna de números."),
        ("Escalera", "rank_ladder.y_bottom", ladder["y_bottom"], "Altura del #5 (el de abajo)."),
        ("Escalera", "rank_ladder.y_top", ladder["y_top"], "Altura del #1 (el de arriba)."),
        ("Escalera", "rank_ladder.size", ladder["size"], "Tamaño de los números de posición."),
        ("Escalera", "rank_ladder.stroke_px", ladder["stroke_px"], "Grosor del contorno de los números."),
        ("Escalera", "rank_ladder.fade_ms", ladder["fade_ms"], "Fundido de entrada de los números (la escalera ya está puesta desde el fotograma 0)."),
        ("Escalera", "rank_ladder.variant", ladder["variant"], "`ladder` = una casilla fija por puesto; `single_badge` = un badge que cambia (§9.2)."),
        ("Escalera", "rank_ladder.medals", ladder["medals"], "Glifo de cada casilla del podio (🥇🥈🥉); vacío = solo el número."),
        ("Escalera", "rank_ladder.medal_font", ladder["medal_font"], "Fuente del glifo de medalla; debe ser monocroma (la de color sale como caja vacía)."),
        ("Escalera", "rank_ladder.dim_alpha", ladder["dim_alpha"], "Transparencia (0-255) de las casillas que no están en su turno (antes y después)."),
        ("Escalera", "rank_ladder.dim_blur", ladder["dim_blur"], "Difuminado (px) de las casillas que ya no son la activa."),
        ("Rótulo", "clip_label.dx", label["dx"], "Separación entre el centro de la casilla y su rótulo: van al lado, a la misma altura."),
        ("Rótulo", "clip_label.size", label["size"], "Tamaño del rótulo de cada puesto, en píxeles de alto."),
        ("Rótulo", "clip_label.color", label["color"], "Color del texto del rótulo de cada puesto."),
        ("Rótulo", "clip_label.stroke_px", label["stroke_px"], "Grosor del contorno del rótulo."),
        (
            "Rótulo",
            "clip_label.fade_ms",
            label["fade_ms"],
            "Fundido de entrada del rótulo. Se queda hasta el final, pero al acabar el turno de su puesto se atenúa y se difumina igual que su casilla.",
        ),
        ("Colores", "rank_colors", RANK_COLORS, "Color de cada puesto (oro/plata/bronce en el podio)."),
    ]
    return [
        {
            "group": group,
            "key": key,
            "value": value,
            "what": what,
            "where": STYLE_SOURCES.get(group, "openranks/core/overlay.py"),
        }
        for group, key, value, what in rows
    ]


def load_saved_preset() -> dict:
    """Preset guardado por el panel (`OPENRANKS_PRESET_FILE`), si existe y es válido.

    Solo se aceptan las claves editables (§`EDITABLE_SECTIONS`): un archivo corrupto o
    manipulado no puede colar ajustes arbitrarios en el render.
    """
    raw_path = os.environ.get("OPENRANKS_PRESET_FILE")
    if not raw_path:
        return {}
    try:
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(payload, dict):
        return {}
    saved: dict = {}
    if isinstance(payload.get("font"), str) and payload["font"].strip():
        saved["font"] = payload["font"]
    if isinstance(payload.get("italic"), bool):
        saved["italic"] = payload["italic"]
    for section, allowed in EDITABLE_SECTIONS.items():
        value = payload.get(section)
        if not isinstance(value, dict):
            continue
        picked: dict = {}
        for key in allowed:
            if key not in value:
                continue
            item = value[key]
            if isinstance(item, bool):  # antes que int: en Python bool es int
                picked[key] = item
            elif isinstance(item, (int, float)):
                picked[key] = int(round(item))
        if picked:
            saved[section] = picked
    return saved


def get_style(overrides: dict | None = None) -> dict:
    """Preset efectivo: fábrica ← preset guardado ← overrides, y el entorno encima.

    La resolución de la fuente vive **aquí y solo aquí** para que lo que enseña el
    panel (`openranks preset`) sea exactamente lo que usa el render. Si `Arial` no
    existe en la máquina —caso de la imagen de Docker—, `OPENRANKS_FONT` la cambia,
    y el listado lo refleja en vez de mentir.
    """
    style = {key: (dict(value) if isinstance(value, dict) else value) for key, value in DEFAULT_STYLE.items()}
    saved = load_saved_preset()
    for source in (saved, overrides or {}):
        for key, value in source.items():
            if isinstance(value, dict) and isinstance(style.get(key), dict):
                style[key].update(value)
            else:
                style[key] = value
    # La fuente del entorno (`OPENRANKS_FONT`) cuela solo si nadie eligió una antes:
    # un preset guardado con fuente propia manda sobre el valor del contenedor.
    env_font = os.environ.get("OPENRANKS_FONT")
    if env_font and not (overrides or {}).get("font") and not saved.get("font"):
        style["font"] = env_font
    return style


def ass_color(rgb_hex: str, *, alpha: int = 0) -> str:
    """``#RRGGBB`` → ``&HAABBGGRR`` (ASS usa BGR, con alfa 00 = opaco)."""
    text = rgb_hex.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"color no válido: {rgb_hex!r} (se espera #RRGGBB)")
    red, green, blue = (int(text[index : index + 2], 16) for index in (0, 2, 4))
    return f"&H{alpha:02X}{blue:02X}{green:02X}{red:02X}"


def ass_time(seconds: float) -> str:
    """``12.34`` → ``0:00:12.34`` (centésimas, formato ASS)."""
    total = max(0.0, float(seconds))
    hundredths = int(round(total * 100))
    hours, rest = divmod(hundredths, 360000)
    minutes, rest = divmod(rest, 6000)
    secs, cents = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cents:02d}"


def _escape_text(text: str) -> str:
    """Escapa lo que ASS interpreta como marcas: ``\\``, ``{`` y ``}``."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def _text_line(layers: list[dict], *, base_color: str) -> str:
    """Un renglón ya repartido, con el color y la escala de cada capa.

    El reparto en renglones lo decidió `fit_title` (`core/specs.py`): aquí solo se
    pintan las palabras que van en cada uno, con sus marcas de color y escala. El título
    usa sus dos acentos (y el número a mayor tamaño); el subtítulo, un solo color.
    """
    parts: list[str] = []
    for layer in layers:
        text = _escape_text(str(layer["text"]))
        colour = str(layer["color"])
        scale = int(round(float(layer.get("scale", 1.0)) * 100))
        if colour.upper() == base_color.upper() and scale == 100:
            parts.append(text)
            continue
        parts.append(
            f"{{\\c{ass_color(colour)}\\fscx{scale}\\fscy{scale}}}{text}"
            f"{{\\c{ass_color(base_color)}\\fscx100\\fscy100}}"
        )
    return " ".join(parts)


def _block_text(lines: list[list[dict]], *, base_color: str) -> str:
    r"""Renglones de un bloque de texto unidos con el salto duro de ASS (``\N``)."""
    return "\\N".join(_text_line(line, base_color=base_color) for line in lines)


def _title_text(spec: dict, style: dict) -> str:
    r"""Título completo: sus renglones, ya repartidos, unidos con el salto de ASS (``\N``)."""
    lines = spec["title"].get("lines") or [spec["title"]["layers"]]
    return _block_text(lines, base_color=style["title"]["color"])


def _subtitle_text(spec: dict, style: dict) -> str:
    r"""Subtítulo completo: sus renglones, ya repartidos, unidos con ``\N``."""
    lines = spec["subtitle"].get("lines") or []
    return _block_text(lines, base_color=style["subtitle"]["color"])


def _style_line(
    name: str,
    *,
    font: str,
    size: int,
    color: str,
    stroke: int,
    bold: bool = True,
    italic: bool = False,
) -> str:
    """Línea de estilo ASS."""
    return (
        f"Style: {name},{font},{size},{ass_color(color)},{ass_color(color)},"
        f"{ass_color('#000000')},&H00000000,{'-1' if bold else '0'},{'-1' if italic else '0'},0,0,100,100,0,0,1,"
        f"{stroke},0,5,40,40,40,1"
    )


def build_ass(spec: dict, style: dict, config: Config) -> str:
    """Script ASS con un evento por badge, rótulo, título y subtítulo (si lo hay).

    La escalera está **completa desde el primer fotograma** (``5`` abajo → ``1`` arriba)
    y lo que llega con cada clip es su turno: el número activo se ve nítido y los demás
    atenuados. Los rótulos entran con su clip y se acumulan hasta el final (§3, §9.3).
    """
    font = style["font"]
    italic = bool(style.get("italic", False))
    title = style["title"]
    subtitle = style["subtitle"]
    # El título y el subtítulo se dibujan con el tamaño **ya encajado** al hueco
    # (`fit_title`), no con el que pide el preset: si no caben, bajan y se reparten.
    title_size = int(round(float(spec["title"].get("size", title["size"]))))
    subtitle_size = int(round(float(spec["subtitle"].get("size", subtitle["size"]))))
    title_anchor = spec["title"].get("anchor_y", title["y"])
    ladder = style["rank_ladder"]
    label = style["clip_label"]

    lines: list[str] = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {config.target_width}",
        f"PlayResY: {config.target_height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: TV.709",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        _style_line(
            "Title",
            font=font,
            size=title_size,
            color=title["color"],
            stroke=title["stroke_px"],
            italic=italic,
        ),
        _style_line(
            "Subtitle",
            font=font,
            size=subtitle_size,
            color=subtitle["color"],
            stroke=subtitle["stroke_px"],
            italic=italic,
        ),
        _style_line(
            "Badge",
            font=font,
            size=ladder["size"],
            color=style["palette"]["badge_text"],
            stroke=ladder["stroke_px"],
            italic=italic,
        ),
        _style_line(
            "Label",
            font=font,
            size=label["size"],
            color=label["color"],
            stroke=label["stroke_px"],
            italic=italic,
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    centre_x = config.target_width // 2
    total = spec["total_duration_s"]

    # Título: arriba y visible todo el vídeo, con la entrada de L2.
    title_start = max(0.0, min(0.4, total))
    lines.append(
        f"Dialogue: 0,{ass_time(title_start)},{ass_time(total)},Title,,0,0,0,,"
        f"{{\\an5\\pos({centre_x},{float(title_anchor):g})\\fad({int(title['fade_ms'] / 2)},{int(title['fade_ms'] / 2)})}}"
        f"{_title_text(spec, style)}"
    )

    # Subtítulo: opcional y **siempre debajo del título**; el spec ya trae su centro.
    subtitle_spec = spec.get("subtitle") or {}
    if subtitle_spec.get("text") and subtitle_spec.get("anchor_y") is not None:
        lines.append(
            f"Dialogue: 0,{ass_time(title_start)},{ass_time(total)},Subtitle,,0,0,0,,"
            f"{{\\an5\\pos({centre_x},{float(subtitle_spec['anchor_y']):g})"
            f"\\fad({int(subtitle['fade_ms'] / 2)},{int(subtitle['fade_ms'] / 2)})}}"
            f"{_subtitle_text(spec, style)}"
        )

    # Escalera de rangos: **todas** las casillas están puestas desde el primer fotograma.
    # La que tiene el turno se ve nítida (con un pulso al activarse) y el resto se atenúa
    # y se difumina: primero las que aún no han llegado y después las que ya pasaron
    # (§3, §9.3).
    fade = int(ladder["fade_ms"] / 2)
    dim_alpha = max(0, min(255, int(ladder.get("dim_alpha", 150))))
    dim_blur = float(ladder.get("dim_blur", 0) or 0)
    medal_font = str(ladder.get("medal_font") or "")
    dim_cmd = f"\\alpha&H{dim_alpha:02X}&" + (f"\\blur{dim_blur:g}" if dim_blur else "")
    for slot in spec["rank_ladder"]["slots"]:
        start = max(0.0, min(float(slot.get("from_s", 0.0)), total - 0.05))
        end = min(float(slot["to_s"]), total)
        if end <= start:
            continue
        active_start = min(max(float(slot.get("active_from_s", start)), start), end)
        active_end = min(float(slot.get("active_to_s", slot["to_s"])), end)
        anchor = f"\\an5\\pos({ladder['x']},{slot['y']})"
        colour = ass_color(slot["color"])
        # El glifo de medalla vive en otra fuente: se fuerza solo en las casillas del podio.
        font_cmd = f"\\fn{medal_font}" if slot.get("medal") and medal_font else ""
        body = _escape_text(slot["text"])
        if active_start > start:  # todavía no le toca: puesta, pero apagada
            lines.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(active_start)},Badge,,0,0,0,,"
                f"{{{anchor}{font_cmd}\\c{colour}{dim_cmd}}}{body}"
            )
        if active_end > active_start:  # su turno: nítida
            lines.append(
                f"Dialogue: 0,{ass_time(active_start)},{ass_time(active_end)},Badge,,0,0,0,,"
                f"{{{anchor}{font_cmd}\\c{colour}\\fad({fade},{fade})\\t(0,150,\\fscx112\\fscy112)}}{body}"
            )
        if end > active_end:  # ya pasó su turno
            lines.append(
                f"Dialogue: 0,{ass_time(active_end)},{ass_time(end)},Badge,,0,0,0,,"
                f"{{{anchor}{font_cmd}\\c{colour}{dim_cmd}}}{body}"
            )

    # Rótulo por clip: va **al lado** de su casilla, a la misma altura. Entra con su
    # clip y **se queda hasta el final** (§3), pero en cuanto su puesto cede el turno se
    # atenúa y se difumina **igual que su casilla**: solo destaca el del puesto actual.
    for item in spec["clip_labels"]:
        anchor = f"\\an4\\pos({item['x']},{item['y']})"
        body = _escape_text(item["text"])
        start = max(0.0, float(item["from_s"]))
        active_end = min(float(item.get("active_to_s", item["to_s"])), total)
        end = min(float(item["to_s"]), total)
        if active_end > start:
            lines.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(active_end)},Label,,0,0,0,,"
                f"{{{anchor}\\fad({int(label['fade_ms'] / 2)},{int(label['fade_ms'] / 2)})}}{body}"
            )
        if end > active_end:
            lines.append(
                f"Dialogue: 0,{ass_time(active_end)},{ass_time(end)},Label,,0,0,0,,"
                f"{{{anchor}{dim_cmd}}}{body}"
            )

    return "\n".join(lines) + "\n"


def escape_filter_path(path: str | Path) -> str:
    """Ruta segura dentro de una cadena de filtros de FFmpeg.

    En Windows el ``:`` de la unidad tiene que ir escapado (``C\\:/...``) o FFmpeg
    cree que empieza una opción nueva.
    """
    text = Path(path).resolve().as_posix()
    text = text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return f"'{text}'"


def video_chain(ass_file: Path) -> str:
    """Cadena de vídeo del overlay: solo el script ASS sobre la unión."""
    return f"ass={escape_filter_path(ass_file)}"


def overlay_argv(
    ffmpeg: str,
    src: Path,
    dst: Path,
    *,
    ass_file: Path,
    config: Config,
) -> list[str]:
    """Recodifica el vídeo con el overlay encima.

    El **audio se copia** sin tocar: L1 ya lo dejó a −14 LUFS y no queremos perder
    esa medición (ni generar otra).
    """
    return [
        *base_argv(ffmpeg),
        "-i",
        str(src),
        "-vf",
        video_chain(ass_file),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        *video_encode_argv(config),
        "-c:a",
        "copy",
        "-map_metadata",
        "-1",
        "-movflags",
        "+faststart",
        str(dst),
    ]


def preview_argv(ffmpeg: str, dst: Path, *, ass_file: Path, at_s: float, config: Config) -> list[str]:
    """Un fotograma del overlay sobre **negro**, para ver el preset antes de montar.

    La fuente de color la genera FFmpeg: no hace falta ningún vídeo y se aplica el
    **mismo** script ASS que el render final, así que la vista previa no puede mentir.
    """
    seconds = max(0.05, float(at_s)) + 0.05
    return [
        *base_argv(ffmpeg),
        "-f",
        "lavfi",
        "-i",
        f"color=c=black:s={config.target_width}x{config.target_height}:r={config.fps}:d={seconds:.3f}",
        "-vf",
        video_chain(ass_file),
        "-ss",
        f"{max(0.0, float(at_s)):.3f}",
        "-frames:v",
        "1",
        str(dst),
    ]
