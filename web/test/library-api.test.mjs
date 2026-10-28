/**
 * Contrato de la API de la galería (RF-11): subir, listar, filtrar, cambiar categoría y
 * borrar. Se llaman los handlers reales de `app/api/library` con `Request` normales y el
 * índice en un directorio temporal (`OPENRANKS_JOBS_DIR`), sin servidor ni navegador.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-library-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;

// Se importan **después** de fijar el directorio: `paths.ts` lo lee al cargarse.
const { GET, POST } = await import("../app/api/library/route.ts");
const { PATCH, DELETE } = await import("../app/api/library/[id]/route.ts");

const BASE = "http://panel.local/api/library";

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const params = (id) => ({ params: Promise.resolve({ id }) });

/** Sube un clip con el mismo camino que el navegador: cuerpo en crudo y nombre en la URL. */
async function upload(name, bytes, category) {
  const query = new URLSearchParams({ name });
  if (category !== undefined) query.set("category", category);
  const response = await POST(
    new Request(`${BASE}?${query}`, { method: "POST", body: new Uint8Array(bytes) }),
  );
  return { response, payload: await response.json() };
}

async function listing(query = "") {
  const response = await GET(new Request(`${BASE}${query}`));
  return { response, payload: await response.json() };
}

test("subir un clip devuelve 201 y el índice sin rutas del host", async () => {
  const { response, payload } = await upload("gatos graciosos.mp4", [1, 2, 3, 4], "Gatos");

  assert.equal(response.status, 201);
  assert.equal(payload.item.name, "gatos graciosos.mp4");
  assert.equal(payload.item.ext, ".mp4");
  assert.equal(payload.item.bytes, 4);
  assert.equal(payload.item.category, "Gatos");
  assert.match(payload.item.id, /^[a-z0-9-]{6,64}$/);

  // El panel nunca ve una ruta del servidor: ni el directorio de trabajos ni `library/`.
  const json = JSON.stringify(payload);
  assert.equal(json.includes(JOBS_DIR), false);
  assert.equal(json.includes("library/"), false);
  assert.deepEqual(Object.keys(payload.item).sort(), [
    "addedAt",
    "bytes",
    "category",
    "ext",
    "id",
    "name",
  ]);
});

test("un formato no permitido falla con un error legible", async () => {
  const { response, payload } = await upload("notas.txt", [1, 2, 3]);
  assert.equal(response.status, 400);
  assert.match(payload.error, /formato/i);

  const empty = await upload("", [1]);
  assert.equal(empty.response.status, 400);
  assert.match(empty.payload.error, /nombre/i);
});

test("el índice y los originales sobreviven a un reinicio del panel", async () => {
  const indexFile = path.join(JOBS_DIR, "library.json");
  assert.equal(existsSync(indexFile), true, "el índice vive en disco, no en memoria");

  const index = JSON.parse(readFileSync(indexFile, "utf-8"));
  assert.equal(index.version, 1);
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].name, "gatos graciosos.mp4");
  assert.deepEqual(readdirSync(path.join(JOBS_DIR, "library")), [`${index.items[0].id}.mp4`]);
});

test("listar y filtrar por categoría, incluida «Sin categoría»", async () => {
  const sinCategoria = await upload("perros.mp4", [1], "");

  const all = await listing();
  assert.equal(all.response.status, 200);
  assert.equal(all.payload.items.length, 2);
  // Lo más reciente primero.
  assert.equal(all.payload.items[0].name, "perros.mp4");
  assert.equal(all.payload.categories.includes("Gatos"), true);

  const gatos = await listing("?category=Gatos");
  assert.deepEqual(
    gatos.payload.items.map((item) => item.name),
    ["gatos graciosos.mp4"],
  );
  // El autocompletado ve todas las categorías aunque haya filtro activo.
  assert.equal(gatos.payload.categories.length, 1);

  const none = await listing("?category=");
  assert.deepEqual(
    none.payload.items.map((item) => item.name),
    ["perros.mp4"],
  );

  const vacio = await listing("?category=Aves");
  assert.deepEqual(vacio.payload.items, []);

  assert.equal(sinCategoria.response.status, 201);
});

test("cambiar la categoría de un clip, con sus errores de contrato", async () => {
  const { payload } = await listing("?category=Gatos");
  const id = payload.items[0].id;

  const updated = await PATCH(
    new Request(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "  Gatos   épicos " }),
    }),
    params(id),
  );
  assert.equal(updated.status, 200);
  const body = await updated.json();
  assert.equal(body.item.category, "Gatos épicos");
  assert.equal(body.categories.includes("Gatos épicos"), true);

  const cleared = await PATCH(
    new Request(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: null }),
    }),
    params(id),
  );
  assert.equal((await cleared.json()).item.category, null);

  const sinCategoria = await PATCH(
    new Request(`${BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
    params(id),
  );
  assert.equal(sinCategoria.status, 400);

  const unknown = await PATCH(
    new Request(`${BASE}/no-existe-este-clip`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "X" }),
    }),
    params("no-existe-este-clip"),
  );
  assert.equal(unknown.status, 404);

  const unsafe = await PATCH(
    new Request(`${BASE}/..%2F..%2Fetc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "X" }),
    }),
    params("../../etc"),
  );
  assert.equal(unsafe.status, 400);
});

test("borrar quita la entrada del índice y el original del disco", async () => {
  const { payload } = await listing();
  const item = payload.items.find((entry) => entry.name === "gatos graciosos.mp4");
  const file = path.join(JOBS_DIR, "library", `${item.id}.mp4`);
  assert.equal(existsSync(file), true);

  const removed = await DELETE(new Request(`${BASE}/${item.id}`, { method: "DELETE" }), params(item.id));
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).item.id, item.id);
  assert.equal(existsSync(file), false, "el original se borra con la entrada");

  const after = await listing();
  assert.deepEqual(
    after.payload.items.map((entry) => entry.name),
    ["perros.mp4"],
    "los demás clips siguen en la galería",
  );

  const again = await DELETE(new Request(`${BASE}/${item.id}`, { method: "DELETE" }), params(item.id));
  assert.equal(again.status, 404);
});
