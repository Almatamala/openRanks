/**
 * Contrato de la API de extracción (RF-16): estado de la herramienta, rechazos que se
 * saben antes de descargar y descargas que no existen. Se llaman los handlers reales con
 * `Request` normales, sin servidor ni navegador.
 *
 * En este fichero **no hay `yt-dlp`**: el `PATH` se vacía y la raíz del proyecto apunta a
 * un directorio temporal (sin `.venv`), así que la detección falla siempre y el 503 es el
 * mismo en cualquier máquina.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-extract-api-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;
process.env.OPENRANKS_ROOT = JOBS_DIR;
delete process.env.OPENRANKS_YTDLP;
process.env.PATH = "";

// Se importan **después** de fijar el entorno.
const { GET, POST } = await import("../app/api/extract/route.ts");
const { GET: GET_ONE, DELETE } = await import("../app/api/extract/[id]/route.ts");
const { POST: POST_LOCAL } = await import("../app/api/extract/local/route.ts");
const { GET: GET_SOURCE } = await import("../app/api/extract/[id]/source/route.ts");

const BASE = "http://panel.local/api/extract";

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const params = (id) => ({ params: Promise.resolve({ id }) });

const DECLARATION = { url: "https://www.youtube.com/watch?v=abc123", terms: true };

async function create(body = DECLARATION) {
  const response = await POST(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, payload: await response.json() };
}

test("el estado de la descarga no enseña el ejecutable ni rutas", async () => {
  const response = await GET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.downloader.ready, false);
  assert.match(payload.downloader.hint, /yt-dlp/);
  assert.deepEqual(Object.keys(payload.downloader).sort(), ["hint", "ready", "source", "version"]);
  assert.equal(payload.current, null, "no hay descarga en marcha");
  assert.equal(JSON.stringify(payload).includes(JOBS_DIR), false);
});

test("sin yt-dlp la descarga no arranca y dice qué instalar", async () => {
  const { response, payload } = await create();

  assert.equal(response.status, 503);
  assert.match(payload.error, /yt-dlp/);
  // No se crea ni un directorio: ni temporal ni trabajo a medias.
  assert.equal(existsSync(path.join(JOBS_DIR, "extract")), false);
});

test("un enlace no admitido o sin la casilla se rechazan antes de nada", async () => {
  const other = await create({ ...DECLARATION, url: "https://vimeo.com/123" });
  assert.equal(other.response.status, 400);
  assert.match(other.payload.error, /YouTube, TikTok e Instagram/);

  const noTerms = await create({ ...DECLARATION, terms: false });
  assert.equal(noTerms.response.status, 400);
  assert.match(noTerms.payload.error, /términos de la plataforma/);

  // La casilla tiene que ser un `true` de verdad, no un texto que la parezca.
  const textTerms = await create({ ...DECLARATION, terms: "sí" });
  assert.equal(textTerms.response.status, 400);
  assert.match(textTerms.payload.error, /términos de la plataforma/);

  // Un cuerpo que no es JSON tampoco entra.
  const broken = await POST(new Request(BASE, { method: "POST", body: "no es json" }));
  assert.equal(broken.status, 400);
});

test("una descarga que no existe responde 404 y un id inválido 400", async () => {
  const id = "12345678-0000-4000-8000-000000000000";
  const missing = await GET_ONE(new Request(`${BASE}/${id}`), params(id));
  assert.equal(missing.status, 404);

  const removed = await DELETE(new Request(`${BASE}/${id}`, { method: "DELETE" }), params(id));
  assert.equal(removed.status, 404);

  const unsafe = await GET_ONE(new Request(`${BASE}/..%2F..%2Fetc`), params("../../etc"));
  assert.equal(unsafe.status, 400);
  assert.deepEqual(readdirSync(JOBS_DIR), [], "nada se escribió en el directorio de trabajos");
});

test("la fuente temporal se sirve por rangos para reproducir los tramos", async () => {
  const id = "a2345678-0000-4000-8000-000000000000";
  const dir = path.join(JOBS_DIR, "extract", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.mp4"), Buffer.from([1, 2, 3, 4, 5, 6]));
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "done",
      phase: "Tramos propuestos",
      progress: 100,
      download: null,
      source: { url: "", platform: null },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: { name: "source.mp4", bytes: 6 },
      limits: { maxMinutes: 60, maxMB: 2048 },
    }),
  );

  const whole = await GET_SOURCE(new Request(`${BASE}/${id}/source`), params(id));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.deepEqual([...new Uint8Array(await whole.arrayBuffer())], [1, 2, 3, 4, 5, 6]);

  const partial = await GET_SOURCE(
    new Request(`${BASE}/${id}/source`, { headers: { Range: "bytes=1-3" } }),
    params(id),
  );
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 1-3/6");
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [2, 3, 4]);

  const missing = await GET_SOURCE(
    new Request(`${BASE}/12345678-0000-4000-8000-000000000000/source`),
    params("12345678-0000-4000-8000-000000000000"),
  );
  assert.equal(missing.status, 404);

  rmSync(dir, { recursive: true, force: true });
});

test("un vídeo local se sube al área temporal con la casilla marcada", async () => {
  const body = new Uint8Array([1, 2, 3, 4]);

  const refused = await POST_LOCAL(
    new Request(`${BASE}/local?name=compilado.mp4`, { method: "POST", body }),
  );
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /términos/);

  const response = await POST_LOCAL(
    new Request(`${BASE}/local?name=compilado.mp4&terms=1`, { method: "POST", body }),
  );
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.extraction.state, "done");
  assert.equal(payload.extraction.file.name, "source.mp4");
  assert.equal(payload.extraction.file.bytes, body.length);
  assert.equal(JSON.stringify(payload).includes(JOBS_DIR), false);
});
