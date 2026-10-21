import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { clampPositions } from "./limits";
import {
  allClipsReady,
  appendLog,
  bindingPath,
  expectedPositions,
  inputDir,
  patchClip,
  patchJoin,
  patchStatus,
  readStatus,
  recordProgress,
  renderDir,
  type JobRequest,
  type JobStatus,
  TOTAL_POSITIONS,
  uploadedPositions,
} from "./jobs";
import { PROJECT_ROOT, resolveEngine } from "./paths";
import { engineEnv } from "./preset";
import { parseProgressLine, type ProgressEvent } from "./progress";

/** Quién está trabajando ahora mismo: un proceso por rendijas, para no duplicar. */
const rendering = new Map<string, ChildProcess>();
const preparing = new Map<string, ChildProcess>();
const joining = new Map<string, ChildProcess>();

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
    .filter((line) => line && !line.startsWith('File "') && !line.startsWith("Traceback"));
  const last = lines[lines.length - 1];
  if (last)
    return last.replace(
      /^(entrada inválida|fallo el ensamblado|fallo el render|fallo la preparación|fallo la unión):\s*/i,
      "",
    );
  if (code === 2) return "Algún dato de entrada no es válido. Revisa el título, el subtítulo y los nombres de los puestos.";
  return "El montaje se paró sin decir por qué. Vuelve a intentarlo.";
}

/**
 * Recoge stdout/stderr de un proceso del motor y traduce las líneas de avance.
 * Los chunks no respetan los saltos de línea, así que se guarda el resto pendiente.
 */
function collectOutput(child: ChildProcess, id: string, onProgress?: (event: ProgressEvent) => void) {
  let stdout = "";
  let stderr = "";
  let pending = "";
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
        onProgress?.(event);
        if (event.label) appendLog(id, `${event.label}\n`);
        continue;
      }
      if (line.trim()) {
        stderr += line + "\n";
        appendLog(id, line + "\n");
      }
    }
  });
  return { stdout: () => stdout, stderr: () => stderr };
}

/** Quita las piezas que ya no valen cuando entra un clip nuevo (unión, edición, spec). */
function dropStaleRender(id: string): void {
  const dir = renderDir(id);
  for (const name of ["union.mp4", "manifest.json", "ranking.mp4", "spec.json"]) {
    rmSync(path.join(dir, name), { force: true });
  }
}

function dropPrepared(id: string, position: number): void {
  const dir = path.join(renderDir(id), "prepared");
  for (const name of [`${String(position).padStart(2, "0")}.mp4`, `${String(position).padStart(2, "0")}.json`]) {
    rmSync(path.join(dir, name), { force: true });
  }
}

export function isRunning(id: string): boolean {
  return rendering.has(id);
}

export function isPreparing(id: string, position?: number): boolean {
  if (position === undefined) {
    for (const key of preparing.keys()) if (key.startsWith(`${id}:`)) return true;
    return false;
  }
  return preparing.has(`${id}:${position}`);
}

export function isJoining(id: string): boolean {
  return joining.has(id);
}

/**
 * Prepara **un** clip: encuadre automático, 1080x1920, 30 fps y audio a −14 LUFS.
 *
 * Es lo que enciende el tick del puesto. Corre en segundo plano, así que el operador
 * puede seguir subiendo clips o escribiendo nombres mientras termina. Cada clip nuevo
 * sube la revisión del trabajo: si había una unión en marcha, deja de valer.
 */
