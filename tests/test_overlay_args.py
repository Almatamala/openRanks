"""Overlay de L2 sin FFmpeg: script ASS, colores, rutas y argv (§9.2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core.config import Config
from openranks.core.overlay import (
    DEFAULT_STYLE,
    ass_color,
    ass_time,
    build_ass,
    escape_filter_path,
    get_style,
    overlay_argv,
    preview_argv,
    video_chain,
)
from openranks.core.specs import TITLE_SIDE_MARGIN, build_spec, title_line_width


def _style() -> dict:
    """Preset con la fuente fija de fábrica.

    Estos tests hablan de la **forma** del script ASS, no de qué fuente hay instalada:
    si `OPENRANKS_FONT` está definido (lo está en CI), el preset efectivo cambia y las
    aserciones sobre el nombre de la fuente dejarían de ser deterministas.
    """
    style = get_style()
    style["font"] = DEFAULT_STYLE["font"]
    return style


def _spec() -> dict:
    segments = [
        {"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(5, 0, -1)
    ]
    return build_spec(
        title="TOP 5 GATOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=segments,
        cold_open_s=0.0,
        style=_style(),
        config=Config(),
    )


def test_ass_colour_uses_bgr_order():
    # #FF3B30 (rojo) → &H00303BFF (BGR) y alfa 00 = opaco.
    assert ass_color("#FF3B30") == "&H00303BFF"
    assert ass_color("#FFFFFF") == "&H00FFFFFF"
    assert ass_color("#000000", alpha=128) == "&H80000000"


def test_ass_colour_rejects_a_bad_value():
    with pytest.raises(ValueError, match="color no válido"):
        ass_color("rojo")


def test_ass_time_is_centiseconds():
    assert ass_time(0) == "0:00:00.00"
    assert ass_time(7.0) == "0:00:07.00"
    assert ass_time(33.6) == "0:00:33.60"
    assert ass_time(3661.25) == "1:01:01.25"


def test_ass_script_has_one_event_per_element():
    script = build_ass(_spec(), _style(), Config())
    assert script.startswith("[Script Info]")
    assert "PlayResX: 1080" in script and "PlayResY: 1920" in script
    assert "Style: Badge,Arial,132" in script
    # 1 título + 5 tramos nítidos + 8 casillas atenuadas (las 4 que aún no han llegado y
    # las 4 ya pasadas; el 1 cierra el vídeo y no se atenúa después) + 5 rótulos nítidos
    # + 4 rótulos atenuados. Sin CTA: el cierre es la escalera y los rótulos.
    assert script.count("\nDialogue:") == 23
    assert ",Cta," not in script and "Style: Cta," not in script


def test_ass_title_puts_the_number_in_accent_and_bigger():
    script = build_ass(_spec(), _style(), Config())
    title_line = next(line for line in script.splitlines() if ",Title," in line)
    assert "TOP " in title_line and " GATOS" in title_line
    assert ass_color("#FFD60A") in title_line  # acento del número
    assert "\\fscx135" in title_line


def test_ass_ladder_is_complete_from_the_start_and_dims_outside_its_turn():
    script = build_ass(_spec(), _style(), Config())
    badges = [line for line in script.splitlines() if ",Badge," in line]
    # 5 tramos nítidos (uno por turno) + 8 atenuados: 4 esperan apagadas y 4 ya pasaron.
    assert len(badges) == 13
    sharp = [line for line in badges if "\\t(0,150," in line]
    dim = [line for line in badges if "\\alpha" in line]
    assert len(sharp) == 5 and len(dim) == 8
    # El 5 abre nítido desde el fotograma 0, y su número va pelado: sin `#`.
    assert badges[0].startswith("Dialogue: 0,0:00:00.00,0:00:07.00")
    assert badges[0].endswith("5") and "#" not in badges[0]
    assert "\\blur" not in badges[0] and "\\alpha" not in badges[0]
    # Todo lo que no es su turno se atenúa y se difumina.
    assert all("\\blur" in line and "\\alpha" in line for line in dim)
    # El 4 ya está puesto, pero apagado hasta que le toca.
    assert badges[2].startswith("Dialogue: 0,0:00:00.00,0:00:07.00") and badges[2].endswith("4")
    assert badges[3].startswith("Dialogue: 0,0:00:07.00,0:00:14.00")
    # La misma casilla se queda atenuada el resto del vídeo.
    assert badges[4].startswith("Dialogue: 0,0:00:14.00,0:00:35.00") and badges[4].endswith("4")
    # El podio lleva medallas (🥉 3, 🥈 2, 🥇 1), con su fuente propia…
    medals = {line[-1] for line in sharp if line[-1] in "🥉🥈🥇"}
    assert medals == {"🥉", "🥈", "🥇"}
    assert all("\\fnSymbola" in line for line in sharp if line[-1] in "🥉🥈🥇")
    # …y el 5, que es un número, no la fuerza.
    assert "\\fn" not in badges[0]
    # El 1 cierra nítido y es el último: no se atenúa después.
    assert sharp[-1].startswith("Dialogue: 0,0:00:28.00,0:00:35.00") and sharp[-1].endswith("🥇")
    assert ass_color("#D4AF37") in sharp[-1]  # oro para el 1
    assert sharp[-1].count("\\alpha") == 0


def test_ass_labels_arrive_with_their_clip_and_dim_when_their_turn_ends():
    script = build_ass(_spec(), _style(), Config())
    labels = [line for line in script.splitlines() if ",Label," in line]
    crisp = [line for line in labels if "\\fad" in line]
    dim = [line for line in labels if "\\alpha" in line]
    # 5 nítidos (uno por turno) + 4 atenuados: el del #1 cierra el vídeo y no se atenúa.
    assert len(crisp) == 5 and len(dim) == 4
    # El primero entra con su clip, nítido…
    assert crisp[0].startswith("Dialogue: 0,0:00:00.00,0:00:07.00") and "RÓTULO 5" in crisp[0]
    # …y en cuanto su puesto cede el turno se queda atenuado hasta el final.
    assert dim[0].startswith("Dialogue: 0,0:00:07.00,0:00:35.00") and "RÓTULO 5" in dim[0]
    # Se difumina **igual que su casilla**: las mismas marcas del preset.
    style = _style()
    alpha = int(style["rank_ladder"]["dim_alpha"])
    blur = float(style["rank_ladder"]["dim_blur"])
    assert all(f"\\alpha&H{alpha:02X}&" in line and f"\\blur{blur:g}" in line for line in dim)
    # El del #1 entra al final y no se atenúa: es el que cierra.
    assert crisp[-1].startswith("Dialogue: 0,0:00:28.00,0:00:35.00") and "RÓTULO 1" in crisp[-1]
    assert not any("RÓTULO 1" in line for line in dim)
    # Anclaje a la izquierda (\an4) y a la altura de su casilla, no en una posición fija.
    assert "\\an4" in crisp[0]
    x = float(style["rank_ladder"]["x"]) + float(style["clip_label"]["dx"])
    y = float(style["rank_ladder"]["y_bottom"])
    assert f"\\pos({x},{y})" in crisp[0]


def test_ass_title_paints_marked_words_in_the_two_accents():
    segments = [{"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(5, 0, -1)]
    spec = build_spec(
        title="TOP *5* _GATOS_",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=segments,
        cold_open_s=0.0,
        style=_style(),
        config=Config(),
    )
    title_line = next(line for line in build_ass(spec, _style(), Config()).splitlines() if ",Title," in line)
    assert ass_color("#FFD60A") in title_line  # *5* → amarillo
    assert ass_color("#3B82F6") in title_line  # _GATOS_ → azul
    assert "*" not in title_line and "_" not in title_line  # las marcas no se dibujan


def test_ass_escapes_user_text_so_braces_do_not_break_the_overlay():
    segments = [{"position": position, "label": "X", "duration_s": 6.0} for position in range(5, 0, -1)]
    spec = build_spec(
        title="TOP 5 {GATOS}",
        labels={5: r"CAOS \ TOTAL", 4: "B", 3: "C", 2: "D", 1: "E"},
        segments=segments,
        cold_open_s=0.0,
        style=_style(),
        config=Config(),
    )
    script = build_ass(spec, _style(), Config())
    assert r"\{GATOS\}" in script
    assert r"CAOS \\ TOTAL" in script


def test_the_title_has_no_opaque_background_option_any_more():
    """La caja negra se quitó del producto: el título siempre va con contorno."""
    assert "background" not in DEFAULT_STYLE["title"]
    assert "bg_pad" not in DEFAULT_STYLE["title"]
    script = build_ass(_spec(), _style(), Config())
    assert "TitleBg" not in script
    assert ",Title," in script


def test_a_subtitle_is_drawn_below_the_title_with_its_own_size():
    style = _style()
    style["subtitle"]["size"] = 52
    spec = build_spec(
        title="TOP 5 GATOS",
        subtitle="LOS MÁS LOCOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=[{"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(5, 0, -1)],
        cold_open_s=0.0,
        style=style,
        config=Config(),
    )
    script = build_ass(spec, style, Config())
    title_line = next(line for line in script.splitlines() if ",Title," in line)
    subtitle_line = next(line for line in script.splitlines() if ",Subtitle," in line)
    assert "LOS MÁS LOCOS" in subtitle_line
    # Estilo propio, con el tamaño del subtítulo (no el del título).
    assert "Style: Subtitle,Arial,52," in script
    # Va **debajo** del título: su centro cae por debajo del bloque del título.
    assert spec["subtitle"]["anchor_y"] > spec["title"]["anchor_y"]
    assert f"\\pos(540,{spec['subtitle']['anchor_y']:g})" in subtitle_line
    assert title_line != subtitle_line


def test_without_subtitle_text_no_subtitle_event_is_written():
    script = build_ass(_spec(), _style(), Config())
    assert ",Subtitle," not in script
    assert "Style: Subtitle," in script


def test_style_overrides_do_not_mutate_the_preset():
    style = get_style({"title": {"color": "#00FF00"}})
    assert style["title"]["color"] == "#00FF00"
    assert DEFAULT_STYLE["title"]["color"] == "#FFFFFF"


def test_escape_filter_path_escapes_the_windows_drive_colon():
    escaped = escape_filter_path(Path("work/overlay.ass"))
    assert escaped.startswith("'") and escaped.endswith("'")
    resolved = Path("work/overlay.ass").resolve().as_posix()
    if ":" in resolved:  # en Windows la unidad tiene que ir escapada (C\:/...)
        assert "\\:" in escaped
    assert escaped[1:-1].replace("\\:", ":") == resolved


def test_overlay_argv_copies_the_audio_and_cleans_metadata():
    argv = overlay_argv("ffmpeg", Path("union.mp4"), Path("ranking.mp4"), ass_file=Path("work/overlay.ass"), config=Config())
    assert argv[0] == "ffmpeg"
    assert "ass=" in argv[argv.index("-vf") + 1]
    # El audio no se recodifica: L1 ya lo dejó a −14 LUFS.
    assert argv[argv.index("-c:a") + 1] == "copy"
    assert argv[argv.index("-map_metadata") + 1] == "-1"
    assert argv[-1] == "ranking.mp4"


def test_the_video_chain_is_only_the_ass_overlay():
    chain = video_chain(Path("o.ass"))
    assert chain.startswith("ass='")
    # Ya no hay zoom de entrada: el montaje es corte seco y la cadena no toca el zoom.
    assert "zoompan" not in chain and "," not in chain


def test_the_env_font_overrides_the_factory_default(monkeypatch):
    monkeypatch.setenv("OPENRANKS_FONT", "DejaVu Sans")
    assert get_style()["font"] == "DejaVu Sans"
    assert DEFAULT_STYLE["font"] == "Arial"


def test_an_explicit_font_beats_the_environment(monkeypatch):
    monkeypatch.setenv("OPENRANKS_FONT", "DejaVu Sans")
    assert get_style({"font": "Anton"})["font"] == "Anton"


def test_without_the_env_the_factory_font_is_the_one(monkeypatch):
    monkeypatch.delenv("OPENRANKS_FONT", raising=False)
    assert get_style()["font"] == "Arial"


def _spec_of(count: int, title: str = "TOP 5 GATOS", *, segment_s: float = 7.0) -> dict:
    segments = [
        {"position": position, "label": f"PUESTO {position}", "duration_s": segment_s}
        for position in range(count, 0, -1)
    ]
    return build_spec(
        title=title,
        labels={position: f"RÓTULO {position}" for position in range(1, count + 1)},
        segments=segments,
        cold_open_s=0.0,
        style=_style(),
        config=Config(items=count),
    )


def test_ass_title_wraps_into_lines_and_shrinks_until_it_fits():
    """Un título enorme no se sale del marco: se reparte en renglones y baja de tamaño."""
    style = _style()
    style["title"]["size"] = 220
    spec = build_spec(
        title="TOP 8 MOMENTOS LOCOS Y CAOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 9)},
        segments=[
            {"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(8, 0, -1)
        ],
        cold_open_s=0.0,
        style=style,
        config=Config(items=8),
    )
    lines = spec["title"]["lines"]
    width = 1080 - 2 * TITLE_SIDE_MARGIN
    assert 1 < len(lines) <= 3
    assert spec["title"]["size"] < 220
    # Ningún renglón se pasa del ancho seguro y el bloque no invade la escalera.
    assert all(title_line_width(line, spec["title"]["size"]) <= width for line in lines)
    block = spec["title"]["line_height"] * len(lines)
    assert spec["title"]["anchor_y"] - block / 2 >= 96 - 0.5
    assert spec["title"]["anchor_y"] + block / 2 <= 392
    # En el ASS, los renglones son un salto duro (`\N`) dentro del mismo evento.
    title_line = next(line for line in build_ass(spec, style, Config(items=8)).splitlines() if ",Title," in line)
    assert "\\N" in title_line
    assert f"Style: Title,Arial,{spec['title']['size']}," in build_ass(spec, style, Config(items=8))


def test_a_short_title_keeps_the_size_and_the_place_of_the_preset():
    spec = _spec()
    assert len(spec["title"]["lines"]) == 1
    assert spec["title"]["size"] == _style()["title"]["size"]
    assert spec["title"]["anchor_y"] == pytest.approx(_style()["title"]["y"])


def test_the_italic_switch_flips_the_italic_field_of_every_style():
    def italic_field(script: str, name: str) -> str:
        line = next(entry for entry in script.splitlines() if entry.startswith(f"Style: {name},"))
        return line.split(",")[8]  # Bold, Italic, …

    plain = build_ass(_spec(), _style(), Config())
    cursive = build_ass(_spec(), get_style({"italic": True}), Config())
    for name in ("Title", "Subtitle", "Badge", "Label"):
        assert italic_field(plain, name) == "0"
        assert italic_field(cursive, name) == "-1"


def test_the_ladder_takes_as_many_badges_as_positions_has_the_ranking():
    spec = _spec_of(10, "TOP 10 GATOS")
    slots = spec["rank_ladder"]["slots"]
    assert spec["rank_ladder"]["count"] == 10 and len(slots) == 10
    assert [slot["position"] for slot in slots] == list(range(10, 0, -1))
    # La columna se reparte sola entre las alturas del preset.
    style = _style()
    assert slots[0]["y"] == pytest.approx(style["rank_ladder"]["y_bottom"])
    assert slots[-1]["y"] == pytest.approx(style["rank_ladder"]["y_top"])
    assert [slot["y"] for slot in slots] == sorted((slot["y"] for slot in slots), reverse=True)
    # Del 4 en adelante el número va en **blanco**; el podio mantiene sus colores.
    colours = {slot["position"]: slot["color"] for slot in slots}
    assert (colours[1], colours[2], colours[3]) == ("#D4AF37", "#C0C0C0", "#CD7F32")
    assert all(colours[position] == "#FFFFFF" for position in range(4, 11))
    # Y las diez casillas se dibujan: cada una nítida en su turno.
    script = build_ass(spec, _style(), Config(items=10))
    sharp = [line for line in script.splitlines() if ",Badge," in line and "\\t(0,150," in line]
    assert len(sharp) == 10


def test_preview_argv_draws_the_overlay_over_a_black_source():
    argv = preview_argv("ffmpeg", Path("preview.png"), ass_file=Path("work/preview.ass"), at_s=29.7, config=Config())
    joined = " ".join(argv)
    assert "color=c=black:s=1080x1920" in joined
    assert "ass=" in joined
    assert argv[argv.index("-ss") + 1] == "29.700"
    assert argv[argv.index("-frames:v") + 1] == "1"
    assert argv[-1] == "preview.png"
