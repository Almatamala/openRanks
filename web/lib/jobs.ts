import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { JOBS_DIR } from "./paths";
import { estimateRemainingSeconds, type ProgressEvent } from "./progress";

export type JobState = "created" | "uploading" | "running" | "done" | "failed";

export interface JobRequest {
  title: string;
  labels: Record<string, string>;
  /** Puestos del ranking (de 5 a 10): fija la escalera y el contrato del motor. */
  positions: number;
  transitionSeconds: number;
  transition: string;
  coldOpenSeconds: number;
  zoom: number;
}

export interface Artifact {
  /** Ruta relativa dentro del render, en POSIX (`clips/05-x.mp4`). */
  path: string;
  label: string;
  kind: "video" | "image" | "json";
  bytes: number;
}

export interface JobStatus {
  id: string;
  state: JobState;
  /** Fase con nombre humano (RF-9.3), nunca un nombre de tabla ni un enum. */
  phase: string;
  progress: number;
  /** Último avance publicado por el motor (porcentaje real), si lo hay. */
  progressDetail: ProgressEvent | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  request: Partial<JobRequest>;
  uploaded: number[];
  result: Record<string, unknown> | null;
}

/** Puestos por defecto si un trabajo no dice cuántos (los antiguos siguen valiendo). */
export const TOTAL_POSITIONS = 5;

export function jobDir(id: string): string {
  return path.join(JOBS_DIR, id);
}

export function inputDir(id: string): string {
  return path.join(jobDir(id), "input");
}

export function renderDir(id: string): string {
  return path.join(jobDir(id), "render");
}

export function bindingPath(id: string): string {
  return path.join(jobDir(id), "binding.json");
}

export function logPath(id: string): string {
  return path.join(jobDir(id), "log.txt");
}

/** Identificador de trabajo: solo `[a-z0-9-]`, así que nunca sale del directorio. */
export function isSafeId(id: string): boolean {
  return /^[a-z0-9-]{6,64}$/.test(id);
}

export function createJob(): JobStatus {
  const id = randomUUID();
  mkdirSync(inputDir(id), { recursive: true });
  mkdirSync(renderDir(id), { recursive: true });
  const status: JobStatus = {
    id,
    state: "created",
    phase: "Preparando la entrada",
    // Por debajo del primer avance que publica el motor (`preparing` = 5 %): la barra
    // nunca puede ir hacia atrás al arrancar el ensamblado.
    progress: 0,
    progressDetail: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    request: {},
    uploaded: [],
    result: null,
  };
  writeStatus(id, status);
  return status;
}

export function readStatus(id: string): JobStatus | null {
  const file = path.join(jobDir(id), "status.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as JobStatus;
  } catch {
    return null;
  }
}

export function writeStatus(id: string, status: JobStatus): JobStatus {
  const file = path.join(jobDir(id), "status.json");
  writeFileSync(file, JSON.stringify(status, null, 2), "utf-8");
  return status;
}

export function patchStatus(id: string, patch: Partial<JobStatus>): JobStatus {
  const current = readStatus(id);
  if (!current) throw new Error(`no existe el trabajo ${id}`);
  return writeStatus(id, { ...current, ...patch });
}

/**
 * Registra un avance del motor. El porcentaje viene medido, no estimado, así que
 * sustituye a la inferencia por archivos mientras haya datos.
 */
export function recordProgress(id: string, event: ProgressEvent): JobStatus {
  const current = readStatus(id);
  if (!current) throw new Error(`no existe el trabajo ${id}`);
  const percent = Math.max(0, Math.min(100, event.percent));
  return patchStatus(id, {
    state: "running",
    phase: event.label || current.phase,
    progress: Math.round(percent),
    progressDetail: { ...event, percent },
  });
}

/** Tiempo restante estimado a partir del porcentaje real y del tiempo transcurrido. */
export function remainingSeconds(status: JobStatus, nowMs: number = Date.now()): number | null {
  if (!status.progressDetail || !status.startedAt) return null;
  return estimateRemainingSeconds(status.progressDetail.percent, Date.parse(status.startedAt), nowMs);
}

