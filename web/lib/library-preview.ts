import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { libraryFilePath } from "./library";
import { MergeError, resolveMergeItems, runMerge } from "./library-merge";
import { isSafePathSegment, JOBS_DIR, resolveEngine } from "./paths";

/**
 * Vista previa de la fusión: el clip **ya unido**, pero reducido y con preset rápido, para
 * que el diálogo enseñe el resultado mientras se elige el orden en vez de una lista de
 * clips sueltos.
 *
 * No entra en la galería ni en su índice: vive en `merge-preview/` y se tira sola. Cada
 * cambio de orden monta una vista nueva; las viejas caducan para no llenar el disco.
 */

const PREVIEW_DIR = path.join(JOBS_DIR, "merge-preview");
/** Lo que puede seguir abierto una vista previa abandonada. */
const STALE_MS = 30 * 60 * 1000;

/** Ruta de una vista previa existente, o `null` si el id no vale o ya caducó. */
export function previewFilePath(id: string): string | null {
  if (!isSafePathSegment(id)) return null;
  const file = path.join(PREVIEW_DIR, `${id}.mp4`);
  return existsSync(file) ? file : null;
}

/** Fuera las vistas previas viejas: ni carpetas ni archivos huérfanos. */
function cleanPreviews(): void {
  if (!existsSync(PREVIEW_DIR)) return;
  const limit = Date.now() - STALE_MS;
  for (const name of readdirSync(PREVIEW_DIR)) {
    const file = path.join(PREVIEW_DIR, name);
    try {
      if (statSync(file).mtimeMs < limit) rmSync(file, { force: true });
    } catch {
      // Un archivo abierto (el navegador lo reproduce) se queda hasta la próxima.
    }
  }
}

export interface MergePreview {
  /** Identificador de la vista previa; la sirve el `GET` de la misma ruta. */
  id: string;
  /** URL lista para el `<video>` del diálogo. */
  url: string;
}

export async function createMergePreview(rawIds: unknown): Promise<MergePreview> {
  const items = resolveMergeItems(rawIds);

  const engine = await resolveEngine();
  if (!engine.python) {
    throw new MergeError(engine.problems[0] ?? "No hay un motor con el que montar la vista previa.", 503);
  }
  if (!engine.ffmpeg) {
    throw new MergeError(engine.problems[0] ?? "No hay FFmpeg con el que montar la vista previa.", 503);
  }

  mkdirSync(PREVIEW_DIR, { recursive: true });
  cleanPreviews();

  const id = randomUUID();
  const destination = path.join(PREVIEW_DIR, `${id}.mp4`);
  try {
    await runMerge(
      engine,
      items.map((item) => libraryFilePath(item)),
      destination,
      true,
    );
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }

  return { id, url: `/api/library/merge/preview?id=${id}` };
}
