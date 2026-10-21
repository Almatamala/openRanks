import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { JOBS_DIR } from "./paths";
import { estimateRemainingSeconds, type ProgressEvent } from "./progress";

export type JobState = "created" | "uploading" | "running" | "done" | "failed";

/**
 * Estado de un puesto. El clip se prepara **al subirlo** (no al montar), así que el
 * panel puede enseñar un tick por puesto mientras el operador sigue trabajando.
 */
export type ClipState = "uploading" | "preparing" | "ready" | "failed";

export interface ClipStatus {
  state: ClipState;
  error: string | null;
  /** Duración lista para el plan (segundos), cuando el clip ya está preparado. */
  durationS: number | null;
  /** Avance de la preparación de **ese** clip (0-100), si el motor lo publica. */
  percent?: number;
}

/**
 * Estado de la unión: se hace al pulsar «Montar», justo antes del render. Si ya existe
 * de un montaje anterior, «Montar» solo vuelve a componer la edición sobre ella.
 */
export type JoinState = "idle" | "joining" | "ready" | "failed";

export interface JoinStatus {
  state: JoinState;
  error: string | null;
}

export interface JobRequest {
  title: string;
  /** Opcional: si viene vacío, el vídeo va sin subtítulo. */
  subtitle: string;
  labels: Record<string, string>;
  /** Puestos del ranking (de 5 a 10): fija la escalera y el contrato del motor. */
  positions: number;
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
  /** Se incrementa con cada clip nuevo: una unión vieja no puede darse por buena. */
  revision: number;
  clips: Record<string, ClipStatus>;
  join: JoinStatus;
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
    revision: 0,
    clips: {},
    join: { state: "idle", error: null },
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

export function patchClip(id: string, position: number, patch: Partial<ClipStatus>): JobStatus {
  const current = readStatus(id);
  if (!current) throw new Error(`no existe el trabajo ${id}`);
  const previous = current.clips[String(position)] ?? { state: "uploading" as const, error: null, durationS: null };
  return patchStatus(id, {
    clips: { ...current.clips, [String(position)]: { ...previous, ...patch } },
  });
}

export function patchJoin(id: string, patch: Partial<JoinStatus>): JobStatus {
  const current = readStatus(id);
  if (!current) throw new Error(`no existe el trabajo ${id}`);
  return patchStatus(id, { join: { ...current.join, ...patch } });
}

/** Puestos que espera este trabajo (los fija el panel al subir el primer clip). */
export function expectedPositions(status: JobStatus): number {
  return status.request.positions ?? TOTAL_POSITIONS;
}

/** ¿Están todos los puestos con su tick? Es la condición para unir y para montar. */
export function allClipsReady(status: JobStatus): boolean {
  const count = expectedPositions(status);
  for (let position = 1; position <= count; position += 1) {
    if (status.clips[String(position)]?.state !== "ready") return false;
  }
  return true;
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
  // Montando la edición pero todavía sin el primer evento: nada de dar el 100 % por
  // hecho solo porque los clips estén listos.
  if (status.state === "running") return { phase: status.phase || "Añadiendo la edición", progress: 2 };
  const render = renderDir(id);
  if (status.join.state === "joining") return { phase: "Uniendo los clips", progress: 70 };
  if (status.join.state === "ready" && allClipsReady(status)) return { phase: "Listo para montar", progress: 100 };

  const count = expectedPositions(status);
  const values = Object.values(status.clips);
  const ready = values.filter((clip) => clip.state === "ready").length;
  const preparing = values.filter((clip) => clip.state === "preparing").length;
  if (preparing > 0) return { phase: "Preparando los clips", progress: Math.round((ready / Math.max(1, count)) * 60) };
  if (ready > 0) return { phase: `Preparados ${ready} de ${count}`, progress: Math.round((ready / Math.max(1, count)) * 60) };
  if (existsSync(path.join(render, "ranking.mp4"))) return { phase: "Cerrando el render", progress: 96 };
  if (existsSync(path.join(render, "union.mp4"))) return { phase: "Añadiendo la edición", progress: 82 };
  if (status.uploaded.length < count) return { phase: "Subiendo los clips", progress: 2 };
  return { phase: "Preparando la entrada", progress: 4 };
}

/**
 * Lo único que el operador usa es el **ranking final**. La unión, los clips preparados,
 * el spec y el manifiesto son piezas internas: se quedan en disco para trazabilidad,
 * pero ni se listan ni se sirven.
 */
export function listArtifacts(id: string): Artifact[] {
  const ranking = path.join(renderDir(id), "ranking.mp4");
  if (!existsSync(ranking)) return [];
  const stat = statSync(ranking);
  if (!stat.isFile()) return [];
  return [{ path: "ranking.mp4", label: "Ranking final", kind: "video", bytes: stat.size }];
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
