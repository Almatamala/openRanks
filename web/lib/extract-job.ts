import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  maxSourceBytes,
  parseDownloadLine,
  sourceLimits,
  ytdlpArgs,
  type DownloadProgress,
  type SourceLimits,
} from "./download";
import {
  parseLink,
  sourceProblems,
  type SourceDeclaration,
  type SourcePlatform,
} from "./extract";
import { extensionOf } from "./gallery";
import { isSafePathSegment, JOBS_DIR, PROJECT_ROOT, resolveEngine } from "./paths";
import { resolveDownloader, type DownloaderStatus } from "./ytdlp";

/**
 * Descarga de la fuente de la extractora (F3 · P3-2).
 *
 * Un trabajo por extracción, en `extract/<id>/`: `source.*` es el **temporal** (lo
 * analizará P3-3) y `job.json` guarda el estado. Nada de esto entra en la galería: solo
 * los tramos aprobados lo harán, más adelante.
 *
 * Se permite **una descarga a la vez** por panel (RF-16.6). El corte se hace en el
 * proceso: si el panel se reinicia a mitad, `readExtraction` la marca como interrumpida y
 * borra el temporal, así que no queda ni un candado ni un archivo a medias.
 */

export type ExtractionState = "downloading" | "analyzing" | "done" | "failed" | "cancelled";

/** Decisión del operador sobre un tramo propuesto por el análisis (P3-3). */
export type CandidateVerdict = "pending" | "approved" | "discarded";

export interface ExtractionCandidate {
  /**
   * Identidad **estable** del tramo: es la clave de su decisión y la que sobrevive a
   * dividirlo o unirlo. El número de la parrilla (`index`) cambia; esto no.
   */
  id: string;
  /** Número que se enseña: sigue el orden de la parrilla (1..n). */
  index: number;
  start: number;
  end: number;
  duration: number;
  /** Miniatura del análisis que ilustra el tramo (la de su origen, si es una mitad). */
  thumb: number;
  /** Ruta **relativa** a la miniatura; la API la sirve por índice. */
  thumbnail: string;
  verdict: CandidateVerdict;
  /** Huella perceptual del fotograma central (planos repetidos). */
  phash: string | null;
  /** Número de la escena anterior con el mismo plano, si lo hay. */
  duplicateOf: number | null;
}

/**
 * Un tramo tal y como lo dejó el operador después de dividir un corte o unir dos. El
 * análisis no se toca: `extract.json` sigue siendo determinista y esto vive en el trabajo.
 */
export interface CandidateSegment {
  /** Identidad estable del tramo; de ella cuelga su decisión. */
  id: string;
  start: number;
  end: number;
  /** Miniatura del análisis que ilustra el tramo. */
  thumb: number;
}

export interface ExtractionStatus {
  id: string;
  state: ExtractionState;
  /** Fase con nombre humano, la misma idea que en el montaje (RF-9.3). */
  phase: string;
  /** Avance de la descarga (0-99): el 100 solo lo pone el archivo ya cerrado. */
  progress: number;
  /** Lo que publica yt-dlp: tamaño, velocidad y tiempo restante. */
  download: DownloadProgress | null;
  /** Fuente con la que se pidió, sin rutas: es lo que viajará al clip aprobado (RF-20.2). */
  source: {
    url: string;
    platform: SourcePlatform | null;
  };
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** El archivo temporal que deja la descarga; lo analiza la tarea siguiente. */
  file: { name: string; bytes: number } | null;
  limits: SourceLimits;
  /**
   * PID del proceso que trabaja en esta extracción. El sondeo puede caer en otra copia
   * del módulo (cada ruta de Next tiene la suya), así que la vida del trabajo no se
   * puede deducir de una variable en memoria: se pregunta al sistema.
   */
  pid?: number | null;
  /** Tramos propuestos por el análisis (P3-3); `null` mientras no se haya analizado. */
  candidates?: ExtractionCandidate[] | null;
  /** Avisos del análisis (sin audio, menos de cinco tramos…). */
  warnings?: string[];
  /**
   * Tramos corregidos por el operador (dividir o unir). Vacío mientras nadie los toque:
   * entonces mandan los del análisis tal cual.
   */
  segments?: CandidateSegment[] | null;
  /** Tramo → decisión del operador. Se guarda en el trabajo, no en `extract.json`. */
  verdicts?: Record<string, CandidateVerdict>;
}

/** Error con su código HTTP, para que la API no invente el estado. */
export class ExtractionError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ExtractionError";
    this.status = status;
  }
}

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Lo que se puede sustituir en las pruebas: el proceso y el binario, nada más. */
export interface ExtractionDeps {
  spawn?: SpawnLike;
  downloader?: () => Promise<DownloaderStatus>;
}

/**
 * Quién está extrayendo ahora mismo (una descarga de yt-dlp o una subida local). La
 * reserva se hace **sin** `await` de por medio.
 */
let active: { id: string; child: ChildProcess | null } | null = null;

function extractionRoot(): string {
  return path.join(JOBS_DIR, "extract");
}

