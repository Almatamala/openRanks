import { spawn } from "node:child_process";

import {
  buildScoreReport,
  needsScore,
  parseScoreThreshold,
  titleFromName,
  type ScoreFailure,
  type ScoreReport,
} from "./gallery-score";
import { llmEnv, readSettings } from "./api-keys";
import { libraryFilePath, libraryListing, readLibrary, removeLibraryItem, setScore, type LibraryItem } from "./library";
import { PROJECT_ROOT, resolveEngine, type Engine } from "./paths";

/**
 * Puntuación masiva de la galería (F3 · P3-9).
 *
 * El score se pide al motor con **una** pasada del comando `rate` para todos los clips
 * que aún no tienen score: una sola llamada al LLM con la miniatura de cada uno. La
 * clave es obligatoria; sin ella no se lanza nada. Los clips que ya venían puntuados (al
 * aprobarlos) no se vuelven a puntuar y su título generado se respeta.
 *
 * Después se puede borrar de la galería todo lo que no llega al umbral. El borrado es
 * explícito y confirmado desde el panel (ADR-15): este módulo no lo hace solo.
 */

const RATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class ScoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScoreError";
    this.status = status;
  }
}

interface RatedClip {
  score: number;
  title: string;
  source: string | null;
  model: string | null;
  duration_s: number | null;
  error: string | null;
}

function readRatedClip(value: unknown): RatedClip | null {
  if (!value || typeof value !== "object") return null;
  const clip = value as Record<string, unknown>;

  const error = typeof clip.error === "string" && clip.error.trim() ? clip.error.trim() : null;
  const score = clip.score;
  if (
    typeof score !== "number" ||
    !Number.isInteger(score) ||
    score < 0 ||
    score > 100
  ) {
    return {
      score: 0,
      title: "",
      source: null,
      model: null,
      duration_s: null,
      error: error ?? "el motor no devolvió un score válido",
    };
  }

  const duration =
    typeof clip.duration_s === "number" && Number.isFinite(clip.duration_s) && clip.duration_s > 0
      ? clip.duration_s
      : null;

  return {
    score,
    title: typeof clip.title === "string" ? clip.title.trim().slice(0, 24) : "",
    source: typeof clip.source === "string" && clip.source.trim() ? clip.source.trim() : null,
    model: typeof clip.model_version === "string" && clip.model_version.trim()
      ? clip.model_version.trim()
      : null,
    duration_s: duration,
    error,
  };
}

/** Lanza el comando `rate` del motor con todos los archivos en una sola pasada. */
function runRate(engine: Engine, files: string[]): Promise<unknown[]> {
  const python = engine.python;
  if (!python) {
    return Promise.reject(
      new ScoreError(engine.problems[0] ?? "No hay un motor con el que puntuar la galería.", 503),
    );
  }

  const argv = [
    ...python.args,
    "-m",
    "openranks",
    "rate",
    ...files.flatMap((file) => ["--input", file]),
    "--json",
    "--quiet",
  ];
  if (engine.ffmpeg) argv.push("--ffmpeg", engine.ffmpeg);
  if (engine.ffprobe) argv.push("--ffprobe", engine.ffprobe);

  return new Promise((resolve, reject) => {
    const child = spawn(python.command, argv, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...llmEnv() },
      windowsHide: true,
    });

    let stdout = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, value?: unknown[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? []);
    };

    // Un limitador de memoria evita que una salida enorme tumbe el panel.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new ScoreError("El motor devolvió una respuesta demasiado grande.", 500));
      }
    });
    // El stderr se drena aunque no se use: si no, un FFmpeg hablador llenaría el pipe.
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      finish(new ScoreError("No se pudo arrancar el motor para puntuar la galería.", 500));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        // El motor devuelve el motivo en el JSON de error (sin clave, proveedor caído…).
        try {
          const payload = JSON.parse(stdout) as { error?: unknown };
          if (typeof payload.error === "string" && payload.error.trim()) {
            finish(new ScoreError(payload.error.trim(), 400));
            return;
          }
        } catch {
          // Sin JSON legible, queda el mensaje genérico.
        }
        finish(
          new ScoreError(
            "No se pudo puntuar la galería. Revisa que FFmpeg siga disponible e inténtalo de nuevo.",
            500,
          ),
        );
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { clips?: unknown };
        finish(null, Array.isArray(payload.clips) ? payload.clips : []);
      } catch {
        finish(new ScoreError("El motor devolvió una respuesta que no se entiende.", 500));
      }
    });

    timer = setTimeout(() => {
      child.kill();
      finish(new ScoreError("La puntuación tardó demasiado; prueba con menos clips a la vez.", 504));
    }, RATE_TIMEOUT_MS);
  });
}