export function elapsedSeconds(status: JobStatus, nowMs: number = Date.now()): number | null {
  if (!status.startedAt) return null;
  return Math.round((nowMs - Date.parse(status.startedAt)) / 1000);
}

export function appendLog(id: string, chunk: string): void {
  try {
    appendFileSync(logPath(id), chunk, "utf-8");
  } catch {
    // El log es una comodidad: si no se puede escribir, el trabajo sigue.
  }
}

export function logTail(id: string, lines = 24): string {
  const file = logPath(id);
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf-8");
  return text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join("\n");
}

/**
 * Fase mostrada al operador. Se deduce de lo que ya está en disco en vez de
 * parsear la salida del motor: si el archivo existe, esa fase terminó.
 */
export function inferPhase(id: string, status: JobStatus): { phase: string; progress: number } {
  if (status.state === "done") return { phase: "Listo", progress: 100 };
  if (status.state === "failed") return { phase: "Se paró", progress: 100 };
  // Mientras el motor publique su avance, ese manda: está medido.
  if (status.progressDetail) return { phase: status.progressDetail.label || status.phase, progress: status.progress };
  const render = renderDir(id);
  if (existsSync(path.join(render, "ranking.mp4"))) return { phase: "Cerrando el render", progress: 96 };
  if (existsSync(path.join(render, "union.mp4"))) return { phase: "Añadiendo la edición", progress: 82 };
  const clips = path.join(render, "clips");
  if (existsSync(clips) && readdirSync(clips).some((name) => name.endsWith(".mp4")))
    return { phase: "Normalizando los clips", progress: 20 };
  if (status.uploaded.length < (status.request.positions ?? TOTAL_POSITIONS))
    return { phase: "Subiendo los clips", progress: 2 };
  return { phase: "Preparando la entrada", progress: 4 };
}

const ARTIFACT_LABELS: Record<string, { label: string; kind: Artifact["kind"] }> = {
  "ranking.mp4": { label: "Ranking final (con la edición)", kind: "video" },
  "cover.jpg": { label: "Portada", kind: "image" },
  "union.mp4": { label: "Unión sin editar (L1)", kind: "video" },
  "spec.json": { label: "Especificación del render", kind: "json" },
  "manifest.json": { label: "Ficha técnica", kind: "json" },
};

export function listArtifacts(id: string): Artifact[] {
  const render = renderDir(id);
  if (!existsSync(render)) return [];
  const found: Artifact[] = [];

  const push = (relative: string) => {
    const absolute = path.join(render, relative);
    if (!existsSync(absolute)) return;
    const stat = statSync(absolute);
    if (!stat.isFile()) return;
    const known = ARTIFACT_LABELS[relative] ?? {
      label: relative.startsWith("clips/") ? `Clip ${relative.slice(6)}` : relative,
      kind: relative.endsWith(".mp4") ? ("video" as const) : ("json" as const),
    };
    found.push({ path: relative, label: known.label, kind: known.kind, bytes: stat.size });
  };

  for (const name of ["ranking.mp4", "cover.jpg", "union.mp4", "spec.json", "manifest.json"]) push(name);
  const clips = path.join(render, "clips");
  if (existsSync(clips)) {
    for (const name of readdirSync(clips).filter((entry) => entry.endsWith(".mp4")).sort()) {
      push(`clips/${name}`);
    }
  }
  return found;
}

/** Comprueba que un artefacto pedido por la API es uno de los que la lista ofrece. */
export function resolveArtifact(id: string, requested: string): string | null {
  const match = listArtifacts(id).find((artifact) => artifact.path === requested);
  if (!match) return null;
  const absolute = path.join(renderDir(id), match.path);
  const root = path.resolve(renderDir(id));
  return path.resolve(absolute).startsWith(root) ? absolute : null;
}

export function uploadedPositions(id: string): number[] {
  const dir = inputDir(id);
  if (!existsSync(dir)) return [];
  const positions: number[] = [];
  for (const name of readdirSync(dir)) {
    // Uno o dos dígitos: el formato va del TOP 5 al TOP 10.
    const match = /^clip-(\d{1,2})\.[a-z0-9]+$/i.exec(name);
    if (match) positions.push(Number(match[1]));
  }
  return positions.sort((left, right) => right - left);
}