export async function prepareClip(id: string, position: number, positions?: number): Promise<JobStatus> {
  const status = readStatus(id);
  if (!status) throw new JobError("Ese trabajo ya no existe.");
  const relative = clipFile(id, position);
  if (!relative) throw new JobError(`No se encontró el archivo del puesto #${position}.`);

  const count = clampPositions(positions ?? status.request.positions ?? TOTAL_POSITIONS);
  const key = `${id}:${position}`;
  // Reemplazar un clip mientras se preparaba el anterior: el viejo ya no manda.
  preparing.get(key)?.kill();
  preparing.delete(key);
  joining.get(id)?.kill();
  joining.delete(id);

  const engine = await resolveEngine();
  if (!engine.python) throw new JobError(engine.problems[0] ?? "No hay un motor con el que preparar los clips.");
  if (!engine.ffmpeg) throw new JobError(engine.problems[0] ?? "No hay FFmpeg con el que preparar los clips.");
  const { ffmpeg, ffprobe } = engine;

  const revision = (status.revision ?? 0) + 1;
  patchStatus(id, {
    revision,
    state: "uploading",
    phase: "Preparando los clips",
    progress: 0,
    progressDetail: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    result: null,
    request: { ...status.request, positions: count },
    join: { state: "idle", error: null },
  });
  patchClip(id, position, { state: "preparing", error: null, durationS: null, percent: 0 });
  dropStaleRender(id);
  dropPrepared(id, position);

  const argv = [
    ...engine.python.args,
    "-m",
    "openranks",
    "prepare",
    "--input",
    path.join(inputDir(id), path.basename(relative)),
    "--out",
    renderDir(id),
    "--position",
    String(position),
    "--items",
    String(count),
    "--progress",
    "--json",
    "--quiet",
  ];
  if (ffmpeg) argv.push("--ffmpeg", ffmpeg);
  if (ffprobe) argv.push("--ffprobe", ffprobe);

  const child = spawn(engine.python.command, argv, {
    cwd: PROJECT_ROOT,
    env: engineEnv({ OPENRANKS_ITEMS: String(count) }),
    windowsHide: true,
  });
  preparing.set(key, child);
  const output = collectOutput(child, id, (event) => {
    try {
      // El 100 % lo pone el cierre del proceso: mientras siga vivo, aún no hay tick.
      patchClip(id, position, { state: "preparing", percent: Math.min(99, Math.round(event.percent)) });
    } catch {
      // El avance es una comodidad: si no se puede registrar, la preparación sigue.
    }
  });

  // Cada puesto se prepara en paralelo: el guardián es **este** proceso, no la revisión
  // del trabajo (que sube con cualquier otro puesto y no debe invalidar este tick).
  child.on("error", (error) => {
    if (preparing.get(key) !== child) return;
    preparing.delete(key);
    try {
      patchClip(id, position, {
        state: "failed",
        error: `No se pudo arrancar el motor (${error.message}).`,
      });
    } catch {
      // El trabajo pudo desaparecer.
    }
  });

  child.on("close", (code) => {
    // Un archivo nuevo para el mismo puesto ya tomó el relevo: este resultado no manda.
    if (preparing.get(key) !== child) return;
    preparing.delete(key);
    const current = readStatus(id);
    if (!current) return;
    if (code === 0) {
      let durationS: number | null = null;
      try {
        const payload = JSON.parse(output.stdout().trim()) as { duration_s?: unknown };
        durationS = typeof payload.duration_s === "number" ? payload.duration_s : null;
      } catch {
        durationS = null;
      }
      appendLog(id, `puesto #${position} listo\n`);
      patchClip(id, position, { state: "ready", error: null, durationS, percent: 100 });
      const next = readStatus(id);
      if (next && next.join.state === "failed") patchJoin(id, { state: "idle", error: null });
      return;
    }
    const message = friendlyError(output.stderr(), code);
    appendLog(id, `puesto #${position}: ${message}\n`);
    patchClip(id, position, { state: "failed", error: message, durationS: null });
  });

  const next = readStatus(id);
  if (!next) throw new JobError("No se pudo registrar el trabajo.");
  return next;
}

/**
 * Une los clips ya preparados (por copia de streams) y escribe la unión.
 *
 * Se llama desde «Montar» antes del render, nunca sola: así un cambio de orden o un
 * clip reemplazado no deja uniones de más por el camino. Vuelve en cuanto el proceso
 * arranca; `waitForJoin` es quien espera a que termine.
 */
