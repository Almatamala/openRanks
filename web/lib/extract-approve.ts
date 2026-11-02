import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { cutClip, CutError } from "./cut";
import { extractionDir, readExtraction } from "./extract-job";
import { sha256File } from "./hash";
import {
  addLibraryItem,
  newLibraryFile,
  normalizeCategory,
  readLibrary,
  removeLibraryItem,
  type LibraryItem,
} from "./library";
import { resolveEngine } from "./paths";
import { phashOf } from "./phash";

/**
 * Aterrizaje de los tramos aprobados en la galería (F3 · P3-4).
 *
 * Se recorta **solo** cada tramo aprobado desde la fuente temporal (con el motor, que
 * deja un MP4 exacto), se calcula su SHA-256 y se da de alta con su procedencia y su
 * duración. Si ese mismo clip ya está en la galería, se reutiliza la entrada y se borra
 * la copia nueva: reintentar una extracción nunca duplica. Al cerrar la revisión, la
 * fuente y las miniaturas desaparecen: solo ocupan espacio los tramos aprobados.
 */

/**
 * Escenas que se recortan a la vez. Cada corte es un proceso del motor más FFmpeg: tres
 * aprovechan la CPU sin ahogar el resto del panel; más solo añaden contención.
 */
const APPROVE_CONCURRENCY = 3;

/** Fallo previsto del aterrizaje, con el código HTTP que le toca. */
export class ApproveError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApproveError";
    this.status = status;
  }
}

export interface ApproveResult {
  items: LibraryItem[];
  /** Cuántos ya estaban en la galería y se reutilizaron en vez de duplicar. */
  reused: number;
}

export async function approveCandidates(id: string): Promise<ApproveResult> {
  const status = readExtraction(id);
  if (!status) throw new ApproveError("Esa extracción ya no existe.", 404);
  if (status.state !== "done" || !status.candidates) {
    throw new ApproveError("El divisor de escenas todavía no ha terminado.", 409);
  }

  const approved = status.candidates.filter((candidate) => candidate.verdict === "approved");
  if (approved.length === 0) {
    throw new ApproveError("Aprueba al menos una escena para llevarla a la galería.");
  }

  const source = status.file ? path.join(extractionDir(id), status.file.name) : null;
  if (!source || !existsSync(source)) {
    throw new ApproveError("El vídeo ya no está en el área temporal.", 404);
  }

  const engine = await resolveEngine();
  if (!engine.python) {
    throw new ApproveError(engine.problems[0] ?? "No hay un motor con el que recortar las escenas.", 503);
  }
  if (!engine.ffmpeg) {
    throw new ApproveError(engine.problems[0] ?? "No hay FFmpeg con el que recortar las escenas.", 503);
  }

  const items: LibraryItem[] = [];
  const createdIds: string[] = [];
  const written: string[] = [];
  let reused = 0;

  // El corte y las huellas son lo caro (motor + FFmpeg por escena): se hacen en paralelo
  // por tandas. El alta en la galería va después y en orden, porque `addLibraryItem` lee
  // y reescribe el índice: dos altas simultáneas se pisarían.
  const prepared: Array<{
    id: string;
    candidate: (typeof approved)[number];
    destination: string;
    sha256: string;
    phash: string | null;
  }> = [];

  try {
    for (let start = 0; start < approved.length; start += APPROVE_CONCURRENCY) {
      const batch = approved.slice(start, start + APPROVE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (candidate) => {
          const { id, destination } = newLibraryFile(".mp4");
          written.push(destination);
          await cutClip({ engine, source, destination, start: candidate.start, end: candidate.end });
          // La huella permite marcar planos repetidos aunque el recorte cambie unos bytes.
          const [sha256, phash] = await Promise.all([
            sha256File(destination),
            phashOf(destination),
          ]);
          return { id, candidate, destination, sha256, phash };
        }),
      );
      // Se espera a toda la tanda antes de limpiar: ningún FFmpeg puede seguir escribiendo
      // el archivo que se borra.
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const result of settled) {
        if (result.status === "fulfilled") prepared.push(result.value);
      }
    }

    for (const { id: clipId, candidate, destination, sha256, phash } of prepared) {
      const existing = readLibrary().find((item) => item.sha256 === sha256);
      if (existing) {
        rmSync(destination, { force: true });
        items.push(existing);
        reused += 1;
        continue;
      }

      const item = addLibraryItem({
        id: clipId,
        name: `escena-${String(candidate.index).padStart(2, "0")}.mp4`,
        ext: ".mp4",
        bytes: statSync(destination).size,
        category: normalizeCategory(null),
        source: status.source,
        duration_s: candidate.duration,
        sha256,
        phash,
      });
      createdIds.push(item.id);
      items.push(item);
    }
  } catch (error) {
    // Ni entradas a medias ni archivos sueltos: se deshace lo de esta petición y el
    // temporal se queda para poder reintentar.
    for (const clipId of createdIds) {
      try {
        removeLibraryItem(clipId);
      } catch {
        // La entrada pudo no llegar a escribirse.
      }
    }
    for (const file of written) {
      if (existsSync(file)) rmSync(file, { force: true });
    }
    if (error instanceof ApproveError) throw error;
    if (error instanceof CutError) throw new ApproveError(error.message, error.status);
    throw new ApproveError("No se pudieron añadir las escenas a la galería. Vuelve a intentarlo.", 500);
  }

  // Revisión cerrada: el original y las miniaturas no se guardan (RF-20.4).
  rmSync(extractionDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  return { items, reused };
}