export function extractionDir(id: string): string {
  return path.join(extractionRoot(), id);
}

export function isSafeExtractionId(id: string): boolean {
  return isSafePathSegment(id);
}

function jobFile(id: string): string {
  return path.join(extractionDir(id), "job.json");
}

function logFile(id: string): string {
  return path.join(extractionDir(id), "log.txt");
}

function readJob(id: string): ExtractionStatus | null {
  const file = jobFile(id);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as ExtractionStatus;
  } catch {
    return null;
  }
}

function writeJob(status: ExtractionStatus): ExtractionStatus {
  writeFileSync(jobFile(status.id), JSON.stringify(status, null, 2), "utf-8");
  return status;
}

function patchJob(id: string, patch: Partial<ExtractionStatus>): ExtractionStatus {
  const current = readJob(id);
  if (!current) throw new Error(`no existe la extracción ${id}`);
  return writeJob({ ...current, ...patch });
}

function appendLog(id: string, line: string): void {
  try {
    appendFileSync(logFile(id), line.endsWith("\n") ? line : `${line}\n`, "utf-8");
  } catch {
    // El log es una comodidad: si no se puede escribir, la descarga sigue.
  }
}

/** Archivos de la fuente en el directorio, incluido el `.part` que aún se escribe. */
function tempFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("source."));
}

/** Lo que ocupa la descarga ahora mismo: es lo que se vigila contra el límite. */
function downloadedBytes(dir: string): number {
  let total = 0;
  for (const name of tempFiles(dir)) {
    try {
      total += statSync(path.join(dir, name)).size;
    } catch {
      // El archivo puede estar renombrándose (`.part` → definitivo).
    }
  }
  return total;
}

/**
 * La descarga terminada: **un solo** `source.*` que valga como fuente. Si yt-dlp no pudo
 * fusionar vídeo y audio, deja dos pistas sueltas; ninguna sirve por separado (una es
 * audio sin imagen), así que se devuelve `null` y el panel explica qué pasó.
 */
function finishedFile(dir: string): { name: string; bytes: number } | null {
  const names = tempFiles(dir).filter(
    (entry) => !entry.endsWith(".part") && !entry.endsWith(".ytdl") && !entry.endsWith(".temp"),
  );
  if (names.length !== 1) return null;
  const name = names[0];
  try {
    return { name, bytes: statSync(path.join(dir, name)).size };
  } catch {
    return null;
  }
}

/** Fuera el temporal: ni en el fallo ni en la cancelación queda nada a medias. */
function cleanTemp(dir: string): void {
  for (const name of tempFiles(dir)) rmSync(path.join(dir, name), { force: true });
}

/** Nada de rutas del host en lo que se enseña (§10.3). */
function stripPaths(text: string): string {
  let cleaned = text;
  for (const root of [JOBS_DIR, PROJECT_ROOT]) {
    if (root) cleaned = cleaned.split(root).join("");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

const ERROR_HINTS: Array<[RegExp, string]> = [
  [/private video|sign in|log ?in|members-only/i, "Ese vídeo es privado o pide sesión: no se puede extraer."],
  [/drm/i, "Ese vídeo está protegido con DRM: no se puede extraer."],
  [/unsupported url|no suitable extractor/i, "Ese enlace no es de una plataforma admitida."],
  [/http error 404|not available|unavailable/i, "Ese vídeo ya no está disponible."],
];

/** El error de yt-dlp, traducido a qué pasó (§10.6) y sin rutas. */
export function friendlyDownloadError(stderr: string, limits: SourceLimits): string {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^error[:\s]/i.test(line)) ?? lines[lines.length - 1] ?? "";
  const text = stripPaths(errorLine.replace(/^error[:\s]+/i, ""));

  // Los dos límites se nombran con su valor: el operador tiene que saber cuál se pasó.
  if (/does not pass filter/i.test(text)) {
    return `La fuente pasa de ${limits.maxMinutes} min: no se puede usar como fuente.`;
  }
  if (/max-filesize|larger than|too large/i.test(text)) {
    return `La fuente pasa de ${limits.maxMB} MB: no se puede usar como fuente.`;
  }
  for (const [pattern, message] of ERROR_HINTS) {
    if (pattern.test(text)) return message;
  }
  return text || "La descarga se paró sin decir por qué. Vuelve a intentarlo.";
}

/** Parte stdout/stderr en líneas y guarda el resto sin cerrar. */
function collectLines(
  child: ChildProcess,
  sinks: { stdout?: (line: string) => void; stderr?: (line: string) => void },
): { stderr: () => string } {
  let stderr = "";
  const pending = { stdout: "", stderr: "" };

  const wire = (stream: Readable | null, key: "stdout" | "stderr", sink?: (line: string) => void) => {
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      pending[key] += chunk.toString("utf-8");
      const lines = pending[key].split(/\r?\n/);
      pending[key] = lines.pop() ?? "";
      for (const line of lines) {
        if (key === "stderr" && line.trim()) stderr += `${line}\n`;
        sink?.(line);
      }
    });
  };

  wire(child.stdout, "stdout", sinks.stdout);
  wire(child.stderr, "stderr", sinks.stderr);
  return { stderr: () => stderr };
}

