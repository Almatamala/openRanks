/**
 * Selección automática (RF-19, P3-7): 5-10, orden por score, diversidad, 30-58 s y
 * explicación determinista. Sin DOM, sin disco y sin proveedor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_MAX_PER_CATEGORY,
  AUTO_MAX_TOTAL_S,
  AUTO_MIN_TOTAL_S,
  autoReadiness,
  suggestAutoSelection,
} from "../lib/auto-select.ts";

/** Un clip de galería mínimo, con los campos que usa el automático. */
function clip(id, score, duration_s, category = null, extra = {}) {
  return {
    id,
    name: `${id}.mp4`,
    ext: ".mp4",
    bytes: 100,
    category,
    score,
    duration_s,
    score_source: "heurístico",
    ...extra,
  };
}

function many(count, { score = 50, duration = 4, category = "Gatos" } = {}) {
  return Array.from({ length: count }, (_, index) =>
    clip(`clip-${index + 1}`, score === 50 ? 50 + index : score, duration, category),
  );
}

test("con 10 clips puntuados elige 10, mejor primero y el #1 es el de mayor score", () => {
  // Una categoría por clip: la diversidad no recorta el conteo en este caso.
  const items = many(10, { duration: 4 }).map((item, index) => ({
    ...item,
    score: 10 * (index + 1),
    category: `Categoría ${index + 1}`,
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  const { clips, total_s } = result.proposal;

  assert.equal(clips.length, 10);
  assert.equal(total_s, 40);
  assert.deepEqual(
    clips.map((entry) => entry.score),
    [100, 90, 80, 70, 60, 50, 40, 30, 20, 10],
    "la propuesta va del #1 (mejor) al último",
  );
  assert.equal(new Set(clips.map((entry) => entry.id)).size, 10, "no repite clip");
  assert.equal(clips[0].score, Math.max(...items.map((item) => item.score)));
});

test("nunca elige más de 10 aunque haya más candidatos", () => {
  const items = many(14, { duration: 3 }).map((item, index) => ({
    ...item,
    score: index + 1,
    category: `Categoría ${index + 1}`,
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.clips.length, 10);
  assert.equal(result.proposal.total_s, 30);
  // Los diez mejores: 14..5.
  assert.deepEqual(
    result.proposal.clips.map((entry) => entry.score),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5],
  );
});

test("respeta el techo de 58 s", () => {
  const items = many(10, { duration: 7 }).map((item, index) => ({
    ...item,
    score: index + 1,
    category: `Categoría ${index + 1}`,
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.total_s <= AUTO_MAX_TOTAL_S, true);
  assert.equal(result.proposal.clips.length, 8, "9 clips de 7 s pasarían de 58 s");
  assert.equal(result.proposal.total_s, 56);
  assert.equal(result.proposal.clips[0].score, 10);
});

test("diversifica por categoría mientras hay recambio", () => {
  // Cinco categorías, dos clips de 6 s en cada una: nueve caben en 54 s y ninguna
  // categoría puede aportar más de dos.
  const categories = ["Gatos", "Perros", "Aves", "Caballos", "Conejos"];
  const items = [];
  let score = 100;
  for (const category of categories) {
    for (let index = 0; index < 2; index += 1) {
      items.push(clip(`clip-${items.length + 1}`, score, 6, category));
      score -= 1;
    }
  }

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  const counts = new Map();
  for (const entry of result.proposal.clips) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  assert.equal(result.proposal.clips.length, 9);
  assert.equal(
    [...counts.values()].every((count) => count <= AUTO_MAX_PER_CATEGORY),
    true,
    `reparto por categoría: ${JSON.stringify([...counts])}`,
  );
});

test("completa sin el tope por categoría cuando no llega a 5", () => {
  const items = many(5, { duration: 3, category: "Gatos" }).map((item, index) => ({
    ...item,
    score: 90 - index,
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.clips.length, 5, "el formato manda sobre la variedad");
  assert.equal(result.proposal.total_s, 15);
});

test("ignora duplicados, clips sin score y clips sin duración medida", () => {
  const valid = many(5, { duration: 4 });
  const items = [
    ...valid,
    clip("duplicado", 99, 4, "Gatos", { duplicateOf: "clip-1" }),
    { ...clip("sin-score", 80, 4), score: null },
    { ...clip("sin-duracion", 80, 4), duration_s: null },
  ];

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.clips.length, 5);
  assert.equal(result.proposal.ignored, 3);
  assert.equal(
    result.proposal.clips.every((entry) => !["duplicado", "sin-score", "sin-duracion"].includes(entry.id)),
    true,
  );
});

test("sin 5 clips puntuados no propone y explica el motivo", () => {
  const result = suggestAutoSelection(many(4, { duration: 4 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /al menos 5/i);

  const noScores = many(10, { duration: 4 }).map((item) => ({ ...item, score: null }));
  assert.equal(autoReadiness(noScores).ready, false);
  assert.match(autoReadiness(noScores).reason, /al menos 5/i);
  assert.equal(autoReadiness(null).ready, false);
});

test("si 5 clips no caben en 58 s, no propone", () => {
  const result = suggestAutoSelection(many(5, { duration: 30 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /58 s/i);
});

test("si la suma queda por debajo de 30 s, propone y avisa", () => {
  const result = suggestAutoSelection(many(5, { duration: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.proposal.total_s, 10);
  assert.equal(result.proposal.warnings.length, 1);
  assert.match(result.proposal.warnings[0], /30 s/);
});

test("cambia el peor clip por uno largo para alcanzar los 30 s", () => {
  const short = many(10, { duration: 2 }).map((item, index) => ({
    ...item,
    score: 100 - index,
    category: `Categoría ${index + 1}`,
  }));
  const long = clip("largo", 1, 20, "Caballos");

  const result = suggestAutoSelection([...short, long]);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.clips.length, 10);
  assert.equal(result.proposal.clips.some((entry) => entry.id === "largo"), true);
  assert.equal(result.proposal.total_s >= AUTO_MIN_TOTAL_S, true);
  assert.equal(result.proposal.total_s <= AUTO_MAX_TOTAL_S, true);
  assert.deepEqual(result.proposal.warnings, []);
});

test("la propuesta produce puestos ascendentes en reproducción y el #1 con el mayor score", () => {
  const items = many(10, { duration: 4 }).map((item, index) => ({
    ...item,
    // Scores desordenados a propósito: el automático no depende del orden de la galería.
    score: [42, 91, 17, 66, 88, 5, 73, 54, 99, 30][index],
    category: `Categoría ${index + 1}`,
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  const { clips } = result.proposal;

  // El import asigna el puesto por el índice de la selección: primero = #1.
  const position = new Map(clips.map((entry, index) => [entry.id, index + 1]));
  const playback = [...clips].reverse();

  assert.deepEqual(
    playback.map((entry) => position.get(entry.id)),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  );
  assert.deepEqual(
    playback.map((entry) => entry.score),
    [...playback.map((entry) => entry.score)].sort((left, right) => left - right),
    "el spec reproduce de menor a mayor score",
  );
  assert.equal(position.get(clips[0].id), 1);
  assert.equal(clips[0].score, 99);
});

test("usa el score ya calculado y conserva su fuente, venga del LLM o del heurístico", () => {
  const items = many(5, { duration: 6 }).map((item, index) => ({
    ...item,
    score: 70 + index,
    category: `Categoría ${index + 1}`,
    // El de mayor score (el #1) es el que trae el refinamiento del LLM.
    score_source: index === 4 ? "llm" : "heurístico",
  }));

  const result = suggestAutoSelection(items);
  assert.equal(result.ok, true);
  assert.equal(result.proposal.clips[0].score_source, "llm");
  assert.equal(result.proposal.clips[1].score_source, "heurístico");
  assert.equal(autoReadiness(items).ready, true);
});

test("el orden es determinista con empates de score y duración", () => {
  const items = [
    clip("zeta", 80, 4),
    clip("alfa", 80, 4),
    clip("beta", 80, 4),
    clip("gamma", 80, 4),
    clip("delta", 80, 4),
  ];

  const first = suggestAutoSelection(items);
  const second = suggestAutoSelection([...items].reverse());
  assert.equal(first.ok && second.ok, true);
  assert.deepEqual(
    first.proposal.clips.map((entry) => entry.id),
    ["alfa", "beta", "delta", "gamma", "zeta"],
  );
  assert.deepEqual(
    first.proposal.clips.map((entry) => entry.id),
    second.proposal.clips.map((entry) => entry.id),
  );
});
