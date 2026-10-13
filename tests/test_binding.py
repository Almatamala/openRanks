"""Contrato de entrada: posiciones, textos (§9.5) y orden de reproducción."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from openranks.core.binding import Binding, BindingError, ClipItem, load_binding, slugify, validate_binding
from openranks.core.config import Config


def _items(count: int = 5) -> tuple[ClipItem, ...]:
    return tuple(ClipItem(position=index, path=Path(f"clip-{index}.mp4"), label=f"PUESTO {index}") for index in range(1, count + 1))


def _binding(**overrides) -> Binding:
    payload = {"title": "TOP 5 GATOS", "items": _items()}
    payload.update(overrides)
    return Binding(**payload)


def test_ordered_goes_from_last_position_to_first():
    binding = _binding()
    assert [item.position for item in binding.ordered] == [5, 4, 3, 2, 1]


def test_best_is_position_one():
    assert _binding().best.position == 1


def test_valid_binding_passes_without_path_checks():
    validate_binding(_binding(), Config(), check_paths=False)


def test_duplicate_positions_are_rejected():
    items = tuple(ClipItem(position=position, path=Path(f"{position}.mp4"), label="CAOS") for position in (1, 2, 3, 4, 4))
    with pytest.raises(BindingError, match="posiciones"):
        validate_binding(Binding(title="TOP 5 GATOS", items=items), Config(), check_paths=False)


def test_wrong_item_count_is_rejected():
    with pytest.raises(BindingError, match="se esperan 5 puestos"):
        validate_binding(Binding(title="TOP 5 GATOS", items=_items(4)), Config(), check_paths=False)


def test_label_over_char_limit_is_rejected():
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="X" * 25)
    with pytest.raises(BindingError, match="caracteres"):
        validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_label_over_word_limit_is_rejected():
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="UNO DOS TRES CUATRO CINCO")
    with pytest.raises(BindingError, match="palabras"):
        validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_empty_label_is_rejected():
    items = list(_items())
    items[0] = ClipItem(position=1, path=items[0].path, label="   ")
    with pytest.raises(BindingError, match="no tiene nombre"):
        validate_binding(Binding(title="TOP 5 GATOS", items=tuple(items)), Config(), check_paths=False)


def test_title_layer_over_limit_is_rejected():
    binding = Binding(title="TOP 5 GATOS", items=_items(), title_layers=("X" * 29,))
    with pytest.raises(BindingError, match="capa de título 1"):
        validate_binding(binding, Config(), check_paths=False)


def test_too_many_title_layers_are_rejected():
    binding = Binding(title="TOP 5 GATOS", items=_items(), title_layers=("TOP", "5", "GATOS", "EXTRA"))
    with pytest.raises(BindingError, match="capas de título"):
        validate_binding(binding, Config(), check_paths=False)


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
    binding_path.write_text(json.dumps({"title": "TOP 5 GATOS", "items": entries}), encoding="utf-8")

    binding = load_binding(binding_path, Config())
    assert len(binding.items) == 5
    assert all(item.path.is_file() for item in binding.items)


def test_invalid_json_is_reported(tmp_path):
    broken = tmp_path / "broken.json"
    broken.write_text("{no soy json", encoding="utf-8")
    with pytest.raises(BindingError, match="JSON válido"):
        load_binding(broken, Config())


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("GATO VOLADOR!!", "gato-volador"), ("Canción de cuna", "cancion-de-cuna"), ("   ", "clip"), ("¡¡¡CAOS!!!", "caos")],
)
def test_slugify(raw, expected):
    assert slugify(raw) == expected
