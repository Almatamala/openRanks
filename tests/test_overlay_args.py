"""Overlay de L2 sin FFmpeg: script ASS, colores, rutas y argv (§9.2, §20.1)."""

from __future__ import annotations

from pathlib import Path

import pytest

from openranks.core.config import Config
from openranks.core.overlay import (
    DEFAULT_STYLE,
    ass_color,
    ass_time,
    build_ass,
    cover_argv,
    escape_filter_path,
    get_style,
    overlay_argv,
    preview_argv,
    video_chain,
    zoom_filter,
)
from openranks.core.specs import build_spec


def _style() -> dict:
    """Preset con la fuente fija de fábrica.

    Estos tests hablan de la **forma** del script ASS, no de qué fuente hay instalada:
    si `OPENRANKS_FONT` está definido (lo está en CI), el preset efectivo cambia y las
    aserciones sobre el nombre de la fuente dejarían de ser deterministas.
    """
    style = get_style()
    style["font"] = DEFAULT_STYLE["font"]
    return style


def _spec(*, zoom: float = 0.0) -> dict:
    segments = [
        {"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(5, 0, -1)
    ]
    return build_spec(
        title="TOP 5 GATOS",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=segments,
        transition_s=0.0,
        transition="cut",
        cold_open_s=0.0,
        style=_style(),
        config=Config(),
        zoom=zoom,
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
    # 1 título + 5 tramos nítidos + 8 atenuados (las 4 casillas que aún no han llegado y
    # las 4 ya pasadas; el 1 cierra el vídeo y no se atenúa después) + 5 rótulos + 1 CTA
    assert script.count("\nDialogue:") == 20


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


def test_ass_labels_arrive_with_their_clip_and_stay_to_the_end():
    script = build_ass(_spec(), _style(), Config())
    labels = [line for line in script.splitlines() if ",Label," in line]
    assert len(labels) == 5
    # El primero entra con su clip y ya no se va: los rótulos se acumulan.
    assert labels[0].startswith("Dialogue: 0,0:00:00.00,0:00:35.00") and "RÓTULO 5" in labels[0]
    # El último entra al final y también se queda hasta el cierre.
    assert labels[-1].startswith("Dialogue: 0,0:00:28.00,0:00:35.00") and "RÓTULO 1" in labels[-1]
    # Anclaje a la izquierda (\an4) y a la altura de su casilla, no en una posición fija.
    assert "\\an4" in labels[0]
    style = _style()
    x = float(style["rank_ladder"]["x"]) + float(style["clip_label"]["dx"])
    y = float(style["rank_ladder"]["y_bottom"])
    assert f"\\pos({x},{y})" in labels[0]


def test_ass_title_paints_marked_words_in_the_two_accents():
    segments = [{"position": position, "label": f"PUESTO {position}", "duration_s": 7.0} for position in range(5, 0, -1)]
    spec = build_spec(
        title="TOP *5* _GATOS_",
        labels={position: f"RÓTULO {position}" for position in range(1, 6)},
        segments=segments,
        transition_s=0.0,
        transition="cut",
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
        transition_s=0.0,
        transition="cut",
        cold_open_s=0.0,
        style=_style(),
        config=Config(),
    )
    script = build_ass(spec, _style(), Config())
    assert r"\{GATOS\}" in script
    assert r"CAOS \\ TOTAL" in script


def test_title_background_switches_to_the_opaque_box_style():
    style = _style()
    style["title"]["background"] = True
    script = build_ass(_spec(), style, Config())
    assert "Style: TitleBg," in script
    title_line = next(line for line in script.splitlines() if ",TitleBg," in line)
    assert "\\an5\\pos(540,168)" in title_line
    # Sin fondo, el título se dibuja con el estilo normal (contorno, no caja).
    assert ",TitleBg," not in build_ass(_spec(), _style(), Config())


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
    spec = _spec()
    argv = overlay_argv("ffmpeg", Path("union.mp4"), Path("ranking.mp4"), ass_file=Path("work/overlay.ass"), spec=spec, config=Config())
    assert argv[0] == "ffmpeg"
    assert "ass=" in argv[argv.index("-vf") + 1]
    # El audio no se recodifica: L1 ya lo dejó a −14 LUFS.
    assert argv[argv.index("-c:a") + 1] == "copy"
    assert argv[argv.index("-map_metadata") + 1] == "-1"
    assert argv[-1] == "ranking.mp4"


def test_no_zoom_means_no_zoompan_filter():
    assert zoom_filter(_spec(), Config()) is None
    assert "zoompan" not in video_chain(_spec(), Path("o.ass"), Config())


def test_zoom_filter_ramps_in_and_returns_after_the_first_clip():
    filt = zoom_filter(_spec(zoom=0.08), Config())
    assert filt is not None and filt.startswith("zoompan=")
    assert "min(1+0.0800*on/12" in filt
    assert "s=1080x1920:fps=30" in filt


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


def test_cover_argv_seeks_before_the_input():
    argv = cover_argv("ffmpeg", Path("ranking.mp4"), Path("cover.jpg"), at_s=34.6)
    assert argv[argv.index("-ss") + 1] == "34.600"
    assert argv.index("-ss") < argv.index("-i")
    assert argv[-1] == "cover.jpg"


def test_preview_argv_draws_the_overlay_over_a_black_source():
    argv = preview_argv("ffmpeg", Path("preview.png"), ass_file=Path("work/preview.ass"), at_s=29.7, config=Config())
    joined = " ".join(argv)
    assert "color=c=black:s=1080x1920" in joined
    assert "ass=" in joined
    assert argv[argv.index("-ss") + 1] == "29.700"
    assert argv[argv.index("-frames:v") + 1] == "1"
    assert argv[-1] == "preview.png"