/** El error del análisis, en lenguaje de operador y sin volcar el stack de Python. */
function friendlyAnalysisError(stderr: string): string {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File \"") && !line.startsWith("Traceback"));
  const last = lines[lines.length - 1] ?? "";
  const detail = stripPaths(last.replace(/^fallo el análisis:\s*/i, ""));
  if (/no tiene pista de vídeo/i.test(detail)) {
    return "El archivo no tiene imagen: yt-dlp dejó el audio suelto. Vuelve a descargar el vídeo.";
  }
  const base = "No se pudo dividir el vídeo en escenas.";
  return detail ? `${base} ${detail.slice(0, 200)}` : `${base} Vuelve a intentarlo.`;
}

function failExtraction(id: string, message: string): void {
  const dir = extractionDir(id);
  cleanTemp(dir);
  try {
    patchJob(id, {
      state: "failed",
      phase: "Se paró",
      progress: 100,
      error: message,
      finishedAt: new Date().toISOString(),
      pid: null,
    });
  } catch {
    // La extracción pudo borrarse mientras corría.
  }
}

/**
 * Arranca la descarga de un enlace ya declarado (RF-16.3) y devuelve el acta del trabajo.
 *
 * Los rechazos que se pueden saber antes de bajar un byte —enlace, declaración, `yt-dlp`
 * y «ya hay una en marcha»— salen como `ExtractionError` con su código; a partir de ahí
 * el trabajo vive en disco y el panel lo sigue con `readExtraction`.
 */
export async function startExtraction(
  declaration: SourceDeclaration,
  deps: ExtractionDeps = {},
): Promise<ExtractionStatus> {
  const link = parseLink(declaration.url);
  if (link.problem) throw new ExtractionError(link.problem, 400);

  const problems = sourceProblems(declaration);
  if (problems.length > 0) throw new ExtractionError(problems[0].message, 400);

  const downloader = await (deps.downloader ?? resolveDownloader)();
  if (!downloader.ready || !downloader.binary) {
    throw new ExtractionError(
      downloader.hint ?? "Falta la herramienta de descarga. Instálala y vuelve a abrir el panel.",
      503,
    );
  }

  // El motor se resuelve **antes** del candado: desde la reserva hasta soltarla no puede
  // haber ningún `await`.
  const engine = await resolveEngine();

  // Sin `await` entre la comprobación y la reserva: dos peticiones seguidas no pueden
  // pasar las dos, aunque lleguen en el mismo instante.
  if (active) {
    throw new ExtractionError("Ya hay una descarga en marcha. Espera a que termine o cancélala.", 409);
  }

  const limits = sourceLimits();
  const id = randomUUID();
  const dir = extractionDir(id);
  mkdirSync(dir, { recursive: true });

  writeJob({
    id,
    state: "downloading",
    phase: "Descargando el vídeo",
    progress: 0,
    download: null,
    source: {
      url: link.href ?? declaration.url.trim(),
      platform: link.platform,
    },
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    file: null,
    limits,
  });

  // yt-dlp necesita FFmpeg para unir las pistas en un solo archivo. Se le pasa el mismo
  // binario que usa el motor: sin él deja vídeo y audio por separado y no hay fuente.
  const argv = ytdlpArgs(
    link.href ?? declaration.url.trim(),
    limits,
    path.join(dir, "source.%(ext)s"),
    engine.ffmpeg,
  );
  const spawnImpl = deps.spawn ?? nodeSpawn;

  let child: ChildProcess;
  try {
    child = spawnImpl(downloader.binary, argv, { cwd: dir, windowsHide: true });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new ExtractionError("No se pudo arrancar la descarga. Vuelve a intentarlo.", 500);
  }
  active = { id, child };
  // El PID viaja al trabajo: otra ruta (el sondeo) puede comprobar que sigue vivo sin
  // compartir la variable `active`.
  patchJob(id, { pid: child.pid ?? null });

  const output = collectLines(child, {
    stdout: (line) => {
      const progress = parseDownloadLine(line);
      if (progress) {
        try {
          // El 100 % lo pone el archivo ya cerrado, no la última línea de yt-dlp.
          patchJob(id, {
            progress: Math.min(99, Math.max(0, Math.round(progress.percent))),
            download: progress,
            phase: "Descargando el vídeo",
          });
        } catch {
          // El avance es una comodidad: si no se puede registrar, la descarga sigue.
        }
        return;
      }
      if (line.trim() && !line.startsWith("[download]")) appendLog(id, line);
    },
    stderr: (line) => {
      if (line.trim()) appendLog(id, line);
    },
  });

  // El límite de tamaño también se vigila en disco: hay fuentes que no declaran tamaño y
  // el filtro de yt-dlp no puede frenarlas antes.
  const limitBytes = maxSourceBytes(limits);
  let overLimit: string | null = null;
  const watchdog = setInterval(() => {
    if (overLimit) return;
    if (downloadedBytes(dir) <= limitBytes) return;
    overLimit = `La fuente pasa de ${limits.maxMB} MB: no se puede usar como fuente.`;
    child.kill();
  }, 400);
  watchdog.unref?.();

  child.on("error", (error) => {
    clearInterval(watchdog);
    if (active?.id === id) active = null;
    failExtraction(id, `No se pudo arrancar la descarga (${error.message}).`);
  });

  child.on("close", (code) => {
    clearInterval(watchdog);
    if (active?.id === id) active = null;

    const current = readJob(id);
    // Se canceló y el directorio ya no está: no hay nada que contar.
    if (!current || current.state === "cancelled") return;

    if (overLimit) {
      failExtraction(id, overLimit);
      return;
    }
    if (code === 0) {
      const file = finishedFile(dir);
      if (!file) {
        const loose = tempFiles(dir).filter((name) => !name.endsWith(".part"));
        failExtraction(
          id,
          loose.length > 1
            ? "La descarga dejó el vídeo y el audio por separado y no se pudieron unir. Comprueba que FFmpeg esté disponible y vuelve a intentarlo."
            : "La descarga terminó sin dejar archivo. Vuelve a intentarlo.",
        );
        return;
      }
      patchJob(id, {
        state: "done",
        phase: "Descarga lista",
        progress: 100,
        download: current.download ? { ...current.download, percent: 100 } : null,
        error: null,
        finishedAt: new Date().toISOString(),
        file,
        pid: null,
      });
      appendLog(id, `descarga lista: ${file.name}\n`);
      // El análisis **no** arranca solo: el operador decide con qué sigue. Así puede
      // descargarse el vídeo tal cual aunque el divisor no dé los tramos que espera.
      return;
    }
    failExtraction(id, friendlyDownloadError(output.stderr(), limits));
  });

  const next = readJob(id);
  if (!next) throw new ExtractionError("No se pudo registrar la descarga.", 500);
  return next;
}

