/**
 * Puntuación masiva de la galería (RF-21, P3-9): umbral, título de edición e informe.
 * Sin DOM, sin disco y sin motor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildScoreReport,
  DEFAULT_SCORE_MIN,
  needsScore,
  parseScoreMode,
  parseScoreThreshold,
  titleFromName,
} from "../lib/gallery-score.ts";

function item(id, score, extra = {}) {
  return {
    id,
    name: `${id}.mp4`,
    ext: ".mp4",
    bytes: 100,
    category: null,
    score,
    score_source: "heurístico",
    ...extra,
  };
}

test("el umbral por defecto es 55 y un valor raro no lo deja sin límite", () => {
  assert.equal(DEFAULT_SCORE_MIN, 55);
  assert.equal(parseScoreThreshold(undefined), 55);
  assert.equal(parseScoreThreshold("60"), 60);
  assert.equal(parseScoreThreshold(-5), 0);
  assert.equal(parseScoreThreshold(150), 100);
  assert.equal(parseScoreThreshold("no-es-un-numero"), 55);
});

test("solo «all» vuelve a puntuar los clips ya puntuados", () => {
  assert.equal(parseScoreMode(undefined), "pending");
  assert.equal(parseScoreMode("pending"), "pending");
  assert.equal(parseScoreMode("cualquiera"), "pending");
  assert.equal(parseScoreMode("ALL"), "all");
  assert.equal(parseScoreMode(" all "), "all");
});

test("el título de edición sale del nombre y cabe en un rótulo", () => {
  assert.equal(titleFromName("gatos_graciosos.mp4"), "GATOS GRACIOSOS");
  assert.equal(titleFromName("escena-07.mkv"), "ESCENA 07");
  assert.equal(titleFromName("  perro.caos.mp4 "), "PERRO CAOS");
  assert.equal(titleFromName(""), "CLIP");

  const long = titleFromName("un-titulo-larguisimo-con-muchas-palabras.mp4");
  assert.equal(Array.from(long).length, 24);
});

test("necesita score solo si no es un entero 0-100", () => {
  assert.equal(needsScore(item("a", 0)), false);
  assert.equal(needsScore(item("b", 100)), false);
  assert.equal(needsScore(item("c", null)), true);
  assert.equal(needsScore(item("d", 55.5)), true);
  assert.equal(needsScore(item("e", -1)), true);
});

test("el informe ordena de mayor a menor y explica a quién se lleva", () => {
  const items = [
    item("medio", 60, { label: "MEDIO" }),
    item("alto", 90, { label: "ALTO" }),
    item("bajo", 40, { label: "BAJO" }),
    item("sin", null),
  ];
  const report = buildScoreReport(
    items,
    55,
    [{ name: "roto.mp4", error: "no se pudo leer" }],
    2,
    1,
  );

  assert.equal(report.threshold, 55);
  assert.deepEqual(report.clips.map((clip) => clip.id), ["alto", "medio", "bajo"]);
  assert.deepEqual(report.clips.map((clip) => clip.pass), [true, true, false]);
  assert.equal(report.clips[0].label, "ALTO");
  assert.equal(report.failed[0].name, "roto.mp4");
  assert.equal(report.scored, 2);
  assert.equal(report.alreadyScored, 1);
});

test("el informe desempata con el título y el id para ser determinista", () => {
  const items = [
    item("z", 70, { label: "B" }),
    item("y", 70, { label: "A" }),
    item("x", 70, { label: "A" }),
  ];
  const first = buildScoreReport(items, 55).clips.map((clip) => clip.id);
  const second = buildScoreReport([...items].reverse(), 55).clips.map((clip) => clip.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["x", "y", "z"]);
});
