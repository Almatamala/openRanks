"""Contrato de entrada: posiciones y textos (RPD §9.5)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openranks.core.binding import Binding, BindingError, ClipItem, load_binding, validate_binding
from openranks.core.config import Config


def _items(count: int = 5) -> tuple[ClipItem, ...]:
    return tuple(ClipItem(position=index, path=Path(f"clip-{index}.mp4"), label=f"PUESTO {index}") for index in range(1, count + 1))


def test_duplicate_positions_are_rejected():
    items = tuple(ClipItem(position=position, path=Path(f"{position}.mp4"), label="CAOS") for position in (1, 2, 3, 4, 4))
    with pytest.raises(BindingError, match="posiciones"):
        validate_binding(Binding(title="TOP 5 GATOS", items=items), Config(), check_paths=False)


def test_wrong_item_count_is_rejected():
    with pytest.raises(BindingError, match="se esperan 5 puestos"):
        validate_binding(Binding(title="TOP 5 GATOS", items=_items(4)), Config(), check_paths=False)


def test_a_ranking_of_up_to_ten_positions_is_valid():
    for count in (5, 7, 10):
        binding = Binding(title=f"TOP {count} GATOS", items=_items(count))
        validate_binding(binding, Config(items=count), check_paths=False)


def test_a_ranking_outside_the_format_is_rejected():
    # Ni tres puestos ni once: el formato va del TOP 5 al TOP 10.
    with pytest.raises(BindingError, match="admite de 5 a 10 puestos"):
        validate_binding(Binding(title="TOP 3 GATOS", items=_items(3)), Config(items=3), check_paths=False)
    with pytest.raises(BindingError, match="admite de 5 a 10 puestos"):
        validate_binding(Binding(title="TOP 11 GATOS", items=_items(11)), Config(items=11), check_paths=False)


def test_label_over_char_limit_is_rejected():
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="X" * 25)
    with pytest.raises(BindingError, match="caracteres"):
        validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_a_label_with_many_words_is_accepted_if_it_fits_in_characters():
    # El rótulo se mide por ancho (caracteres), no por número de palabras.
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="A B C D E F G")
    validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_empty_label_is_rejected():
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="   ")
    with pytest.raises(BindingError, match="no tiene nombre"):
        validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_title_over_limit_is_rejected():
    with pytest.raises(BindingError, match="título"):
        validate_binding(Binding(title="X" * 41, items=_items()), Config(), check_paths=False)


def test_the_subtitle_is_optional_but_has_the_same_length_limit_as_a_title_layer():
    validate_binding(Binding(title="TOP 5 GATOS", items=_items(), subtitle="MOMENTOS LOCOS"), Config(), check_paths=False)
    with pytest.raises(BindingError, match="subtítulo"):
        validate_binding(Binding(title="TOP 5 GATOS", items=_items(), subtitle="X" * 41), Config(), check_paths=False)


def test_title_length_ignores_the_colour_marks():
    # El panel cuenta 40 visibles aunque haya 42 caracteres con las marcas; el motor
    # tiene que aceptar exactamente lo mismo.
    validate_binding(Binding(title="*" + "X" * 40 + "*", items=_items()), Config(), check_paths=False)


def test_missing_file_is_reported(tmp_path):
    items = tuple(
        ClipItem(position=index, path=tmp_path / f"falta-{index}.mp4", label=f"PUESTO {index}") for index in range(1, 6)
    )
    with pytest.raises(BindingError, match="no existe el archivo"):
        validate_binding(Binding(title="TOP 5 GATOS", items=items), Config())


def test_load_binding_resolves_paths_relative_to_the_json(tmp_path):
    clips_dir = tmp_path / "clips"
    clips_dir.mkdir()
    entries = []
    for index in range(1, 6):
        clip = clips_dir / f"clip-{index}.mp4"
        clip.write_bytes(b"x")
        entries.append({"position": index, "path": f"clips/clip-{index}.mp4", "label": f"PUESTO {index}"})
    binding_path = tmp_path / "binding.json"
    binding_path.write_text(
        json.dumps({"title": "TOP 5 GATOS", "subtitle": "LOS MÁS LOCOS", "items": entries}), encoding="utf-8"
    )

    binding = load_binding(binding_path, Config())
    assert len(binding.items) == 5
    assert binding.subtitle == "LOS MÁS LOCOS"
    assert all(item.path.is_file() for item in binding.items)


def test_invalid_json_is_reported(tmp_path):
    broken = tmp_path / "broken.json"
    broken.write_text("{no soy json", encoding="utf-8")
    with pytest.raises(BindingError, match="JSON válido"):
        load_binding(broken, Config())