/** Lo que llega de «Archivo local»: el vídeo completo, ya firmado, en crudo. */
export interface LocalSourceUpload {
  /** Nombre original, de donde sale la extensión (nunca una pista del cliente). */
  name: string;
  /** Tamaño declarado por el navegador; 0 si no lo manda. */
  bytes: number;
  /** Cuerpo de la petición, en crudo. */
  stream: ReadableStream;
  /** Confirmación de que el material cumple los términos y la privacidad. */
  terms: boolean;
}

/**
 * Sube un **vídeo completo** al área temporal de la extractora (P3-1, entrada local). Es la
 * alternativa a descargar un enlace: el archivo se escribe en `extract/<id>/source.*` por
 * flujo directo, con el mismo tope de tamaño y el mismo «una a la vez» que la descarga. No
 * entra en la galería: solo lo harán los tramos aprobados, más adelante (P3-4).
 */
export async function startLocalExtraction(upload: LocalSourceUpload): Promise<ExtractionStatus> {
  if (upload.terms !== true) {
    throw new ExtractionError(
      "Marca que cumples los términos de la plataforma y la política de privacidad.",
      400,
    );
  }

  const ext = extensionOf(upload.name);
  if (!ext) {
    throw new ExtractionError(
      "Ese formato no es válido. Acepta MP4, MOV, MKV, WEBM, M4V y AVI.",
      400,
    );
  }

  const limits = sourceLimits();
  const limitBytes = maxSourceBytes(limits);
  if (upload.bytes > limitBytes) {
    throw new ExtractionError(
      `El vídeo pasa de ${limits.maxMB} MB: no se puede usar como fuente.`,
      413,
    );
  }

  if (active) {
    throw new ExtractionError("Ya hay una extracción en marcha. Espera a que termine o cancélala.", 409);
  }

  const id = randomUUID();
  const dir = extractionDir(id);
  mkdirSync(dir, { recursive: true });
  const name = `source${ext}`;

  writeJob({
    id,
    state: "downloading",
    phase: "Subiendo el vídeo",
    progress: 0,
    download: null,
    source: { url: "", platform: null },
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    file: null,
    limits,
    // La escritura la hace este mismo proceso: el sondeo no puede confundirla con un
    // trabajo muerto mientras dura la subida.
    pid: process.pid,
  });
  active = { id, child: null };

  // El tope se vigila también mientras se escribe: un cuerpo sin tamaño declarado no
  // puede llenar el disco por la puerta de atrás.
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > limitBytes) {
        done(new Error("too-large"));
        return;
      }
      done(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(upload.stream as never),
      counter,
      createWriteStream(path.join(dir, name)),
    );
  } catch {
    const overLimit = received > limitBytes;
    failExtraction(
      id,
      overLimit
        ? `El vídeo pasa de ${limits.maxMB} MB: no se puede usar como fuente.`
        : "No se pudo guardar el vídeo. Vuelve a intentarlo.",
    );
    if (active?.id === id) active = null;
    throw new ExtractionError(
      overLimit
        ? `El vídeo pasa de ${limits.maxMB} MB: no se puede usar como fuente.`
        : "No se pudo guardar el vídeo. Vuelve a intentarlo.",
      overLimit ? 413 : 500,
    );
  }

  let bytes = received;
  try {
    bytes = statSync(path.join(dir, name)).size;
  } catch {
    // El tamaño contado ya sirve.
  }

  const done = patchJob(id, {
    state: "done",
    phase: "Vídeo listo",
    progress: 100,
    download: null,
    error: null,
    finishedAt: new Date().toISOString(),
    file: { name, bytes },
    pid: null,
  });
  if (active?.id === id) active = null;
  // Igual que con el enlace: subir el vídeo no lo divide. El operador pulsa «Dividir en
  // escenas» cuando quiera, o se descarga el archivo tal cual.
  return done;
}

