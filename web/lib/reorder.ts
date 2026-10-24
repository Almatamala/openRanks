import { existsSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

import { expectedPositions, inputDir, patchStatus, readStatus, type JobStatus } from "./jobs";
import { isRunning, prepareClip } from "./pipeline";

/** Fallo previsto del cambio de orden, con el código HTTP que le toca. */
export class ReorderError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Nombre del archivo de un puesto dentro de `input/` (`clip-3.mp4`). */
function clipName(id: string, position: number): string | null {
  if (!existsSync(inputDir(id))) return null;
  return (
    readdirSync(inputDir(id)).find((entry) =>
      new RegExp(`^clip-${position}\\.[a-z0-9]+$`, "i").test(entry),
    ) ?? null
  );
}

/**
 * Reordenación por arrastre (RF-13): intercambia dos puestos de la vista de montaje.
 *
 * El material cambia de sitio, así que la unión y la edición anteriores dejan de valer y
 * los dos puestos vuelven a prepararse: `prepared/NN.mp4` depende del puesto, no del clip.
 */
export async function swapPositions(id: string, from: unknown, to: unknown): Promise<JobStatus> {
  const status = readStatus(id);
  if (!status) throw new ReorderError("Ese trabajo ya no existe.", 404);
  if (isRunning(id)) {
    throw new ReorderError("El montaje está en marcha; espera a que termine para cambiar el orden.", 409);
  }

  const count = expectedPositions(status);
  const valid =
    typeof from === "number" &&
    typeof to === "number" &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 1 &&
    to >= 1 &&
    from <= count &&
    to <= count;
  if (!valid) throw new ReorderError("Ese puesto no existe.");
  if (from === to) return status;

  const dir = inputDir(id);
  const fromName = clipName(id, from);
  const toName = clipName(id, to);
  if (!fromName || !toName) {
    throw new ReorderError("Alguno de esos puestos no tiene clip que intercambiar.");
  }

  // Los dos archivos se intercambian por un tercero: nunca se pisan a medias.
  const temp = path.join(dir, `__swap-${Date.now()}`);
  try {
    renameSync(path.join(dir, fromName), temp);
    renameSync(path.join(dir, toName), path.join(dir, fromName));
    renameSync(temp, path.join(dir, toName));
  } catch {
    throw new ReorderError("No se pudo cambiar el orden en el servidor. Vuelve a intentarlo.", 500);
  }

  // El clip de la galería viaja con el puesto: «Borrar videos utilizados» sigue acertando.
  const gallery = { ...(status.gallery ?? {}) };
  const fromId = gallery[String(from)];
  const toId = gallery[String(to)];
  if (toId) gallery[String(from)] = toId;
  else delete gallery[String(from)];
  if (fromId) gallery[String(to)] = fromId;
  else delete gallery[String(to)];

  // Los dos puestos se preparan otra vez con su nuevo número.
  const clips = { ...status.clips };
  for (const position of [from, to]) {
    clips[String(position)] = { state: "uploading", error: null, percent: 0 };
  }
  patchStatus(id, {
    state: "uploading",
    phase: "Preparando los clips",
    progress: 0,
    progressDetail: null,
    error: null,
    startedAt: null,
    revision: (status.revision ?? 0) + 1,
    clips,
    join: { state: "idle", error: null },
    gallery,
  });

  await prepareClip(id, from, count);
  await prepareClip(id, to, count);

  const next = readStatus(id);
  if (!next) throw new ReorderError("Ese trabajo ya no existe.", 404);
  return next;
}