export async function joinJob(id: string, request: JobRequest): Promise<JobStatus> {
  const status = readStatus(id);
  if (!status) throw new JobError("Ese trabajo ya no existe.");
  if (joining.has(id)) return status;
  if (!allClipsReady(status)) throw new JobError("Todavía faltan clips por preparar.");

  const engine = await resolveEngine();
  if (!engine.python) throw new JobError(engine.problems[0] ?? "No hay un motor con el que unir los clips.");
  if (!engine.ffmpeg) throw new JobError(engine.problems[0] ?? "No hay FFmpeg con el que unir los clips.");
  const { ffmpeg, ffprobe } = engine;

  const count = clampPositions(request.positions ?? expectedPositions(status));
  const revision = status.revision ?? 0;
  patchJoin(id, { state: "joining", error: null });

  const argv = [
    ...engine.python.args,
    "-m",
    "openranks",
    "join",
    "--out",
    renderDir(id),
    "--items",
    String(count),
    "--title",
    request.title,
    "--subtitle",
    request.subtitle,
    "--progress",
    "--json",
    "--quiet",
  ];
  for (const [position, label] of Object.entries(request.labels)) {
    if (label) argv.push("--label", `${position}=${label}`);
  }
  if (ffmpeg) argv.push("--ffmpeg", ffmpeg);
  if (ffprobe) argv.push("--ffprobe", ffprobe);

  const child = spawn(engine.python.command, argv, {
    cwd: PROJECT_ROOT,
    env: engineEnv({ OPENRANKS_ITEMS: String(count) }),
    windowsHide: true,
  });
  joining.set(id, child);
  const output = collectOutput(child, id);

  child.on("error", (error) => {
    joining.delete(id);
    try {
      patchJoin(id, { state: "failed", error: `No se pudo unir los clips (${error.message}).` });
    } catch {
      // El trabajo pudo desaparecer.
    }
  });

  child.on("close", (code) => {
    joining.delete(id);
    const current = readStatus(id);
    if (!current || (current.revision ?? 0) !== revision) return; // un clip nuevo invalida esta unión
    if (code === 0) {
      appendLog(id, "unión lista\n");
      patchJoin(id, { state: "ready", error: null });
      return;
    }
    const message = friendlyError(output.stderr(), code);
    appendLog(id, `unión: ${message}\n`);
    patchJoin(id, { state: "failed", error: message });
  });

  const next = readStatus(id);
  if (!next) throw new JobError("No se pudo registrar el trabajo.");
  return next;
}

