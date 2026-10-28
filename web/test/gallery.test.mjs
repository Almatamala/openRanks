/**
 * Lógica pura de la galería (RF-11 y RF-12): formato aceptado, categorías, filtro,
 * selección ordenada y límites 5-10. Sin DOM, sin disco, sin servidor (`node --test`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canGenerate,
  canSelect,
  categoriesOf,
  categoryKey,
  extensionOf,
  filterItems,
  missingForGeneration,
  normalizeCategory,
  SELECTION_MAX,
  SELECTION_MIN,
  selectionPosition,
  toggleSelection,
} from "../lib/gallery.ts";

const clip = (id, category) => ({ id, category });

test("extensionOf acepta los formatos de la galería y saca la extensión del nombre", () => {
  assert.equal(extensionOf("final.mp4"), ".mp4");
  assert.equal(extensionOf("FINAL.MP4"), ".mp4");
  assert.equal(extensionOf("viaje.MoV"), ".mov");
  assert.equal(extensionOf("C:\\videos\\clip.mkv"), ".mkv");
  assert.equal(extensionOf("/tmp/otro.webm"), ".webm");
  assert.equal(extensionOf("clip.m4v"), ".m4v");
  assert.equal(extensionOf("clip.avi"), ".avi");
});

test("extensionOf rechaza lo que no es vídeo o no trae formato", () => {
  assert.equal(extensionOf("notas.txt"), null);
  assert.equal(extensionOf("sin-extension"), null);
  assert.equal(extensionOf(".mp4"), null);
  assert.equal(extensionOf(""), null);
  assert.equal(extensionOf(undefined), null);
});

test("normalizeCategory recorta, colapsa espacios y vacío es «Sin categoría»", () => {
  assert.equal(normalizeCategory("  Gatos  "), "Gatos");
  assert.equal(normalizeCategory("Gatos   graciosos"), "Gatos graciosos");
  assert.equal(normalizeCategory("   "), null);
  assert.equal(normalizeCategory(""), null);
  assert.equal(normalizeCategory(null), null);
  assert.equal(normalizeCategory(7), null);
});

test("categoryKey compara sin distinguir mayúsculas ni acentos de composición", () => {
  assert.equal(categoryKey("Gatos"), categoryKey("gatos"));
  assert.equal(categoryKey(null), "");
  // NFC: la misma «é» escrita de dos formas es la misma categoría.
  assert.equal(categoryKey("cafe\u0301"), categoryKey("caf\u00e9"));
});

test("filterItems: sin filtro todo, con texto por categoría y `null` los sin categoría", () => {
  const items = [clip("a", "Gatos"), clip("b", "Perros"), clip("c", null)];

  assert.deepEqual(
    filterItems(items, undefined).map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    filterItems(items, "gatos").map((item) => item.id),
    ["a"],
  );
  assert.deepEqual(
    filterItems(items, null).map((item) => item.id),
    ["c"],
  );
  assert.deepEqual(filterItems(items, "Aves"), []);
});

test("categoriesOf no repite por mayúsculas, ordena y omite la vacía", () => {
  const items = [clip("a", "Perros"), clip("b", "aves"), clip("c", null), clip("d", "Perros")];
  assert.deepEqual(categoriesOf(items), ["aves", "Perros"]);
  assert.deepEqual(categoriesOf([]), []);
});

test("el orden de selección fija el puesto: el primero es #1", () => {
  const selected = ["clip-c", "clip-a", "clip-b"];
  assert.equal(selectionPosition(selected, "clip-c"), 1);
  assert.equal(selectionPosition(selected, "clip-a"), 2);
  assert.equal(selectionPosition(selected, "clip-b"), 3);
  assert.equal(selectionPosition(selected, "clip-z"), null);
});

test("toggleSelection añade al final, quita y renumera sin huecos", () => {
  let selected = [];
  for (const id of ["a", "b", "c", "d"]) selected = toggleSelection(selected, id);
  assert.deepEqual(selected, ["a", "b", "c", "d"]);
  assert.equal(selectionPosition(selected, "d"), 4);

  selected = toggleSelection(selected, "b");
  assert.deepEqual(selected, ["a", "c", "d"]);
  // Los que quedan se renumeran solos: el puesto es la posición dentro de la lista.
  assert.equal(selectionPosition(selected, "c"), 2);
  assert.equal(selectionPosition(selected, "d"), 3);

  selected = toggleSelection(selected, "b");
  assert.deepEqual(selected, ["a", "c", "d", "b"]);
  assert.equal(selectionPosition(selected, "b"), 4);
});

test("no se pueden seleccionar más de 10 clips", () => {
  let selected = [];
  for (let index = 1; index <= SELECTION_MAX; index += 1) selected = toggleSelection(selected, `clip-${index}`);
  assert.equal(selected.length, 10);

  const overflow = toggleSelection(selected, "clip-11");
  assert.deepEqual(overflow, selected, "el 11.º no entra");
  assert.equal(canSelect(selected, "clip-11"), false);
  assert.equal(canSelect(selected, "clip-1"), true, "una tarjeta ya elegida se puede desmarcar");

  // Con hueco vuelve a entrar, al final.
  const withRoom = toggleSelection(toggleSelection(selected, "clip-1"), "clip-11");
  assert.equal(withRoom.length, 10);
  assert.equal(selectionPosition(withRoom, "clip-11"), 10);
});

test("«Generar manual» pide entre 5 y 10 y avisa cuántos faltan", () => {
  assert.equal(SELECTION_MIN, 5);
  assert.equal(SELECTION_MAX, 10);

  assert.equal(canGenerate([]), false);
  assert.equal(missingForGeneration([]), 5);
  assert.equal(canGenerate(["a", "b", "c", "d"]), false);
  assert.equal(missingForGeneration(["a", "b", "c", "d"]), 1);

  const five = ["a", "b", "c", "d", "e"];
  assert.equal(canGenerate(five), true);
  assert.equal(missingForGeneration(five), 0);

  const ten = Array.from({ length: 10 }, (_, index) => `clip-${index}`);
  assert.equal(canGenerate(ten), true);
  assert.equal(missingForGeneration(ten), 0);
  assert.equal(canGenerate([...ten, "clip-extra"]), false, "más de 10 no es un ranking válido");
});
