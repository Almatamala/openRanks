import { spawn } from "node:child_process";

import { PROJECT_ROOT, resolveEngine } from "./paths";

type Engine = Awaited<ReturnType<typeof resolveEngine>>;

/** Fallo previsto del recorte, con el código HTTP que le toca. */
export class CutError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "CutError";
    this.status = status;
  }
}

export interface CutRequest {
  engine: Engine;
  /** Archivo de origen, ya validado por quien llama. */
  source: string;
  /** MP4 exacto que escribe el motor. */
  destination: string;
  start: number;
  end: number;
}

/**
 * Recorta `[start, end]` con el motor (`openranks cut`). Lo comparten el aterrizaje de
 * las escenas aprobadas y el divisor manual de la galería: un solo proceso, un solo
 * criterio de error y un solo sitio que sepa qué argumentos pide el motor.
 */
export function cutClip(request: CutRequest): Promise<void> {
  const python = request.engine.python;
  if (!python) {
    return Promise.reject(new CutError("No hay un motor con el que recortar las escenas.", 503));
  }

  const argv = [
    ...python.args,
    "-m",
    "openranks",
    "cut",
    "--input",
    request.source,
    "--out",
    request.destination,
    "--start",
    request.start.toFixed(3),
    "--end",
    request.end.toFixed(3),
    "--json",
    "--quiet",
  ];
  if (request.engine.ffmpeg) argv.push("--ffmpeg", request.engine.ffmpeg);
  if (request.engine.ffprobe) argv.push("--ffprobe", request.engine.ffprobe);

  return new Promise((resolve, reject) => {
    const child = spawn(python.command, argv, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      reject(new CutError(`No se pudo recortar la escena (${error.message}).`, 500));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("Traceback") && !line.startsWith('File "'))
        .pop();
      reject(
        new CutError(
          detail
            ? `No se pudo recortar la escena. ${detail.replace(/^fallo el recorte:\s*/i, "").slice(0, 160)}`
            : "No se pudo recortar la escena.",
          500,
        ),
      );
    });
  });
}