/** El documento determinista que deja el análisis (P3-3). */
export function extractDocPath(id: string): string {
  return path.join(extractionDir(id), "extract.json");
}

/** Un tramo del análisis, sin la decisión del operador. */
interface AnalysisCandidate {
  index: number;
  start: number;
  end: number;
  phash: string | null;
  duplicateOf: number | null;
}

/** Lo que dejó `openranks analyze` en `extract.json`. */
function readAnalysis(id: string): { raw: AnalysisCandidate[]; warnings: string[] } | null {
  const file = extractDocPath(id);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8")) as {
      candidates?: unknown;
      warnings?: unknown;
    };
    if (!Array.isArray(doc.candidates)) return null;
    const raw: AnalysisCandidate[] = [];
    for (const value of doc.candidates) {
      const entry = (value ?? {}) as Record<string, unknown>;
      const index = Number(entry.index);
      const start = Number(entry.start_s);
      const end = Number(entry.end_s);
      if (
        !Number.isInteger(index) ||
        index < 1 ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      ) {
        continue;
      }
      // La huella es opcional: un análisis antiguo (o un FFmpeg que falló en ese
      // fotograma) deja `null` y el tramo se propone igual, sin la marca de repetido.
      const phashValue =
        typeof entry.phash === "string" && /^[0-9a-f]{16}$/.test(entry.phash)
          ? entry.phash
          : null;
      const repeated = Number(entry.duplicate_of);
      const duplicateOf =
        Number.isInteger(repeated) && repeated >= 1 ? repeated : null;
      raw.push({ index, start, end, phash: phashValue, duplicateOf });
    }
    const warnings = Array.isArray(doc.warnings)
      ? doc.warnings.filter((item): item is string => typeof item === "string")
      : [];
    return { raw, warnings };
  } catch {
    return null;
  }
}

/**
 * Tramos y avisos tal y como los ve el panel: los del análisis o los que dejó el operador
 * al dividir o unir, con la decisión de cada uno. El número de parrilla se renumera para
 * que dividir un tramo no deje un hueco en la cuenta.
 */
function candidatesFor(
  id: string,
  status: ExtractionStatus,
): { candidates: ExtractionCandidate[] | null; warnings: string[] } {
  const analysis = readAnalysis(id);
  if (!analysis) return { candidates: null, warnings: [] };
  const verdicts = status.verdicts ?? {};
  const segments: CandidateSegment[] =
    status.segments && status.segments.length > 0
      ? status.segments
      : analysis.raw.map((entry) => ({
          id: String(entry.index),
          start: entry.start,
          end: entry.end,
          thumb: entry.index,
        }));
  const measured = new Map(analysis.raw.map((entry) => [entry.index, entry]));
  const candidates: ExtractionCandidate[] = segments.map((segment, position) => {
    // La huella solo vale para el tramo tal cual salió del análisis: uno dividido o
    // unido ya no es el plano que se midió, así que no hereda la marca.
    const source = measured.get(Number(segment.id));
    const repeat = source?.duplicateOf ?? null;
    const repeatPosition =
      repeat === null ? 0 : segments.findIndex((entry) => entry.id === String(repeat)) + 1;
    return {
      id: segment.id,
      index: position + 1,
      start: segment.start,
      end: segment.end,
      duration: Math.round((segment.end - segment.start) * 1000) / 1000,
      thumb: segment.thumb,
      thumbnail: `candidates/${String(segment.thumb).padStart(2, "0")}.jpg`,
      verdict: verdicts[segment.id] ?? "pending",
      phash: source?.phash ?? null,
      duplicateOf: repeatPosition > 0 ? repeatPosition : null,
    };
  });
  return { candidates, warnings: analysis.warnings };
}

/** Los tramos como segmentos editables: los corregidos o, si no hay, los del análisis. */
function segmentsOf(
  status: ExtractionStatus,
  candidates: ExtractionCandidate[],
): CandidateSegment[] {
  if (status.segments && status.segments.length > 0) {
    return status.segments.map((segment) => ({ ...segment }));
  }
  return candidates.map((candidate) => ({
    id: candidate.id,
    start: candidate.start,
    end: candidate.end,
    thumb: Number(candidate.id) || 1,
  }));
}

