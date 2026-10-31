/**
 * Trabajo de descarga (RF-16.5 y RF-16.6): estado en disco, avance, límites, cancelación y
 * «una a la vez». El proceso de `yt-dlp` se sustituye por un doble (sin red, sin binario
 * y sin descargar nada), pero el resto es el código real: directorio temporal, `job.json`,
 * limpieza y traducción de errores.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PassThrough } from "node:stream";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-extract-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;
delete process.env.OPENRANKS_SOURCE_MAX_MB;
delete process.env.OPENRANKS_SOURCE_MAX_MINUTES;

// Se importa **después** de fijar el directorio: `paths.ts` lo lee al cargarse.
const job = await import("../lib/extract-job.ts");

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const DECLARATION = { url: "https://www.youtube.com/watch?v=abc123", terms: true };

const downloader = () =>
  Promise.resolve({
    ready: true,
    version: "2026.10.27",
    source: "PATH",
    hint: null,
    binary: "yt-dlp",
  });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** Un `yt-dlp` de mentira: sus flujos, su `kill` y su cierre, como un proceso real. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", null, "SIGTERM");
  };
  return child;
}

/** El `spawn` de las pruebas: guarda con qué se llamó y devuelve el doble. */
function harness() {
  const spawns = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    spawns.push({ child, command, args, options });
    return child;
  };
  return { spawns, deps: { spawn, downloader } };
}

const tempNames = (id) =>
  existsSync(job.extractionDir(id))
    ? readdirSync(job.extractionDir(id)).filter((name) => name.startsWith("source."))
    : [];

test("descarga, publica el avance y cierra con el archivo temporal", async () => {
  const { spawns, deps } = harness();
  const started = await job.startExtraction(DECLARATION, deps);

  assert.equal(started.state, "downloading");
  assert.equal(started.progress, 0);
  assert.equal(started.source.platform, "youtube");
  assert.equal(started.source.url, DECLARATION.url);
  assert.deepEqual(started.limits, { maxMinutes: 60, maxMB: 2048 });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[spawns[0].args.length - 1], DECLARATION.url);
  assert.equal(spawns[0].command, "yt-dlp");

  spawns[0].child.stdout.write("[download]  50.0% of  10.00MiB at  1.00MiB/s ETA 00:03\n");
  assert.ok(await waitFor(() => job.readExtraction(started.id).progress === 50), "el avance llega al acta");
  const middle = job.readExtraction(started.id);
  assert.equal(middle.download.totalBytes, 10 * 1024 * 1024);
  assert.equal(middle.download.speed, "1MiB/s");
  assert.equal(middle.download.eta, "00:03");

  writeFileSync(path.join(job.extractionDir(started.id), "source.mp4"), Buffer.alloc(2048));
  await wait(20);
  spawns[0].child.emit("close", 0);

  const done = job.readExtraction(started.id);
  assert.equal(done.state, "done");
  assert.equal(done.progress, 100);
  assert.deepEqual(done.file, { name: "source.mp4", bytes: 2048 });
  job.cancelExtraction(started.id);
});

test("un vídeo privado falla con un mensaje legible y sin restos", async () => {
  const { spawns, deps } = harness();
  const started = await job.startExtraction(DECLARATION, deps);
  const dir = job.extractionDir(started.id);
  writeFileSync(path.join(dir, "source.mp4.part"), Buffer.alloc(64));

  spawns[0].child.stderr.write(
    "ERROR: [youtube] abc123: Private video. Sign in if you've been granted access\n",
  );
  await wait(20);
  spawns[0].child.emit("close", 1);

  const failed = job.readExtraction(started.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error, /privado o pide sesión/);
  assert.deepEqual(tempNames(started.id), [], "el temporal no se queda");
  assert.equal(failed.file, null);
  job.cancelExtraction(started.id);
});

test("cancelar borra el temporal y no deja trabajo a medias", async () => {
  const { spawns, deps } = harness();
  const started = await job.startExtraction(DECLARATION, deps);
  writeFileSync(path.join(job.extractionDir(started.id), "source.mp4.part"), Buffer.alloc(10));

  assert.equal(job.cancelExtraction(started.id), true);

  assert.equal(existsSync(job.extractionDir(started.id)), false);
  assert.equal(job.readExtraction(started.id), null);
  assert.equal(spawns[0].child.killed, true);
});

test("no se puede tener dos descargas a la vez", async () => {
  const { deps } = harness();
  const started = await job.startExtraction(DECLARATION, deps);

  await assert.rejects(
    () => job.startExtraction({ ...DECLARATION, url: "https://www.tiktok.com/@x/video/1" }, deps),
    (error) => error.status === 409 && /una descarga en marcha/.test(error.message),
  );

  job.cancelExtraction(started.id);
});

