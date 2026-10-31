import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { isPhash } from "./gallery";
import { PROJECT_ROOT, resolveEngine } from "./paths";

/**
 * Huella perceptual de un clip, con el **mismo** `openranks phash` que usa el divisor de
 * escenas: una sola implementación para el motor y el panel.
 *
 * Una huella es una comodidad (marca planos repetidos), nunca un requisito: si falta
 * Python, FFmpeg o el archivo no se puede leer, devuelve `null` y la subida sigue.
 */
export async function phashOf(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;

  let engine: Awaited<ReturnType<typeof resolveEngine>>;
  try {
    engine = await resolveEngine();
  } catch {
    return null;
  }
  const python = engine.python;
  if (!python) return null;

  const argv = [...python.args, "-m", "openranks", "phash", "--input", file, "--json", "--quiet"];
  if (engine.ffmpeg) argv.push("--ffmpeg", engine.ffmpeg);
  if (engine.ffprobe) argv.push("--ffprobe", engine.ffprobe);

  try {
    const stdout = await capture(python.command, argv);
    const parsed = JSON.parse(stdout) as { phash?: unknown };
    return isPhash(parsed.phash) ? parsed.phash : null;
  } catch {
    return null;
  }
}

/** Ejecuta el comando y devuelve su stdout; rechaza si falla o no termina. */
function capture(command: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    // La huella es de un fotograma: 60 s ya es margen de sobra, incluso en un equipo lento.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("la huella tardó demasiado"));
    }, 60_000);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(new Error(stderr.trim() || "sin huella"));
    });
  });
}
