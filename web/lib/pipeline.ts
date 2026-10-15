import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";

import { clampPositions } from "./limits";
import {
  appendLog,
  bindingPath,
  inputDir,
  patchStatus,
  recordProgress,
  renderDir,
  type JobRequest,
  type JobStatus,
  readStatus,
  TOTAL_POSITIONS,
  uploadedPositions,
} from "./jobs";
import { PROJECT_ROOT, resolveEngine } from "./paths";
import { PRESET_PATH } from "./preset";
import { parseProgressLine } from "./progress";

/** Procesos en marcha, para que un doble clic no arranque dos ensamblados. */
const running = new Map<string, ChildProcess>();

export class JobError extends Error {}

function clipFile(id: string, position: number): string | null {
  const dir = inputDir(id);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find((entry) => new RegExp(`^clip-${position}\\.[a-z0-9]+$`, "i").test(entry));
  return name ? `input/${name}` : null;
}

/** Convierte la salida del motor en un mensaje que el operador pueda leer (RF-9.4). */
function friendlyError(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File \"") && !line.startsWith("Traceback"));
  const last = lines[lines.length - 1];
  if (last) return last.replace(/^(entrada inválida|fallo el ensamblado|fallo el render):\s*/i, "");
  if (code === 2) return "Algún dato de entrada no es válido. Revisa el título y los nombres de los puestos.";
  return "El montaje se paró sin decir por qué. Vuelve a intentarlo.";
}

export function isRunning(id: string): boolean {
  return running.has(id);
}

/**
 * Escribe el binding, arranca `openranks assemble --edit` y devuelve el trabajo
 * ya en marcha. El motor hace **L1 y L2** en una sola pasada: normaliza los clips,
 * los une y compone la edición.
 */
export async function startJob(id: string, request: JobRequest): Promise<JobStatus> {
  if (running.has(id)) throw new JobError("Ese montaje ya está en marcha.");

  const expected = clampPositions(request.positions ?? TOTAL_POSITIONS);
  const positions = uploadedPositions(id);
  if (positions.length !== expected)
    throw new JobError(`Faltan clips: hacen falta los ${expected} puestos del ranking.`);

  // El binding guarda rutas **relativas al propio JSON** (§RF-1), así que el
  // trabajo es portable y el manifiesto nunca filtra rutas del host.
  const items = positions.map((position) => {
    const relative = clipFile(id, position);
    if (!relative) throw new JobError(`No se encontró el archivo del puesto #${position}.`);
    return { position, path: relative, label: request.labels[String(position)] ?? "" };
  });

  writeFileSync(bindingPath(id), JSON.stringify({ title: request.title, items }, null, 2), "utf-8");

  const engine = await resolveEngine();
  if (!engine.python) throw new JobError(engine.problems[0] ?? "No hay un motor con el que montar.");
  if (!engine.ffmpeg) throw new JobError(engine.problems[0] ?? "No hay FFmpeg con el que montar.");
  const { ffmpeg, ffprobe } = engine;
  const argv = [
    ...engine.python.args,
    "-m",
    "openranks",
    "assemble",
    "--input",
    bindingPath(id),
    "--out",
    renderDir(id),
    "--edit",
    "--items",
    String(expected),
    "--transition-seconds",
    String(request.transitionSeconds ?? 0),
    "--transition",
    request.transition || "slideup",
    "--cold-open-seconds",
    String(request.coldOpenSeconds ?? 0),
    "--zoom",
    String(request.zoom ?? 0),
    // El avance medido va por stderr: el panel lo convierte en barra y tiempo restante.
    "--progress",
    "--json",
    "--quiet",
  ];
  if (ffmpeg) argv.push("--ffmpeg", ffmpeg);
  if (ffprobe) argv.push("--ffprobe", ffprobe);

  patchStatus(id, {
    state: "running",
    phase: "Preparando la entrada",
    // Se queda por debajo del 5 % del primer evento del motor (ver `createJob`).
    progress: 4,
    error: null,
    startedAt: new Date().toISOString(),
    request,
  });

  const child = spawn(engine.python.command, argv, {
    cwd: PROJECT_ROOT,
    // El montaje usa el preset guardado (si existe) para no divergir de la vista previa,
    // y el número de puestos de **este** trabajo.
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      OPENRANKS_PRESET_FILE: PRESET_PATH,
      OPENRANKS_ITEMS: String(expected),
    },
    windowsHide: true,
  });
  running.set(id, child);

  let stdout = "";
  let stderr = "";
  let pending = ""; // los chunks no respetan los saltos de línea
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf-8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseProgressLine(line);
      if (event) {
        try {
          recordProgress(id, event);
        } catch {
          // El progreso es una comodidad: si no se puede registrar, el montaje sigue.
        }
        if (event.label) appendLog(id, `${event.label}\n`);
        continue;
      }
      if (line.trim()) {
        stderr += line + "\n";
        appendLog(id, line + "\n");
      }
    }
  });

  child.on("error", (error) => {
    running.delete(id);
    patchStatus(id, {
      state: "failed",
      phase: "Se paró",
      progress: 100,
      error: `No se pudo arrancar el motor (${error.message}). Revisa el diagnóstico en /api/engine.`,
      finishedAt: new Date().toISOString(),
    });
  });

  child.on("close", (code) => {
    running.delete(id);
    const finishedAt = new Date().toISOString();
    if (code === 0) {
      let result: Record<string, unknown> | null = null;
      try {
        result = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        result = null;
      }
      appendLog(id, "listo\n");
      patchStatus(id, { state: "done", phase: "Listo", progress: 100, error: null, finishedAt, result });
      return;
    }
    const message = friendlyError(stderr, code);
    appendLog(id, `${message}\n`);
    patchStatus(id, { state: "failed", phase: "Se paró", progress: 100, error: message, finishedAt });
  });

  const status = readStatus(id);
  if (!status) throw new JobError("No se pudo registrar el trabajo.");
  return status;
}