/**
 * Puntúa los clips sin score y asigna el título de la edición a todos. Devuelve el
 * informe con el umbral aplicado, sin borrar nada.
 */
export async function scoreLibrary(rawThreshold?: unknown): Promise<ScoreReport> {
  const threshold = parseScoreThreshold(rawThreshold ?? process.env.OPENRANKS_SCORE_MIN);
  const items = readLibrary();
  const pending = items.filter(needsScore);
  const alreadyScored = items.length - pending.length;
  const failed: ScoreFailure[] = [];

  if (pending.length > 0) {
    if (!readSettings().configured) {
      throw new ScoreError(
        "Sin clave de IA: guárdala en Ajustes para puntuar la galería.",
        400,
      );
    }
    const engine = await resolveEngine();
    if (!engine.ffmpeg) {
      throw new ScoreError(engine.problems[0] ?? "No hay FFmpeg con el que puntuar la galería.", 503);
    }
    const clips = await runRate(
      engine,
      pending.map((item) => libraryFilePath(item)),
    );
    const byIndex = new Map<number, unknown>();
    for (const clip of clips) {
      if (clip && typeof clip === "object" && typeof (clip as { index?: unknown }).index === "number") {
        byIndex.set((clip as { index: number }).index, clip);
      }
    }

    for (const [position, item] of pending.entries()) {
      const rated = readRatedClip(byIndex.get(position + 1));
      if (!rated || rated.error) {
        failed.push({
          name: item.name,
          error: rated?.error ?? "el motor no devolvió nada para este clip",
        });
        continue;
      }
      const saved = setScore(item.id, {
        score: rated.score,
        score_source: rated.source,
        score_model: rated.model,
        scored_at: new Date().toISOString(),
        duration_s: rated.duration_s,
        label: item.label ?? (rated.title || titleFromName(item.name)),
      });
      if (!saved) {
        failed.push({ name: item.name, error: "no se pudo guardar el score en la galería" });
      }
    }
  }

  const listing = libraryListing();
  return buildScoreReport(
    listing.items,
    threshold,
    failed,
    pending.length - failed.length,
    alreadyScored,
  );
}

export interface DroppedClip {
  id: string;
  name: string;
  score: number;
}

export interface DropResult {
  threshold: number;
  removed: DroppedClip[];
  items: LibraryItem[];
  categories: string[];
}

/**
 * Borra de la galería (índice y original) los clips puntuados por debajo del umbral.
 * Los que no tienen score no se tocan: sin puntuación no hay veredicto. La llamada
 * exige confirmación explícita en la API.
 */
export function dropBelowThreshold(rawThreshold?: unknown): DropResult {
  const threshold = parseScoreThreshold(rawThreshold ?? process.env.OPENRANKS_SCORE_MIN);
  const removed: DroppedClip[] = [];

  for (const item of readLibrary()) {
    if (needsScore(item)) continue;
    if ((item.score as number) >= threshold) continue;
    const gone = removeLibraryItem(item.id);
    if (gone) {
      removed.push({ id: gone.id, name: gone.name, score: gone.score as number });
    }
  }

  const listing = libraryListing();
  return { threshold, removed, items: listing.items, categories: listing.categories };
}
