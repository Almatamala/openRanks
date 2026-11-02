import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";

import { cutClip, CutError } from "./cut";
import {
  addLibraryItem,
  isSafeLibraryId,
  libraryFilePath,
  newLibraryFile,
  readLibrary,
  removeLibraryItem,
  type LibraryItem,
} from "./library";
import { resolveEngine } from "./paths";
import { phashOf } from "./phash";

/**
 * Divisor **manual** de la galería.
 *
 * El detector automático no siempre separa dos escenas que van pegadas en un mismo
 * archivo, así que el operador puede partir un clip por el segundo que él marque: la
 * parte de antes y la de después se guardan como dos clips con su categoría y su
 * procedencia, y el original se borra. Es a propósito manual: el reparto por tiempo es
 * exacto y previsible, que es lo que hace falta mientras el automático mejore.
 */

/** Cada mitad tiene que durar algo: por debajo de esto no es una escena, es un fotograma. */
const MIN_PART_SECONDS = 0.5;

/** Fallo previsto de la división, con el código HTTP que le toca. */
export class SplitError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SplitError";
    this.status = status;
  }
}

export interface SplitResult {
  /** Los dos clips en que quedó el original, en orden de reproducción. */
  items: LibraryItem[];
  /** Id del clip que se sustituyó. */
  removedId: string;
}

/** SHA-256 del clip recortado, igual que en el aterrizaje de escenas. */
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Duración medida con `ffprobe`; `null` si no hay con qué medirla. */
function probeDuration(file: string, ffprobe: string | null): Promise<number | null> {
  if (!ffprobe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { windowsHide: true },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const value = Number.parseFloat(stdout.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

/** Da de alta una de las dos mitades con la ficha del clip original. */
async function registerPart(
  reserved: { id: string; destination: string },
  name: string,
  origin: LibraryItem,
  seconds: number,
): Promise<LibraryItem> {
  const sha256 = await sha256File(reserved.destination);
  const phash = await phashOf(reserved.destination);
  return addLibraryItem({
    id: reserved.id,
    name,
    ext: origin.ext,
    bytes: statSync(reserved.destination).size,
    category: origin.category,
    source: origin.source ?? null,
    duration_s: Math.round(seconds * 1000) / 1000,
    sha256,
    phash,
  });
}

/**
 * Parte un clip de la galería en dos por `at` segundos. El original solo se borra
 * cuando las dos mitades están escritas y dadas de alta: un fallo a mitad deja el clip
 * como estaba y no toca la galería.
 */
export async function splitLibraryItem(id: string, atRaw: unknown): Promise<SplitResult> {
  if (!isSafeLibraryId(id)) throw new SplitError("Ese clip no es válido.", 400);

  const origin = readLibrary().find((entry) => entry.id === id);
  if (!origin) throw new SplitError("Ese clip ya no está en la galería.", 404);

  const source = libraryFilePath(origin);
  if (!existsSync(source)) {
    throw new SplitError("El archivo de ese clip ya no está en el disco.", 404);
  }

  const engine = await resolveEngine();
  if (!engine.python) {
    throw new SplitError(engine.problems[0] ?? "No hay un motor con el que dividir el clip.", 503);
  }
  if (!engine.ffmpeg) {
    throw new SplitError(engine.problems[0] ?? "No hay FFmpeg con el que dividir el clip.", 503);
  }

  // La duración guardada sirve; si el clip se subió a mano, se mide ahora.
  const known = origin.duration_s;
  const duration =
    typeof known === "number" && known > 0 ? known : await probeDuration(source, engine.ffprobe);
  if (duration === null) {
    throw new SplitError("No se pudo medir la duración del clip.", 500);
  }

  if (atRaw === null || atRaw === undefined || atRaw === "") {
    throw new SplitError("Falta el punto de corte.", 400);
  }
  const requested = Number(atRaw);
  if (!Number.isFinite(requested)) {
    throw new SplitError("El punto de corte no es válido.", 400);
  }
  if (requested < MIN_PART_SECONDS || requested > duration - MIN_PART_SECONDS) {
    throw new SplitError("El corte tiene que dejar al menos medio segundo a cada lado.", 400);
  }
  const point = Math.round(requested * 1000) / 1000;

  const first = newLibraryFile(origin.ext);
  const second = newLibraryFile(origin.ext);
  const created: Array<{ id: string; destination: string }> = [first, second];
  const base = origin.name.replace(/\.[^.]+$/, "").trim() || "escena";

  try {
    await cutClip({ engine, source, destination: first.destination, start: 0, end: point });
    await cutClip({
      engine,
      source,
      destination: second.destination,
      start: point,
      end: duration,
    });

    const items = [
      await registerPart(first, `${base}-1${origin.ext}`, origin, point),
      await registerPart(second, `${base}-2${origin.ext}`, origin, duration - point),
    ];

    removeLibraryItem(origin.id);
    return { items, removedId: origin.id };
  } catch (error) {
    // Vuelta atrás: ni entradas a medias ni archivos sueltos en la galería.
    for (const part of created) {
      if (existsSync(part.destination)) rmSync(part.destination, { force: true });
    }
    for (const part of created) removeLibraryItem(part.id);
    if (error instanceof SplitError) throw error;
    if (error instanceof CutError) throw new SplitError(error.message, error.status);
    throw new SplitError("No se pudo dividir el clip. Vuelve a intentarlo.", 500);
  }
}