test("si la fuente pasa del límite de tamaño se corta y no deja archivo", async () => {
  const { spawns, deps } = harness();
  process.env.OPENRANKS_SOURCE_MAX_MB = "1";
  try {
    const started = await job.startExtraction(DECLARATION, deps);
    assert.equal(started.limits.maxMB, 1);

    writeFileSync(
      path.join(job.extractionDir(started.id), "source.mp4.part"),
      Buffer.alloc(Math.round(1.2 * 1024 * 1024)),
    );

    assert.ok(await waitFor(() => job.readExtraction(started.id).state === "failed", 4000));
    const failed = job.readExtraction(started.id);
    assert.match(failed.error, /1 MB/);
    assert.deepEqual(tempNames(started.id), []);
    assert.equal(spawns[0].child.killed, true);
    job.cancelExtraction(started.id);
  } finally {
    delete process.env.OPENRANKS_SOURCE_MAX_MB;
  }
});

test("una descarga que quedó a medias se da por interrumpida al leerla", () => {
  const id = "12345678-0000-4000-8000-000000000000";
  const dir = job.extractionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.mp4.part"), Buffer.alloc(10));
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "downloading",
      phase: "Descargando el vídeo",
      progress: 12,
      download: null,
      source: { url: "https://youtu.be/abc", platform: "youtube" },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: null,
      limits: { maxMinutes: 60, maxMB: 2048 },
    }),
  );

  const status = job.readExtraction(id);
  assert.equal(status.state, "failed");
  assert.match(status.error, /se interrumpió/);
  assert.equal(existsSync(path.join(dir, "source.mp4.part")), false);
  job.cancelExtraction(id);
});

test("no arranca sin enlace admitido, sin declaración ni sin yt-dlp", async () => {
  const { deps } = harness();

  await assert.rejects(
    () => job.startExtraction({ ...DECLARATION, url: "https://vimeo.com/123" }, deps),
    (error) => error.status === 400 && /YouTube y TikTok/.test(error.message),
  );
  await assert.rejects(
    () => job.startExtraction({ ...DECLARATION, terms: false }, deps),
    (error) => error.status === 400 && /términos de la plataforma/.test(error.message),
  );
  await assert.rejects(
    () =>
      job.startExtraction(DECLARATION, {
        ...deps,
        downloader: () =>
          Promise.resolve({
            ready: false,
            version: null,
            source: null,
            hint: "Falta yt-dlp, la herramienta que descarga el vídeo.",
            binary: null,
          }),
      }),
    (error) => error.status === 503 && /Falta yt-dlp/.test(error.message),
  );
});

test("un vídeo local se sube al área temporal y queda listo", async () => {
  const body = new Uint8Array([1, 2, 3, 4, 5]);
  const started = await job.startLocalExtraction({
    name: "compilado.MP4",
    bytes: body.length,
    terms: true,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  });

  assert.equal(started.state, "done");
  assert.equal(started.phase, "Vídeo listo");
  assert.deepEqual(started.source, { url: "", platform: null });
  assert.deepEqual(started.file, { name: "source.mp4", bytes: body.length });
  assert.deepEqual(tempNames(started.id), ["source.mp4"]);
  job.cancelExtraction(started.id);
});

test("el vídeo local exige la casilla y un formato de vídeo", async () => {
  const empty = () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

  await assert.rejects(
    () => job.startLocalExtraction({ name: "x.mp4", bytes: 0, terms: false, stream: empty() }),
    (error) => error.status === 400 && /términos/.test(error.message),
  );
  await assert.rejects(
    () => job.startLocalExtraction({ name: "x.txt", bytes: 0, terms: true, stream: empty() }),
    (error) => error.status === 400 && /formato/.test(error.message),
  );
});

test("un análisis en marcha no se da por interrumpido mientras su proceso vive", () => {
  const id = "42345678-0000-4000-8000-000000000000";
  const dir = job.extractionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.mp4"), Buffer.alloc(16));
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "analyzing",
      phase: "Extrayendo los clips",
      progress: 0,
      download: null,
      source: { url: "", platform: null },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: { name: "source.mp4", bytes: 16 },
      limits: { maxMinutes: 60, maxMB: 2048 },
      pid: process.pid,
    }),
  );

  // Otra ruta del panel (o el sondeo) lee el trabajo: no puede darlo por muerto.
  const status = job.readExtraction(id);
  assert.equal(status.state, "analyzing");
  assert.equal(existsSync(path.join(dir, "source.mp4")), true);
  job.cancelExtraction(id);
});

