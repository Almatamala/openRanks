/**
 * Intercambio de puestos de la vista de montaje (RF-13), sin DOM: lo que se mueve es el
 * contenido de la casilla, nunca su número.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { swapSlots } from "../lib/slots.ts";

const slot = (position, imported) => ({ position, file: null, imported, label: `Puesto ${position}` });

test("arrastrar el #5 sobre el #1 intercambia ambos", () => {
  const slots = [slot(1, "clip-1.mp4"), slot(2, "clip-2.mp4"), slot(3, "clip-3.mp4"), slot(4, "clip-4.mp4"), slot(5, "clip-5.mp4")];

  const swapped = swapSlots(slots, 5, 1);

  assert.deepEqual(
    swapped.map((entry) => entry.position),
    [1, 2, 3, 4, 5],
    "los números de las casillas no cambian",
  );
  assert.equal(swapped[0].imported, "clip-5.mp4");
  assert.equal(swapped[4].imported, "clip-1.mp4");
  // El rótulo viaja con su clip: el puesto #1 muestra el nombre del que ganó el sitio.
  assert.equal(swapped[0].label, "Puesto 5");
  assert.equal(swapped[4].label, "Puesto 1");
});

test("los puestos que no se tocan quedan igual", () => {
  const slots = [slot(1, "a.mp4"), slot(2, "b.mp4"), slot(3, "c.mp4")];
  const swapped = swapSlots(slots, 1, 2);

  assert.equal(swapped[2], slots[2], "el #3 es el mismo objeto, sin copia de más");
  assert.equal(swapped[1].imported, "a.mp4");
  assert.equal(swapped[0].imported, "b.mp4");
});

test("no muta la lista original", () => {
  const slots = [slot(1, "a.mp4"), slot(2, "b.mp4")];
  swapSlots(slots, 1, 2);

  assert.equal(slots[0].imported, "a.mp4");
  assert.equal(slots[1].imported, "b.mp4");
});

test("mismo puesto o puesto inexistente no cambia nada", () => {
  const slots = [slot(1, "a.mp4"), slot(2, "b.mp4")];

  assert.equal(swapSlots(slots, 2, 2), slots);
  assert.equal(swapSlots(slots, 1, 9), slots);
  assert.equal(swapSlots([], 1, 2).length, 0);
});