/** El tramo que señala el panel: su id estable o, si aún no se tocó, su número. */
function findCandidate(
  candidates: ExtractionCandidate[],
  ref: unknown,
): ExtractionCandidate | undefined {
  const key = String(ref ?? "").trim();
  return (
    candidates.find((candidate) => candidate.id === key) ??
    candidates.find((candidate) => String(candidate.index) === key)
  );
}

/** El trabajo ya reescrito, o el 404 de siempre si la extracción desapareció. */
function settle(id: string): ExtractionStatus {
  const next = readExtraction(id);
  if (!next) throw new ExtractionError("Esa extracción ya no existe.", 404);
  return next;
}

/** ¿Sigue vivo el proceso que lleva la extracción? */
function processAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cierra un trabajo que quedó «en marcha» sin proceso vivo. Primero mira el disco: puede
 * que el proceso terminara antes de que su ruta escribiera el estado final.
 */
function settleFromDisk(status: ExtractionStatus, dir: string): ExtractionStatus {
  if (status.state === "analyzing") {
    if (existsSync(extractDocPath(status.id))) {
      return {
        ...status,
        state: "done",
        phase: "Escenas propuestas",
        progress: 100,
        error: null,
        pid: null,
      };
    }
    // El vídeo **no se borra**: el fallo del análisis debe poder reintentarse sin
    // volver a descargarlo.
    return {
      ...status,
      state: "failed",
      phase: "Se paró",
      progress: 100,
      error: "No se pudo dividir el vídeo en escenas. Vuelve a intentarlo.",
      pid: null,
    };
  }

  const file = finishedFile(dir);
  if (file) {
    return {
      ...status,
      state: "done",
      phase: "Descarga lista",
      progress: 100,
      file,
      error: null,
      pid: null,
    };
  }
  // Una descarga sí puede dejar piezas (.part): esas no valen para nada.
  cleanTemp(dir);
  return {
    ...status,
    state: "failed",
    phase: "Se paró",
    progress: 100,
    error: "La descarga se interrumpió. Vuelve a intentarlo.",
    pid: null,
    finishedAt: new Date().toISOString(),
  };
}

/**
 * Estado de una descarga o de su extracción. Si quedó «en marcha» sin proceso vivo (el
 * panel se reinició), se cierra mirando el disco. La vida del proceso se comprueba por
 * **PID**, no por memoria: cada ruta del panel puede tener su propia copia del módulo.
 */
export function readExtraction(id: string): ExtractionStatus | null {
  if (!isSafeExtractionId(id)) return null;
  let status = readJob(id);
  if (!status) return null;
  if (
    (status.state === "downloading" || status.state === "analyzing") &&
    !(active && active.id === id) &&
    !processAlive(status.pid)
  ) {
    status = writeJob(settleFromDisk(status, extractionDir(id)));
  }
  const { candidates, warnings } = candidatesFor(id, status);
  return { ...status, candidates, warnings };
}

/**
 * Lanza el análisis de escenas sobre el vídeo que ya está en el área temporal (P3-3).
 * Una sola pasada sin recodificar; el panel sigue el avance con el mismo sondeo y lee
 * los candidatos de `extract.json` al terminar.
 */
export async function startAnalysis(id: string): Promise<ExtractionStatus> {
  const status = readExtraction(id);
  if (!status) throw new ExtractionError("Esa extracción ya no existe.", 404);
  if (active) {
    throw new ExtractionError("Ya hay una extracción en marcha. Espera a que termine o cancélala.", 409);
  }
  if (!status.file) {
    throw new ExtractionError("El vídeo todavía no está listo para analizar.", 400);
  }
  const source = path.join(extractionDir(id), status.file.name);
  if (!existsSync(source)) {
    throw new ExtractionError("El vídeo ya no está en el área temporal.", 404);
  }

  const engine = await resolveEngine();
  if (!engine.python) {
    throw new ExtractionError(
      engine.problems[0] ?? "No hay un motor con el que dividir el vídeo en escenas.",
      503,
    );
  }
  if (!engine.ffmpeg) {
    throw new ExtractionError(
      engine.problems[0] ?? "No hay FFmpeg con el que dividir el vídeo en escenas.",
      503,
    );
  }

  const argv = [
    ...engine.python.args,
    "-m",
    "openranks",
    "analyze",
    "--input",
    source,
    "--out",
    extractionDir(id),
    "--json",
    "--quiet",
  ];
  if (engine.ffmpeg) argv.push("--ffmpeg", engine.ffmpeg);
  if (engine.ffprobe) argv.push("--ffprobe", engine.ffprobe);

  let child: ChildProcess;
  try {
    child = nodeSpawn(engine.python.command, argv, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
  } catch {
    patchJob(id, {
      state: "failed",
      phase: "Se paró",
      progress: 100,
      error: "No se pudo dividir el vídeo en escenas. Vuelve a intentarlo.",
    });
    throw new ExtractionError("No se pudo dividir el vídeo en escenas. Vuelve a intentarlo.", 500);
  }
  // Estado y PID en la **misma** escritura, sin `await` de por medio: el sondeo nunca
  // ve un trabajo recién arrancado sin dueño.
  patchJob(id, {
    state: "analyzing",
    phase: "Dividiendo en escenas",
    progress: 0,
    error: null,
    pid: child.pid ?? null,
  });
  active = { id, child };

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderr += text;
    appendLog(id, text);
  });

  const failAnalysis = (message: string) => {
    try {
      // El vídeo se conserva: un fallo de la extracción no puede tirar la fuente.
      patchJob(id, { state: "failed", phase: "Se paró", progress: 100, error: message, pid: null });
    } catch {
      // La extracción pudo borrarse mientras corría.
    }
  };

  child.on("error", (error) => {
    if (active?.id === id) active = null;
    failAnalysis(`No se pudieron dividir las escenas (${error.message}).`);
  });

  child.on("close", (code) => {
    if (active?.id !== id) return;
    active = null;
    const current = readJob(id);
    if (!current || current.state !== "analyzing") return;
    if (code === 0) {
      patchJob(id, {
        state: "done",
        phase: "Escenas propuestas",
        progress: 100,
        error: null,
        pid: null,
      });
      appendLog(id, "escenas propuestas\n");
      return;
    }
    failAnalysis(friendlyAnalysisError(stderr));
  });

  const next = readExtraction(id);
  if (!next) throw new ExtractionError("No se pudo registrar el análisis.", 500);
  return next;
}

