import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expectedPositions, inputDir, patchStatus, readStatus, renderDir, type JobStatus } from "./jobs";
import { dropStaleRender, isRunning, prepareClip } from "./pipeline";

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

/** Nombre estable de un preparado: `05.mp4` / `05.json` (`core/plan.py`). */
function preparedName(position: number): string {
  return String(position).padStart(2, "0");
}

function preparedFile(id: string, position: number, ext: "mp4" | "json"): string {
  return path.join(renderDir(id), "prepared", `${preparedName(position)}.${ext}`);
}

/** Los dos archivos de un preparado están ahí: se puede mover sin volver a normalizar. */
function hasPreparedFiles(id: string, position: number): boolean {
  return existsSync(preparedFile(id, position, "mp4")) && existsSync(preparedFile(id, position, "json"));
}

/** Intercambia dos archivos por un tercero: nunca se pisan a medias. */
function swapFiles(first: string, second: string, temporary: string): void {
  renameSync(first, temporary);
  try {
    renameSync(second, first);
    renameSync(temporary, second);
  } catch (error) {
    // Si el intercambio no terminó, se deja el primero donde estaba.
    try {
      renameSync(temporary, first);
    } catch {
      // El archivo intermedio se queda para el reintento: el fallback vuelve a preparar.
    }
    throw error;
  }
}

/**
 * Al mover un preparado, su JSON sigue al vídeo. Hay que actualizar el puesto y el nombre
 * de la fuente para que el manifiesto de la próxima unión siga diciendo la verdad.
 */
function relabelPrepared(id: string, position: number, sourceName: string | null): void {
  const file = preparedFile(id, position, "json");
  if (!existsSync(file)) return;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

  const entry = payload as Record<string, unknown>;
  entry.position = position;
  const source = entry.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const meta = source as Record<string, unknown>;
    meta.position = position;
    if (sourceName) meta.file = sourceName;
  }
  const clip = entry.clip;
  if (clip && typeof clip === "object" && !Array.isArray(clip)) {
    (clip as Record<string, unknown>).file = `${preparedName(position)}.mp4`;
  }
  writeFileSync(file, JSON.stringify(entry, null, 2), "utf-8");
}

/** Mueve el clip **ya preparado** de un puesto a otro: renombrar, no recodificar. */
function swapPrepared(id: string, from: number, to: number): void {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const prefix = path.join(renderDir(id), "prepared", `__swap-${stamp}`);
  swapFiles(preparedFile(id, from, "mp4"), preparedFile(id, to, "mp4"), `${prefix}-mp4`);
  swapFiles(preparedFile(id, from, "json"), preparedFile(id, to, "json"), `${prefix}-json`);

  // El archivo de entrada también viajó: el manifiesto apunta al nombre de su nuevo puesto.
  relabelPrepared(id, from, clipName(id, from));
  relabelPrepared(id, to, clipName(id, to));
}

/**
 * Reordenación por arrastre (RF-13): intercambia dos puestos de la vista de montaje.
 *
 * El clip normalizado **no depende del puesto**, así que el intercambio mueve
 * `prepared/NN.mp4` y su JSON con el clip: no se vuelve a normalizar nada y los dos
 * ticks siguen encendidos. Solo la unión y la edición anteriores dejan de valer (el
 * orden cambió) y se rehacen al pulsar «Montar».
 *
 * Si alguno de los dos puestos todavía no tiene su preparado (o está a mitad de una
 * preparación), se conserva el camino seguro: se vuelven a preparar ambos después de
 * mover los originales.
 */
export async function swapPositions(id: string, from: unknown, to: unknown): Promise<JobStatus> {
  const status = readStatus(id);
  if (!status) throw new ReorderError("Ese trabajo ya no existe.", 404);
  if (isRunning(id)) {
    throw new ReorderError("El montaje está en marcha; espera a que termine para cambiar el orden.", 409);
  }
  if (status.join.state === "joining") {
    throw new ReorderError("Los clips se están uniendo; en un momento se puede cambiar el orden.", 409);
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

  // Los originales se intercambian igual: el puesto conserva la fuente que muestra su
  // casilla y el binding de la próxima unión apunta al archivo correcto.
  const temporary = path.join(dir, `__swap-${Date.now()}`);
  try {
    swapFiles(path.join(dir, fromName), path.join(dir, toName), temporary);
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

  const base: Partial<JobStatus> = {
    revision: (status.revision ?? 0) + 1,
    state: "created",
    phase: "Listo para montar",
    progress: 0,
    progressDetail: null,
    error: null,
    startedAt: null,
    join: { state: "idle", error: null },
    gallery,
  };

  const canMovePrepared =
    status.clips[String(from)]?.state === "ready" &&
    status.clips[String(to)]?.state === "ready" &&
    hasPreparedFiles(id, from) &&
    hasPreparedFiles(id, to);

  if (canMovePrepared) {
    try {
      swapPrepared(id, from, to);
      dropStaleRender(id);
      patchStatus(id, base);
      const next = readStatus(id);
      if (!next) throw new ReorderError("Ese trabajo ya no existe.", 404);
      return next;
    } catch (error) {
      if (error instanceof ReorderError) throw error;
      // Un preparado a medias no puede bloquear el cambio: se rehacen los dos puestos.
    }
  }

  patchStatus(id, { ...base, state: "uploading", phase: "Preparando los clips" });
  await prepareClip(id, from, count);
  await prepareClip(id, to, count);

  const next = readStatus(id);
  if (!next) throw new ReorderError("Ese trabajo ya no existe.", 404);
  return next;
}
