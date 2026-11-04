/**
 * Fusión de clips de la galería (2–4): el motor pega los archivos en orden, el resultado
 * entra en el índice con la categoría del primero y los originales se quitan del disco.
 * Motor de verdad (Python + FFmpeg estático de npm), sin red ni navegador.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-merge-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;

const { mergeLibraryItems } = await import("../lib/library-merge.ts");
const { createMergePreview, previewFilePath } = await import("../lib/library-preview.ts");
const { readLibrary } = await import("../lib/library.ts");
const ffmpeg = (await import("ffmpeg-static")).default;
const ffprobe = (await import("ffprobe-static")).default.path;

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const LIBRARY_DIR = path.join(JOBS_DIR, "library");

/** Un clip sintético de color plano, con o sin audio. */
function makeClip(file, { color, size = "320x240", audio = true }) {
  const argv = [
    ffmpeg,
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:r=30:d=1`,
  ];
  if (audio) {
    argv.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1");
    argv.push("-map", "0:v:0", "-map", "1:a:0");
  } else {
    argv.push("-an");
  }
  argv.push("-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) argv.push("-c:a", "aac", "-b:a", "64k");
  argv.push(file);
  execFileSync(ffmpeg, argv.slice(1));
  return file;
}

function seedLibrary(entries) {
  mkdirSync(LIBRARY_DIR, { recursive: true });
  writeFileSync(path.join(JOBS_DIR, "library.json"), JSON.stringify({ version: 1, items: entries }));
}

function entry(id, name, category) {
  return {
    id,
    name,
    ext: ".mp4",
    bytes: 1,
    category,
    duration_s: 1,
  };
}

test("dos clips se fusionan en uno y los originales salen de la galería", async () => {
  const red = entry("aaaaaaaa-0000-4000-8000-000000000001", "rojo.mp4", "Gatos");
  const blue = entry("bbbbbbbb-0000-4000-8000-000000000002", "azul.mp4", null);
  seedLibrary([red, blue]);

  copyFileSync(makeClip(path.join(JOBS_DIR, "rojo.mp4"), { color: "red" }), path.join(LIBRARY_DIR, `${red.id}.mp4`));
  copyFileSync(
    makeClip(path.join(JOBS_DIR, "azul.mp4"), { color: "blue", size: "640x360", audio: false }),
    path.join(LIBRARY_DIR, `${blue.id}.mp4`),
  );

  const result = await mergeLibraryItems([red.id, blue.id]);

  assert.deepEqual(result.removedIds, [red.id, blue.id]);
  // El fusionado hereda nombre y etiqueta del primero.
  assert.equal(result.item.name, "rojo-fusion.mp4");
  assert.equal(result.item.category, "Gatos");
  assert.equal(result.item.duration_s, 2);
  assert.match(result.item.sha256, /^[a-f0-9]{64}$/);

  // Queda un solo clip en la galería, con su archivo, y los originales ya no están.
  assert.deepEqual(readLibrary().map((item) => item.id), [result.item.id]);
  assert.equal(existsSync(path.join(LIBRARY_DIR, `${result.item.id}.mp4`)), true);
  assert.equal(existsSync(path.join(LIBRARY_DIR, `${red.id}.mp4`)), false);
  assert.equal(existsSync(path.join(LIBRARY_DIR, `${blue.id}.mp4`)), false);
});

test("con menos de dos o más de cuatro clips no se toca la galería", async () => {
  const [only] = readLibrary();
  const before = readLibrary().length;

  await assert.rejects(() => mergeLibraryItems([only.id]), (error) => error.status === 400);
  await assert.rejects(() => mergeLibraryItems([]), (error) => error.status === 400);
  await assert.rejects(
    () => mergeLibraryItems([only.id, only.id]),
    (error) => error.status === 400,
  );
  assert.equal(readLibrary().length, before);
});

test("la vista previa monta el clip unido, reducido y sin tocar la galería", async () => {
  const first = entry("cccccccc-0000-4000-8000-000000000003", "uno.mp4", null);
  const second = entry("dddddddd-0000-4000-8000-000000000004", "dos.mp4", null);
  seedLibrary([...readLibrary(), first, second]);
  copyFileSync(
    makeClip(path.join(JOBS_DIR, "p1.mp4"), { color: "red" }),
    path.join(LIBRARY_DIR, `${first.id}.mp4`),
  );
  copyFileSync(
    makeClip(path.join(JOBS_DIR, "p2.mp4"), { color: "blue", audio: false }),
    path.join(LIBRARY_DIR, `${second.id}.mp4`),
  );

  const preview = await createMergePreview([first.id, second.id]);

  assert.match(preview.url, /^\/api\/library\/merge\/preview\?id=/);
  const file = previewFilePath(preview.id);
  assert.ok(file && existsSync(file), "la vista previa se escribió en disco");

  // Es el clip **unido** de verdad: dos segundos en un solo archivo, y reducido.
  const probed = JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=width,height",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf-8" },
    ),
  );
  assert.ok(Math.abs(Number(probed.format.duration) - 2) < 0.3, probed.format.duration);
  assert.ok(probed.streams[0].width <= 640, probed.streams[0].width);

  // La galería no se toca: la vista previa es un temporal.
  assert.equal(readLibrary().length, 3);
  assert.equal(existsSync(path.join(LIBRARY_DIR, `${first.id}.mp4`)), true);
  assert.equal(existsSync(path.join(LIBRARY_DIR, `${second.id}.mp4`)), true);
});