/** Cada mitad de un corte tiene que durar algo: por debajo no es un clip, es un fotograma. */
const MIN_SEGMENT_SECONDS = 0.5;

/** Guarda la decisión del operador sobre un tramo; no toca el vídeo ni `extract.json`. */
export function setCandidateVerdict(
  id: string,
  candidateRef: unknown,
  verdict: unknown,
): ExtractionStatus {
  const current = readExtraction(id);
  if (!current) throw new ExtractionError("Esa extracción ya no existe.", 404);
  const target = findCandidate(current.candidates ?? [], candidateRef);
  if (!target) throw new ExtractionError("Ese tramo no existe en esta extracción.", 404);
  if (verdict !== "approved" && verdict !== "discarded" && verdict !== "pending") {
    throw new ExtractionError("La decisión del tramo no es válida.", 400);
  }
  const verdicts = { ...(current.verdicts ?? {}) };
  if (verdict === "pending") delete verdicts[target.id];
  else verdicts[target.id] = verdict;
  patchJob(id, { verdicts });
  return settle(id);
}

/**
 * «Aprobar todos»: la misma decisión para todos los tramos de una vez, sin una petición
 * por escena. Al aprobar, la decisión sustituye a las anteriores; al dejar pendiente se
 * limpian todas.
 */
export function setAllVerdicts(id: string, verdict: unknown): ExtractionStatus {
  const current = readExtraction(id);
  if (!current) throw new ExtractionError("Esa extracción ya no existe.", 404);
  if (verdict !== "approved" && verdict !== "discarded" && verdict !== "pending") {
    throw new ExtractionError("La decisión del tramo no es válida.", 400);
  }
  const candidates = current.candidates ?? [];
  if (candidates.length === 0) {
    throw new ExtractionError("Todavía no hay tramos que decidir.", 409);
  }
  const verdicts: Record<string, CandidateVerdict> = {};
  if (verdict !== "pending") {
    for (const candidate of candidates) verdicts[candidate.id] = verdict;
  }
  patchJob(id, { verdicts });
  return settle(id);
}

/**
 * Divide un tramo en dos (un corte que dejó dos escenas pegadas). Se corta por el punto
 * que manda el panel —el fotograma donde está el vídeo— o por la mitad. Cada mitad hereda
 * la decisión del tramo original: dividir no puede perder lo que ya se había decidido.
 */
export function splitCandidate(
  id: string,
  candidateRef: unknown,
  at: unknown,
): ExtractionStatus {
  const current = readExtraction(id);
  if (!current) throw new ExtractionError("Esa extracción ya no existe.", 404);
  const candidates = current.candidates ?? [];
  const target = findCandidate(candidates, candidateRef);
  if (!target) throw new ExtractionError("Ese tramo no existe en esta extracción.", 404);

  if (target.end - target.start < MIN_SEGMENT_SECONDS * 2) {
    throw new ExtractionError("Ese tramo ya es demasiado corto para dividirlo.", 400);
  }
  const asked =
    at === undefined || at === null || at === "" ? (target.start + target.end) / 2 : Number(at);
  const point = Number.isFinite(asked) ? Math.round(asked * 1000) / 1000 : Number.NaN;
  if (!Number.isFinite(point)) {
    throw new ExtractionError("El punto de corte no es válido.", 400);
  }
  if (
    point < target.start + MIN_SEGMENT_SECONDS ||
    point > target.end - MIN_SEGMENT_SECONDS
  ) {
    throw new ExtractionError("El corte tiene que dejar al menos medio segundo a cada lado.", 400);
  }

  const segments = segmentsOf(current, candidates);
  const position = candidates.findIndex((candidate) => candidate.id === target.id);
  const original = segments[position];
  const before: CandidateSegment = { ...original, id: `${original.id}a`, end: point };
  const after: CandidateSegment = { ...original, id: `${original.id}b`, start: point };
  const nextSegments = [
    ...segments.slice(0, position),
    before,
    after,
    ...segments.slice(position + 1),
  ];

  const verdicts = { ...(current.verdicts ?? {}) };
  const inherited = verdicts[original.id];
  delete verdicts[original.id];
  if (inherited) {
    verdicts[before.id] = inherited;
    verdicts[after.id] = inherited;
  }
  patchJob(id, { segments: nextSegments, verdicts });
  return settle(id);
}

