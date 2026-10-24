import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { inputDir, jobDir, patchStatus, readStatus, renderDir } from "./jobs";
import { removeLibraryItem } from "./library";
import { isRunning } from "./pipeline";

/** Fallo previsto del borrado de usados, con el código HTTP que le toca. */
export class UsedDeleteError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface DeleteUsedResult {
  jobId: string;
  /** Nombres originales de los clips que se han borrado de la galería. */
  deleted: string[];
  /** Ids que ya no estaban en la galería: el borrado termina igual, sin error. */
  missing: string[];
}

/**
 * «Borrar videos utilizados» (RF-14): borra de la galería y del disco solo los clips de
 * este ranking, y vacía las casillas de la vista de montaje.
 *
 * El `ranking.mp4`, su `spec.json` y su `manifest.json` no se tocan: la descarga sigue
 * disponible. Los demás trabajos y los clips que no entraron en este ranking tampoco.
 */
export function deleteUsedVideos(id: string): DeleteUsedResult {
  const status = readStatus(id);
  if (!status) throw new UsedDeleteError("Ese trabajo ya no existe.", 404);
  if (isRunning(id)) {
    throw new UsedDeleteError(
      "El montaje está en marcha; espera a que termine para borrar los videos utilizados.",
      409,
    );
  }

  const deleted: string[] = [];
  const missing: string[] = [];
  for (const libraryId of new Set(Object.values(status.gallery ?? {}))) {
    const removed = removeLibraryItem(libraryId);
    if (removed) deleted.push(removed.name);
    else missing.push(libraryId);
  }

  // Las casillas se vacían: fuera los originales del trabajo, los preparados y la unión,
  // que ya no valen para un ranking distinto. La salida publicada se queda.
  const render = renderDir(id);
  rmSync(inputDir(id), { recursive: true, force: true });
  rmSync(path.join(render, "prepared"), { recursive: true, force: true });
  rmSync(path.join(render, "union.mp4"), { force: true });
  rmSync(path.join(jobDir(id), "binding.json"), { force: true });
  mkdirSync(inputDir(id), { recursive: true });
  mkdirSync(render, { recursive: true });

  patchStatus(id, {
    progressDetail: null,
    error: null,
    clips: {},
    join: { state: "idle", error: null },
    gallery: {},
    revision: (status.revision ?? 0) + 1,
  });

  return { jobId: id, deleted, missing };
}