test("un análisis muerto sin resultados no borra el vídeo", () => {
  const id = "52345678-0000-4000-8000-000000000000";
  const dir = job.extractionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.mp4"), Buffer.alloc(16));
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "analyzing",
      phase: "Extrayendo los clips",
      progress: 0,
      download: null,
      source: { url: "", platform: null },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: { name: "source.mp4", bytes: 16 },
      limits: { maxMinutes: 60, maxMB: 2048 },
      pid: 99999999,
    }),
  );

  const status = job.readExtraction(id);
  assert.equal(status.state, "failed");
  assert.match(status.error, /No se pudo dividir el vídeo en escenas/);
  assert.equal(existsSync(path.join(dir, "source.mp4")), true, "el vídeo se conserva");
  job.cancelExtraction(id);
});

test("si el análisis terminó pero no llegó a escribir el estado, se lee del disco", () => {
  const id = "62345678-0000-4000-8000-000000000000";
  const dir = job.extractionDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.mp4"), Buffer.alloc(16));
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "analyzing",
      phase: "Extrayendo los clips",
      progress: 0,
      download: null,
      source: { url: "", platform: null },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: { name: "source.mp4", bytes: 16 },
      limits: { maxMinutes: 60, maxMB: 2048 },
      pid: 99999999,
    }),
  );
  writeFileSync(
    job.extractDocPath(id),
    JSON.stringify({ candidates: [{ index: 1, start_s: 0, end_s: 3, duration_s: 3 }], warnings: [] }),
  );

  const status = job.readExtraction(id);
  assert.equal(status.state, "done");
  assert.equal(status.candidates.length, 1);
  job.cancelExtraction(id);
});

test("el análisis deja candidatos y guarda la decisión de cada tramo", () => {
  const id = "22345678-0000-4000-8000-000000000000";
  const dir = job.extractionDir(id);
  mkdirSync(path.join(dir, "candidates"), { recursive: true });
  writeFileSync(path.join(dir, "source.mp4"), Buffer.alloc(16));
  writeFileSync(path.join(dir, "candidates", "01.jpg"), Buffer.alloc(8));
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
      file: { name: "source.mp4", bytes: 16 },
      limits: { maxMinutes: 60, maxMB: 2048 },
    }),
  );
  writeFileSync(
    job.extractDocPath(id),
    JSON.stringify({
      candidates: [
        { index: 1, start_s: 0, end_s: 12.5, duration_s: 12.5 },
        { index: 2, start_s: 12.7, end_s: 20, duration_s: 7.3 },
      ],
      warnings: ["Solo se propusieron 2 tramos válidos"],
    }),
  );

  const status = job.readExtraction(id);
  assert.equal(status.candidates.length, 2);
  assert.equal(status.candidates[0].verdict, "pending");
  assert.equal(status.candidates[1].duration, 7.3);
  assert.deepEqual(status.warnings, ["Solo se propusieron 2 tramos válidos"]);
  assert.ok(job.candidateThumbnail(id, 1).endsWith("01.jpg"));
  assert.equal(job.candidateThumbnail(id, 2), null, "sin miniatura no hay ruta");

  const approved = job.setCandidateVerdict(id, 1, "approved");
  assert.equal(approved.candidates[0].verdict, "approved");
  assert.equal(job.readExtraction(id).verdicts["1"], "approved");

  job.setCandidateVerdict(id, 1, "pending");
  assert.equal(job.readExtraction(id).candidates[0].verdict, "pending");
  assert.throws(() => job.setCandidateVerdict(id, 9, "approved"), /no existe/);
  assert.throws(() => job.setCandidateVerdict(id, 1, "quizá"), /no es válida/);
  job.cancelExtraction(id);
});

test("los errores de yt-dlp se traducen y no enseñan rutas", () => {
  const limits = { maxMinutes: 60, maxMB: 2048 };

  assert.match(job.friendlyDownloadError("ERROR: [youtube] x: Private video", limits), /privado/);
  assert.match(
    job.friendlyDownloadError("ERROR: [youtube] x: does not pass filter (duration > 3600)", limits),
    /60 min/,
  );
  assert.match(
    job.friendlyDownloadError("ERROR: File is larger than max-filesize (2048M)", limits),
    /2048 MB/,
  );
  assert.match(job.friendlyDownloadError("ERROR: Unsupported URL: https://x.test", limits), /plataforma admitida/);
  assert.match(job.friendlyDownloadError("ERROR: [tiktok] x: HTTP Error 404", limits), /ya no está disponible/);

  const leaked = job.friendlyDownloadError(
    `ERROR: unable to write to ${JOBS_DIR}${path.sep}extract${path.sep}abc${path.sep}source.mp4`,
    limits,
  );
  assert.equal(leaked.includes(JOBS_DIR), false, "sin rutas del host en el mensaje");
  assert.equal(job.friendlyDownloadError("", limits).length > 0, true, "siempre hay algo que decir");
});
