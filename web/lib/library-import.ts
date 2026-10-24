import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { SELECTION_MAX, SELECTION_MIN } from "./gallery";
import {
  bindingPath,
  createJob,
  inputDir,
  isSafeId,
  jobDir,
  logPath,
  readStatus,
  renderDir,
  writeStatus,
} from "./jobs";
import { libraryFilePath, readLibrary, type LibraryItem } from "./library";
import { isRunning, prepareClip } from "./pipeline";

/** Fallo previsto de la importación, con el código HTTP que le toca. */
export class ImportError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ImportedClip {
  position: number;
  name: string;
  ext: string;
}

export interface ImportResult {
  id: string;
  positions: number;
  clips: ImportedClip[];
}

/**
 * «Generar manual» (RF-12.3): reutiliza el trabajo en curso (o crea uno), reemplaza
 * sus casillas y sus archivos `input/`/`render/` anteriores, copia los originales de la
 * galería y los prepara por puesto.
 *
 * El motor no cambia: el trabajo queda exactamente como si cada clip se hubiera subido
 * a su puesto, así que `prepare` → `join` → `render` siguen siendo los mismos comandos.
 * El orden de la selección manda: el primero es el #1 (el mejor, cierra el vídeo).
 */
export async function importFromLibrary(ids: unknown, currentJobId: unknown): Promise<ImportResult> {
  if (!Array.isArray(ids) || ids.some((value) => typeof value !== "string")) {
    throw new ImportError("La selección no es válida.");
  }
  const selected = ids as string[];
  if (selected.length < SELECTION_MIN || selected.length > SELECTION_MAX) {
    throw new ImportError(
      `Elige entre ${SELECTION_MIN} y ${SELECTION_MAX} clips para generar el ranking.`,
    );
  }
  if (new Set(selected).size !== selected.length) {
    throw new ImportError("Hay un clip repetido en la selección.");
  }

  const byId = new Map(readLibrary().map((item) => [item.id, item]));
  const items: LibraryItem[] = [];
  for (const id of selected) {
    const item = byId.get(id);
    if (!item || !existsSync(libraryFilePath(item))) {
      throw new ImportError("Alguno de los clips elegidos ya no está en la galería.", 404);
    }
    items.push(item);
  }

  const previous =
    typeof currentJobId === "string" && isSafeId(currentJobId) ? readStatus(currentJobId) : null;
  if (previous && isRunning(previous.id)) {
    throw new ImportError("El montaje está en marcha; espera a que termine para generar otro.", 409);
  }
  const job = previous ?? createJob();
  const count = items.length;

  // Se copian primero a un directorio de paso: si un archivo falla, el trabajo actual
  // sigue intacto en vez de quedarse a medias.
  const staging = path.join(jobDir(job.id), ".import");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const [index, item] of items.entries()) {
      copyFileSync(libraryFilePath(item), path.join(staging, `clip-${index + 1}${item.ext}`));
    }
  } catch {
    rmSync(staging, { recursive: true, force: true });
    throw new ImportError("No se pudieron copiar los clips al montaje. Vuelve a intentarlo.", 500);
  }

  // Reemplazar el montaje anterior: ni clips, ni preparados, ni unión, ni edición.
  rmSync(inputDir(job.id), { recursive: true, force: true });
  rmSync(renderDir(job.id), { recursive: true, force: true });
  rmSync(bindingPath(job.id), { force: true });
  rmSync(logPath(job.id), { force: true });
  renameSync(staging, inputDir(job.id));
  mkdirSync(renderDir(job.id), { recursive: true });

  writeStatus(job.id, {
    ...job,
    state: "uploading",
    phase: "Preparando los clips",
    progress: 0,
    progressDetail: null,
    error: null,
    startedAt: null,
    revision: (job.revision ?? 0) + 1,
    request: { positions: count },
    clips: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        String(index + 1),
        { state: "uploading" as const, error: null },
      ]),
    ),
    join: { state: "idle", error: null },
    // Qué clip de la galería ocupa cada puesto: es lo que borra «Borrar videos utilizados».
    gallery: Object.fromEntries(items.map((item, index) => [String(index + 1), item.id])),
  });

  // Cada puesto se prepara en segundo plano, igual que al subir un clip a mano.
  for (let position = 1; position <= count; position += 1) {
    await prepareClip(job.id, position, count);
  }

  return {
    id: job.id,
    positions: count,
    clips: items.map((item, index) => ({
      position: index + 1,
      name: item.name,
      ext: item.ext,
    })),
  };
}
