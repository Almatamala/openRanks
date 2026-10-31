/**
 * Aterrizaje de tramos aprobados (P3-4): recorte real con FFmpeg, alta en la galería con
 * procedencia y duración, deduplicación por SHA-256 y borrado del temporal al cerrar.
 * El motor es el de verdad (Python + FFmpeg estático de npm): sin red y sin navegador.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-approve-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;

const job = await import("../lib/extract-job.ts");
const { approveCandidates } = await import("../lib/extract-approve.ts");
const { readLibrary } = await import("../lib/library.ts");
const ffmpeg = (await import("ffmpeg-static")).default;

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const SOURCE_URL = "https://www.youtube.com/watch?v=abc123";

/** Una fuente de 6 s con imagen y audio, como la que deja la descarga fusionada. */
function makeSource(file) {
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    file,
  ]);
}

/** Un trabajo de extracción ya analizado: un tramo aprobado y otro pendiente. */
function reviewedJob(id, sourceFile, verdict = "approved") {
  const dir = job.extractionDir(id);
  mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "source.mp4");
  copyFileSync(sourceFile, source);
  writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({
      id,
      state: "done",
      phase: "Tramos propuestos",
      progress: 100,
      download: null,
      source: { url: SOURCE_URL, platform: "youtube" },
      error: null,
      startedAt: null,
      finishedAt: null,
      file: { name: "source.mp4", bytes: 1 },
      limits: { maxMinutes: 60, maxMB: 2048 },
      verdicts: { 1: verdict },
    }),
  );
  writeFileSync(
    job.extractDocPath(id),
    JSON.stringify({
      candidates: [
        { index: 1, start_s: 0.5, end_s: 3.5, duration_s: 3 },
        { index: 2, start_s: 3.7, end_s: 5.5, duration_s: 1.8 },
      ],
      warnings: [],
    }),
  );
  return dir;
}

test("los aprobados entran en la galería y el temporal se borra", async () => {
  const source = path.join(JOBS_DIR, "fuente.mp4");
  makeSource(source);
  const id = "72345678-0000-4000-8000-000000000000";
  const dir = reviewedJob(id, source);

  const result = await approveCandidates(id);

  assert.equal(result.items.length, 1, "solo el tramo aprobado");
  assert.equal(result.reused, 0);
  const item = result.items[0];
  assert.equal(item.name, "escena-01.mp4");
  assert.equal(item.category, null);
  assert.equal(item.source.platform, "youtube");
  assert.equal(item.source.url, SOURCE_URL);
  assert.ok(item.duration_s > 2 && item.duration_s < 4, item.duration_s);
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert.ok(existsSync(path.join(JOBS_DIR, "library", `${item.id}.mp4`)));

  // Revisión cerrada: ni fuente, ni miniaturas, ni trabajo.
  assert.equal(existsSync(dir), false);
  assert.equal(readLibrary().length, 1);
  assert.equal(readLibrary()[0].source.platform, "youtube");
});

test("el mismo tramo no se duplica: se avisa y se reutiliza la entrada", async () => {
  const source = path.join(JOBS_DIR, "fuente.mp4");
  const id = "82345678-0000-4000-8000-000000000000";
  const dir = reviewedJob(id, source);

  const result = await approveCandidates(id);

  assert.equal(result.items.length, 1);
  assert.equal(result.reused, 1, "ya estaba en la galería");
  assert.equal(result.items[0].id, readLibrary()[0].id);
  assert.equal(readLibrary().length, 1, "un solo archivo, no dos");
  assert.equal(existsSync(dir), false);
});

test("sin tramos aprobados no se toca nada", async () => {
  const source = path.join(JOBS_DIR, "fuente.mp4");
  const id = "92345678-0000-4000-8000-000000000000";
  const dir = reviewedJob(id, source, "pending");

  await assert.rejects(() => approveCandidates(id), (error) => error.status === 400);

  assert.equal(existsSync(dir), true, "el temporal sigue para poder aprobar");
  assert.equal(readLibrary().length, 1);
  job.cancelExtraction(id);
});

test("el tramo recortado no lleva metadatos de la fuente", async () => {
  // El nombre del clip sale de la propuesta, no de la ruta ni del nombre original.
  const entry = readLibrary()[0];
  assert.equal(entry.name.startsWith("escena-"), true);
  const raw = readFileSync(path.join(JOBS_DIR, "library.json"), "utf-8");
  assert.equal(raw.includes(JOBS_DIR), false);
});