/** Cierra el trabajo con un mensaje que el operador pueda leer y reintentar. */
function failJob(id: string, message: string): void {
  try {
    patchStatus(id, {
      state: "failed",
      phase: "Se paró",
      progress: 100,
      error: message,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    // El trabajo pudo desaparecer mientras corría.
  }
}

/**
 * Espera a que la unión termine (o falle) sin bloquear el proceso del panel.
 *
 * `joinJob` ya arrancó el proceso y dejó el estado en `joining`; aquí solo se mira el
 * estado hasta que deja de estar en marcha. La revisión es la guarda: si entró un clip
 * nuevo, esa unión ya no vale y se corta la espera.
 */
async function waitForJoin(id: string, revision: number): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = readStatus(id);
    if (!status) return false;
    if ((status.revision ?? 0) !== revision) return false;
    if (status.join.state === "ready") return true;
    if (status.join.state !== "joining") return false;
    // Si el proceso ya no está y el estado sigue en «joining», no hay a quién esperar.
    if (!joining.has(id)) return false;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Arranca el render (solo la edición) sobre la unión que ya está en disco. */
function launchRender(
  id: string,
  expected: number,
  engine: Awaited<ReturnType<typeof resolveEngine>>,
): void {
  const python = engine.python;
  if (!python) {
    failJob(id, "No hay un motor con el que montar.");
    return;
  }
  const { ffmpeg, ffprobe } = engine;
  const argv = [
    ...python.args,
    "-m",
    "openranks",
    "render",
    "--dir",
    renderDir(id),
    "--input",
    bindingPath(id),
    // El número de puestos viaja en `OPENRANKS_ITEMS` (ver `engineEnv`), así que el
    // render valida el binding contra el ranking de este trabajo.
    // El avance medido va por stderr: el panel lo convierte en barra y tiempo restante.
    "--progress",
    "--json",
    "--quiet",
  ];
  if (ffmpeg) argv.push("--ffmpeg", ffmpeg);
  if (ffprobe) argv.push("--ffprobe", ffprobe);

  try {
    patchStatus(id, {
      state: "running",
      phase: "Añadiendo la edición",
      progress: 0,
      progressDetail: null,
    });
  } catch {
    return; // el trabajo desapareció entre la unión y el render
  }

  const child = spawn(python.command, argv, {
    cwd: PROJECT_ROOT,
    env: engineEnv({ OPENRANKS_ITEMS: String(expected) }),
    windowsHide: true,
  });
  rendering.set(id, child);
  const output = collectOutput(child, id, (event) => {
    try {
      recordProgress(id, event);
    } catch {
      // El progreso es una comodidad: si no se puede registrar, el montaje sigue.
    }
  });

  child.on("error", (error) => {
    rendering.delete(id);
    failJob(id, `No se pudo arrancar el motor (${error.message}). Revisa el diagnóstico en /api/engine.`);
  });

  child.on("close", (code) => {
    rendering.delete(id);
    const finishedAt = new Date().toISOString();
    if (code === 0) {
      let result: Record<string, unknown> | null = null;
      try {
        result = JSON.parse(output.stdout().trim()) as Record<string, unknown>;
      } catch {
        result = null;
      }
      appendLog(id, "listo\n");
      patchStatus(id, { state: "done", phase: "Listo", progress: 100, error: null, finishedAt, result });
      return;
    }
    const message = friendlyError(output.stderr(), code);
    appendLog(id, `${message}\n`);
    patchStatus(id, { state: "failed", phase: "Se paró", progress: 100, error: message, finishedAt });
  });
}

/**
 * «Montar»: une los clips preparados (si aún no lo están) y compone la edición encima.
 *
 * La unión ocurre **aquí**, no al terminar los ticks: así no se generan uniones que un
 * cambio de orden o un clip reemplazado dejarían inservibles. Si la unión ya está hecha
 * de un montaje anterior, solo se re-renderiza el overlay.
 */
export async function startJob(id: string, request: JobRequest): Promise<JobStatus> {
  if (rendering.has(id)) throw new JobError("Ese montaje ya está en marcha.");
  if (joining.has(id)) throw new JobError("Los clips se están uniendo; en un momento se puede montar.");

  const status = readStatus(id);
  if (!status) throw new JobError("Ese trabajo ya no existe.");
  const expected = clampPositions(request.positions ?? TOTAL_POSITIONS);
  if (!allClipsReady(status))
    throw new JobError("Todavía se están preparando los clips. Espera a que cada puesto tenga su tick.");

  // El binding solo lleva los textos: `render` lo usa para título, subtítulo y rótulos.
  const items = uploadedPositions(id)
    .filter((position) => position <= expected)
    .map((position) => ({
      position,
      path: clipFile(id, position) ?? "",
      label: request.labels[String(position)] ?? "",
    }));
  writeFileSync(
    bindingPath(id),
    JSON.stringify({ title: request.title, subtitle: request.subtitle, items }, null, 2),
    "utf-8",
  );

  const engine = await resolveEngine();
  if (!engine.python) throw new JobError(engine.problems[0] ?? "No hay un motor con el que montar.");
  if (!engine.ffmpeg) throw new JobError(engine.problems[0] ?? "No hay FFmpeg con el que montar.");

  const revision = status.revision ?? 0;
  const needsJoin = status.join.state !== "ready";
  patchStatus(id, {
    state: "running",
    phase: needsJoin ? "Uniendo los clips" : "Añadiendo la edición",
    progress: 0,
    progressDetail: null,
    error: null,
    startedAt: new Date().toISOString(),
    request,
  });

  // Unir y editar encadenados, en segundo plano: la petición responde enseguida y el
  // panel sigue el avance con su sondeo.
  void (async () => {
    if (needsJoin) {
      try {
        await joinJob(id, request);
      } catch (error) {
        failJob(id, error instanceof Error ? error.message : "No se pudieron unir los clips.");
        return;
      }
      const joined = await waitForJoin(id, revision);
      if (!joined) {
        const after = readStatus(id);
        failJob(
          id,
          (after?.revision ?? 0) !== revision
            ? "Se añadió un clip mientras se unían los demás. Pulsa Montar otra vez."
            : after?.join.error ?? "No se pudieron unir los clips. Vuelve a intentarlo.",
        );
        return;
      }
    }

    const current = readStatus(id);
    if (!current) return;
    if ((current.revision ?? 0) !== revision) {
      failJob(id, "Se añadió un clip mientras se montaba. Pulsa Montar otra vez.");
      return;
    }
    launchRender(id, expected, engine);
  })();

  const next = readStatus(id);
  if (!next) throw new JobError("No se pudo registrar el trabajo.");
  return next;
}
