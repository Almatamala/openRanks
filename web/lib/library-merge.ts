import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";

import { MERGE_MAX, MERGE_MIN } from "./gallery";
import { sha256File } from "./hash";
import {
  addLibraryItem,
  isSafeLibraryId,
  libraryFilePath,
  newLibraryFile,
  readLibrary,
  removeLibraryItem,
  type LibraryItem,
} from "./library";
import { PROJECT_ROOT, resolveEngine } from "./paths";
import { phashOf } from "./phash";

/**
 * Fusión **manual** de la galería: de 2 a 4 clips marcados salen como **un** clip, en el
 * orden que dejó el operador en el diálogo (el orden de arriba es el del vídeo).
 *
 * Es la operación inversa al divisor: el resultado se da de alta con la categoría y la
 * procedencia del primer clip y los originales se quitan de la galería. Como en el
 * divisor, nada se borra hasta que el archivo fusionado está escrito y registrado: un
 * fallo a mitad deja la galería como estaba.
 */

/** Fallo previsto de la fusión, con el código HTTP que le toca. */
export class MergeError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MergeError";
    this.status = status;
  }
}

export interface MergeResult {
  /** El clip fusionado que acaba de entrar en la galería. */
  item: LibraryItem;
  /** Ids de los originales que se quitaron. */
  removedIds: string[];
}

/**
 * Ejecuta `openranks merge`: un solo proceso del motor para toda la fusión. Con `preview`
 * el archivo sale reducido y rápido — es lo que enseña el diálogo —, no el clip final.
 */
export function runMerge(
  engine: Awaited<ReturnType<typeof resolveEngine>>,
  inputs: string[],
  destination: string,
  preview = false,
): Promise<void> {
  const python = engine.python;
  if (!python) {
    return Promise.reject(new MergeError("No hay un motor con el que fusionar los clips.", 503));
  }

  const argv = [
    ...python.args,
    "-m",
    "openranks",
    "merge",
    "--out",
    destination,
    ...inputs.flatMap((input) => ["--input", input]),
    "--json",
    "--quiet",
  ];
  if (preview) argv.push("--preview");
  if (engine.ffmpeg) argv.push("--ffmpeg", engine.ffmpeg);
  if (engine.ffprobe) argv.push("--ffprobe", engine.ffprobe);

  return new Promise((resolve, reject) => {
    const child = spawn(python.command, argv, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      reject(new MergeError(`No se pudieron fusionar los clips (${error.message}).`, 500));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("Traceback") && !line.startsWith('File "'))
        .pop();
      reject(
        new MergeError(
          detail
            ? `No se pudieron fusionar los clips. ${detail.replace(/^fallo la fusión:\s*/i, "").slice(0, 160)}`
            : "No se pudieron fusionar los clips.",
          500,
        ),
      );
    });
  });
}

/** Valida los ids que llegan del panel y devuelve los clips en el orden pedido. */
export function resolveMergeItems(raw: unknown): LibraryItem[] {
  if (!Array.isArray(raw)) {
    throw new MergeError(`Elige entre ${MERGE_MIN} y ${MERGE_MAX} clips para fusionarlos.`);
  }
  const ids = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  if (new Set(ids).size !== ids.length) {
    throw new MergeError("Un clip no puede aparecer dos veces en la misma fusión.");
  }
  if (ids.length < MERGE_MIN || ids.length > MERGE_MAX) {
    throw new MergeError(
      `Elige entre ${MERGE_MIN} y ${MERGE_MAX} clips para fusionarlos: llegaron ${ids.length}.`,
    );
  }
  if (!ids.every((id) => isSafeLibraryId(id))) {
    throw new MergeError("Alguno de esos clips no es válido.");
  }

  const library = readLibrary();
  const items = ids.map((id) => library.find((entry) => entry.id === id));
  const missing = items.findIndex((item) => item === undefined);
  if (missing !== -1) {
    throw new MergeError("Alguno de esos clips ya no está en la galería.", 404);
  }
  const found = items as LibraryItem[];
  for (const item of found) {
    if (!existsSync(libraryFilePath(item))) {
      throw new MergeError("El archivo de algún clip ya no está en el disco.", 404);
    }
  }
  return found;
}

/** Nombre del clip fusionado: el del primero, para reconocerlo en la galería. */
function mergedName(items: LibraryItem[]): string {
  const base = items[0].name.replace(/\.[^.]+$/, "").trim() || "clip";
  return `${base}-fusion.mp4`;
}

/** Duración conocida de la suma; `null` si algún clip no la trae (la mide el reproductor). */
function knownDuration(items: LibraryItem[]): number | null {
  let total = 0;
  for (const item of items) {
    if (typeof item.duration_s !== "number" || item.duration_s <= 0) return null;
    total += item.duration_s;
  }
  return Math.round(total * 1000) / 1000;
}

export async function mergeLibraryItems(rawIds: unknown): Promise<MergeResult> {
  const items = resolveMergeItems(rawIds);

  const engine = await resolveEngine();
  if (!engine.python) {
    throw new MergeError(engine.problems[0] ?? "No hay un motor con el que fusionar los clips.", 503);
  }
  if (!engine.ffmpeg) {
    throw new MergeError(engine.problems[0] ?? "No hay FFmpeg con el que fusionar los clips.", 503);
  }

  const { id, destination } = newLibraryFile(".mp4");
  try {
    await runMerge(
      engine,
      items.map((item) => libraryFilePath(item)),
      destination,
    );

    const [sha256, phash] = await Promise.all([sha256File(destination), phashOf(destination)]);
    const first = items[0];
    const merged = addLibraryItem({
      id,
      name: mergedName(items),
      ext: ".mp4",
      bytes: statSync(destination).size,
      // El resultado hereda la etiqueta del primero: es su continuación.
      category: first.category,
      duration_s: knownDuration(items),
      sha256,
      phash,
    });

    const removedIds: string[] = [];
    for (const original of items) {
      if (removeLibraryItem(original.id)) removedIds.push(original.id);
    }
    return { item: merged, removedIds };
  } catch (error) {
    // Ni archivo suelto ni entrada a medias: la galería se queda como estaba.
    rmSync(destination, { force: true });
    if (error instanceof MergeError) throw error;
    throw new MergeError("No se pudieron fusionar los clips. Vuelve a intentarlo.", 500);
  }
}
