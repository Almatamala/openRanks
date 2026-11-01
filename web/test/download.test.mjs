/**
 * Descarga de la fuente (RF-16.6): límites, argumentos de `yt-dlp` y lectura de su línea
 * de progreso. Sin red, sin disco y sin descargar nada.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SOURCE_LIMITS,
  MAX_SOURCE_MB,
  MAX_SOURCE_MINUTES,
  maxSourceBytes,
  parseDownloadLine,
  parseLimit,
  parseSize,
  sourceLimits,
  ytdlpArgs,
} from "../lib/download.ts";
import { formatBytes } from "../lib/extract.ts";

test("los límites por defecto son 60 min y 2 GB", () => {
  assert.deepEqual(sourceLimits({}), { maxMinutes: 60, maxMB: 2048 });
  assert.equal(DEFAULT_SOURCE_LIMITS.maxMinutes, 60);
  assert.equal(maxSourceBytes({ maxMinutes: 60, maxMB: 2 }), 2 * 1024 * 1024);
});

test("un límite por entorno vale si es un número positivo, con techo", () => {
  assert.deepEqual(
    sourceLimits({ OPENRANKS_SOURCE_MAX_MINUTES: "30", OPENRANKS_SOURCE_MAX_MB: "512" }),
    { maxMinutes: 30, maxMB: 512 },
  );
  // Basura o valores imposibles: se queda el defecto, nunca un límite de 0.
  for (const value of ["", "   ", "abc", "0", "-5", "NaN"]) {
    assert.equal(parseLimit(value, 60, MAX_SOURCE_MINUTES), 60, `«${value}» no es un límite`);
  }
  // Con techo: un entorno no puede dejar el panel sin límites.
  assert.equal(parseLimit("99999", 60, MAX_SOURCE_MINUTES), MAX_SOURCE_MINUTES);
  assert.equal(parseLimit("999999", 2048, MAX_SOURCE_MB), MAX_SOURCE_MB);
  // Decimales redondeados y números con espacios.
  assert.equal(parseLimit(" 12,7 ".replace(",", "."), 60, MAX_SOURCE_MINUTES), 13);
});

test("yt-dlp recibe los límites antes de bajar nada", () => {
  const args = ytdlpArgs("https://youtu.be/abc", { maxMinutes: 60, maxMB: 2048 }, "/tmp/source.%(ext)s");

  assert.equal(args[args.length - 1], "https://youtu.be/abc", "la URL va al final");
  assert.ok(args.includes("--no-playlist"), "una URL por extracción");
  assert.ok(args.includes("--newline") && args.includes("--progress"), "progreso por línea");
  assert.equal(args[args.indexOf("--max-filesize") + 1], "2048M");
  assert.equal(args[args.indexOf("--match-filter") + 1], "duration <= 3600");
  assert.equal(args[args.indexOf("-o") + 1], "/tmp/source.%(ext)s");
  assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
  // Con FFmpeg localizable, yt-dlp puede fusionar vídeo y audio en un solo archivo.
  const merged = ytdlpArgs(
    "https://youtu.be/abc",
    { maxMinutes: 60, maxMB: 2048 },
    "source.%(ext)s",
    "/opt/ffmpeg/bin/ffmpeg",
  );
  assert.equal(merged[merged.indexOf("--ffmpeg-location") + 1], "/opt/ffmpeg/bin/ffmpeg");
  assert.equal(merged[merged.length - 1], "https://youtu.be/abc", "la URL sigue al final");

  // Los límites se aplican con el valor configurado, no con el de fábrica.
  const strict = ytdlpArgs("https://youtu.be/abc", { maxMinutes: 5, maxMB: 10 }, "source.%(ext)s");
  assert.equal(strict[strict.indexOf("--max-filesize") + 1], "10M");
  assert.equal(strict[strict.indexOf("--match-filter") + 1], "duration <= 300");
});

test("lee la línea de progreso de yt-dlp", () => {
  const progress = parseDownloadLine("[download]  12.3% of  123.45MiB at  1.23MiB/s ETA 00:12");

  assert.equal(progress.percent, 12.3);
  assert.equal(progress.totalBytes, Math.round(123.45 * 1024 * 1024));
  assert.equal(progress.bytes, Math.round((12.3 / 100) * Math.round(123.45 * 1024 * 1024)));
  assert.equal(progress.speed, "1,23MiB/s");
  assert.equal(progress.eta, "00:12");

  const done = parseDownloadLine("[download] 100% of 10.00MiB in 00:02");
  assert.equal(done.percent, 100);
  assert.equal(done.eta, null);
  assert.equal(done.speed, null);

  // El tamaño aproximado (`~`) y las unidades decimales también entran.
  const approximate = parseDownloadLine("[download]   0.5% of ~  1.50GiB at  2.00MiB/s ETA 10:00");
  assert.equal(approximate.percent, 0.5);
  assert.equal(approximate.totalBytes, Math.round(1.5 * 1024 ** 3));
});

test("cualquier otra línea de yt-dlp no es un avance", () => {
  for (const line of [
    "[download] Destination: source.mp4",
    "[youtube] Extracting URL: https://youtu.be/abc",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "",
    "  ",
  ]) {
    assert.equal(parseDownloadLine(line), null, `«${line}» no es progreso`);
  }
});

test("parseSize entiende las unidades de yt-dlp", () => {
  assert.equal(parseSize("1", "B"), 1);
  assert.equal(parseSize("1.5", "KiB"), 1536);
  assert.equal(parseSize("2", "MB"), 2_000_000);
  assert.equal(parseSize("1", "GiB"), 1024 ** 3);
  assert.equal(parseSize("1", "wat"), null);
});

test("formatBytes habla en MB y GB, con coma decimal", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatBytes(1536 * 1024), "1,5 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3,0 GB");
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(-1), "");
});