/**
 * Une un tramo con el siguiente (dos trozos que en realidad eran una escena). El tramo
 * unido se queda con la identidad del primero y con la aprobación, si alguno la tenía.
 */
export function mergeCandidates(id: string, candidateRef: unknown): ExtractionStatus {
  const current = readExtraction(id);
  if (!current) throw new ExtractionError("Esa extracción ya no existe.", 404);
  const candidates = current.candidates ?? [];
  const target = findCandidate(candidates, candidateRef);
  if (!target) throw new ExtractionError("Ese tramo no existe en esta extracción.", 404);

  const position = candidates.findIndex((candidate) => candidate.id === target.id);
  if (position === candidates.length - 1) {
    throw new ExtractionError("Ese es el último tramo: no hay otro con el que unirlo.", 400);
  }

  const segments = segmentsOf(current, candidates);
  const first = segments[position];
  const second = segments[position + 1];
  const merged: CandidateSegment = { ...first, end: second.end };
  const nextSegments = [
    ...segments.slice(0, position),
    merged,
    ...segments.slice(position + 2),
  ];

  const verdicts = { ...(current.verdicts ?? {}) };
  const firstVerdict = verdicts[first.id];
  const secondVerdict = verdicts[second.id];
  delete verdicts[first.id];
  delete verdicts[second.id];
  const inherited =
    firstVerdict === "approved" || secondVerdict === "approved"
      ? "approved"
      : firstVerdict === "discarded" && secondVerdict === "discarded"
        ? "discarded"
        : null;
  if (inherited) verdicts[merged.id] = inherited;
  patchJob(id, { segments: nextSegments, verdicts });
  return settle(id);
}

/**
 * Ruta absoluta de la fuente temporal, solo si existe y sigue dentro del trabajo. La usa
 * la parrilla para reproducir cada tramo acotando `[start, end]` en el propio vídeo.
 */
export function extractionSourceFile(id: string): string | null {
  if (!isSafeExtractionId(id)) return null;
  const status = readJob(id);
  if (!status?.file) return null;
  const root = path.resolve(extractionDir(id));
  const file = path.resolve(root, status.file.name);
  if (!file.startsWith(root) || !existsSync(file)) return null;
  return file;
}

/** Ruta absoluta de la miniatura de un tramo, solo si existe y está dentro del trabajo. */
export function candidateThumbnail(id: string, index: number): string | null {
  if (!isSafeExtractionId(id) || !Number.isInteger(index) || index < 1) return null;
  const root = path.resolve(extractionDir(id));
  const file = path.resolve(root, "candidates", `${String(index).padStart(2, "0")}.jpg`);
  if (!file.startsWith(root) || !existsSync(file)) return null;
  return file;
}

/**
 * La extracción que hay en marcha ahora mismo, si hay alguna. Se mira la variable local
 * y, si esta copia del módulo no la conoce, el disco: el trabajo con un proceso vivo es
 * el que manda (recargar el panel no deja al operador sin forma de verlo ni cancelarlo).
 */
export function currentExtraction(): ExtractionStatus | null {
  if (active) {
    const status = readExtraction(active.id);
    if (status) return status;
  }
  const root = extractionRoot();
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root)) {
    if (!isSafeExtractionId(name)) continue;
    const status = readExtraction(name);
    if (status && (status.state === "downloading" || status.state === "analyzing")) {
      return status;
    }
  }
  return null;
}

/**
 * Cancela (o descarta, si ya terminó) y borra el temporal. Devuelve `false` si esa
 * extracción ya no existe, para que la API responda 404 sin inventar un estado.
 */
export function cancelExtraction(id: string): boolean {
  if (!isSafeExtractionId(id)) return false;
  const dir = extractionDir(id);
  if (!existsSync(dir)) return false;

  if (active?.id === id) {
    const child = active.child;
    active = null;
    try {
      child?.kill();
    } catch {
      // Si ya murió, el cierre del proceso no cambia nada.
    }
  } else {
    // Otra copia del módulo (o el panel reiniciado) arrancó el proceso: se mata por PID.
    // Nunca el propio panel: en una subida local el PID es el de este proceso.
    const pid = readJob(id)?.pid;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid);
      } catch {
        // El proceso ya no está.
      }
    }
  }
  // En Windows el archivo puede estar abierto un instante tras el `kill`: se reintenta.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  return true;
}
