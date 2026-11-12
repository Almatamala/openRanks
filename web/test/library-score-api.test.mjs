/**
 * Contrato de la puntuación masiva de la galería (RF-21, P3-9): el borrado exige
 * confirmación y solo se lleva los clips **puntuados** por debajo del umbral. No hace
 * falta motor: se llaman los handlers reales con el índice en un directorio temporal.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-score-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;

// Se importan **después** de fijar el directorio: `paths.ts` lo lee al cargarse.
const { addLibraryItem, readLibrary } = await import("../lib/library.ts");
const { POST } = await import("../app/api/library/score/route.ts");

const URL = "http://panel.local/api/library/score";

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

function add(id, score) {
  return addLibraryItem({
    id,
    name: `${id}.mp4`,
    ext: ".mp4",
    bytes: 3,
    score,
    score_source: "heurístico",
    label: `TÍTULO ${id}`,
  });
}

async function post(body) {
  const response = await POST(
    new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, payload: await response.json() };
}

test("borrar sin confirmación no elimina nada", async () => {
  add("clip-alto", 80);
  add("clip-bajo", 40);

  const { response, payload } = await post({ action: "drop", threshold: 55 });
  assert.equal(response.status, 400);
  assert.match(payload.error, /confirm/i);
  assert.equal(readLibrary().length, 2);
});

test("borrar elimina solo los puntuados por debajo del umbral", async () => {
  const { response, payload } = await post({
    action: "drop",
    threshold: 55,
    confirm: true,
  });

  assert.equal(response.status, 200);
  assert.equal(payload.threshold, 55);
  assert.deepEqual(payload.removed.map((clip) => clip.id), ["clip-bajo"]);
  assert.deepEqual(
    readLibrary().map((clip) => clip.id),
    ["clip-alto"],
  );
  // La respuesta no enseña rutas del host.
  assert.equal(JSON.stringify(payload).includes(JOBS_DIR), false);
});

test("un clip sin score no se toca: sin puntuación no hay veredicto", async () => {
  addLibraryItem({ id: "sin-score", name: "sin-score.mp4", ext: ".mp4", bytes: 3 });
  const { response, payload } = await post({
    action: "drop",
    threshold: 55,
    confirm: true,
  });

  assert.equal(response.status, 200);
  assert.equal(payload.removed.length, 0);
  assert.deepEqual(
    readLibrary().map((clip) => clip.id).sort(),
    ["clip-alto", "sin-score"],
  );
});

test("una acción desconocida falla con un mensaje legible", async () => {
  const { response, payload } = await post({ action: "inventada" });
  assert.equal(response.status, 400);
  assert.match(payload.error, /acción/i);
});
