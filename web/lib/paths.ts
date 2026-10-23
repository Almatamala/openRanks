import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Raíz del repositorio. El panel vive en `web/`, así que por defecto es el
 * directorio padre; `OPENRANKS_ROOT` permite apuntar a otra copia.
 */
export const PROJECT_ROOT = process.env.OPENRANKS_ROOT
  ? path.resolve(process.env.OPENRANKS_ROOT)
  : path.resolve(process.cwd(), "..");

/** Directorio de trabajos: nada vive fuera de él. */
export const JOBS_DIR = process.env.OPENRANKS_JOBS_DIR ?? path.join(process.cwd(), ".jobs");

/** Versión mínima que pide el motor (`requires-python` en `pyproject.toml`). */
const MIN_PYTHON: readonly [number, number] = [3, 11];

/**
 * FFmpeg mínimo del motor. El montaje es de corte seco (concat por copia de
 * streams) y el overlay va con `ass`/`libass`, así que el suelo es conservador: se
 * pide una versión moderna para no depender de un `ffmpeg` viejo del PATH.
 */
const MIN_FFMPEG_MAJOR = 5;

/** Un intérprete ya validado, con los argumentos fijos que necesite (`py -3`). */
export interface PythonRuntime {
  command: string;
  args: string[];
  /** De dónde salió, para el diagnóstico. */
  source: string;
  /** `3.12`, tal como lo reporta el propio intérprete. */
  version: string;
}

/** Qué usa el panel para hacer el trabajo: el motor (Python) y FFmpeg. */
export interface Engine {
  python: PythonRuntime | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  /** Dónde se encontró FFmpeg (`OPENRANKS_FFMPEG`, npm, PATH, venv). */
  ffmpegSource: string | null;
  /** Qué falta, en lenguaje de operador. Vacío = el motor puede trabajar. */
  problems: string[];
}

function meetsMinimum(version: string): boolean {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

/**
 * Intérpretes candidatos, del más específico al más genérico. El **venv del repo es
 * el primero, pero solo si existe**: el motor es stdlib puro (`dependencies = []`) y
 * corre desde el propio checkout con `cwd` en la raíz, así que cualquier Python
 * 3.11+ de la máquina sirve. En Windows, `python3` se evita a propósito: suele ser
 * el alias de la Microsoft Store, que no ejecuta nada y abre la tienda.
 */
function pythonCandidates(): Array<{ command: string; args: string[]; source: string }> {
  const explicit = process.env.OPENRANKS_PYTHON;
  if (explicit) return [{ command: explicit, args: [], source: "OPENRANKS_PYTHON" }];

  const venv =
    process.platform === "win32"
      ? path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(PROJECT_ROOT, ".venv", "bin", "python");

  const candidates: Array<{ command: string; args: string[]; source: string }> = [
    { command: venv, args: [], source: "venv del repo" },
  ];
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"], source: "lanzador py" });
    candidates.push({ command: "python", args: [], source: "PATH" });
  } else {
    candidates.push({ command: "python3", args: [], source: "PATH" });
    candidates.push({ command: "python", args: [], source: "PATH" });
  }
  return candidates;
}

/** ¿Está el intérprete y es 3.11+? Se comprueba **ejecutándolo**, no mirando el archivo. */
async function probePython(candidate: {
  command: string;
  args: string[];
  source: string;
}): Promise<PythonRuntime | null> {
  if (path.isAbsolute(candidate.command) && !existsSync(candidate.command)) return null;
  try {
    const { stdout } = await run(
      candidate.command,
      [...candidate.args, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { cwd: PROJECT_ROOT, timeout: 15_000 },
    );
    const version = stdout.trim();
    if (!meetsMinimum(version)) return null;
    return { ...candidate, version };
  } catch {
    return null;
  }
}

/** Busca un ejecutable en el `PATH` (equivalente a `shutil.which`, sin depender de Python). */
function onPath(name: string): string | null {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * FFmpeg que trae npm: `ffmpeg-static` y `ffprobe-static` descargan el binario de la
 * plataforma al instalar, así que el panel no depende del venv ni del `PATH` del host.
 * Los paquetes se declaran `serverExternalPackages`: son binarios, no código a empaquetar.
 */
async function fromNpm(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  let ffmpeg: string | null = null;
  let ffprobe: string | null = null;
  try {
    const module_ = (await import("ffmpeg-static")) as { default?: unknown } | string;
    const found = typeof module_ === "string" ? module_ : module_.default;
    if (typeof found === "string" && existsSync(found)) ffmpeg = found;
  } catch {
    // Sin el paquete instalado se sigue buscando en el resto de sitios.
  }
  try {
    const module_ = (await import("ffprobe-static")) as { default?: { path?: unknown } };
    const found = module_?.default?.path;
    if (typeof found === "string" && existsSync(found)) ffprobe = found;
  } catch {
    // idem
  }
  return { ffmpeg, ffprobe };
}

/**
 * ¿Sirve este ffmpeg del sistema? Se pregunta la versión al binario en vez de fiarse
 * del nombre: un `ffmpeg` viejo en el PATH rompería la unión, y entonces es mejor el
 * que trae npm (6.x, verificado haciendo L1+L2 completo).
 */
async function usableFfmpeg(binary: string | null): Promise<boolean> {
  if (!binary) return false;
  try {
    const { stdout, stderr } = await run(binary, ["-version"], { timeout: 15_000 });
    const found = /ffmpeg version (\d+)/.exec(`${stdout}${stderr}`);
    // Si el binario no dice su versión, se le da el beneficio de la duda.
    return found ? Number(found[1]) >= MIN_FFMPEG_MAJOR : true;
  } catch {
    return false;
  }
}

/**
 * El ffmpeg estático del extra de desarrollo (`static_ffmpeg`): vive en el venv del
 * repo, pero vale cualquier Python que lo tenga instalado (`pip install static-ffmpeg`).
 */
async function fromPython(python: PythonRuntime | null): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  if (!python) return { ffmpeg: null, ffprobe: null };
  const script =
    "import shutil\n" +
    "try:\n" +
    "    import static_ffmpeg\n" +
    "    static_ffmpeg.add_paths()\n" +
    "except Exception:\n" +
    "    pass\n" +
    "print(shutil.which('ffmpeg') or '')\n" +
    "print(shutil.which('ffprobe') or '')\n";
  try {
    const { stdout } = await run(python.command, [...python.args, "-c", script], {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
    });
    const [ffmpeg, ffprobe] = stdout.split(/\r?\n/).map((line) => line.trim());
    return { ffmpeg: ffmpeg || null, ffprobe: ffprobe || null };
  } catch {
    return { ffmpeg: null, ffprobe: null };
  }
}

async function detectEngine(): Promise<Engine> {
  let python: PythonRuntime | null = null;
  for (const candidate of pythonCandidates()) {
    python = await probePython(candidate);
    if (python) break;
  }

  let ffmpeg: string | null = null;
  let ffprobe: string | null = null;
  let ffmpegSource: string | null = null;

  const sources: Array<{ label: string; find: () => Promise<{ ffmpeg: string | null; ffprobe: string | null }> }> = [
    {
      label: "OPENRANKS_FFMPEG",
      find: async () => {
        const fromEnv = process.env.OPENRANKS_FFMPEG ?? "";
        const probeFromEnv = process.env.OPENRANKS_FFPROBE ?? "";
        return {
          ffmpeg: fromEnv && existsSync(fromEnv) ? fromEnv : null,
          ffprobe: probeFromEnv && existsSync(probeFromEnv) ? probeFromEnv : null,
        };
      },
    },
    {
      label: "PATH",
      find: async () => {
        const ffmpeg = onPath("ffmpeg");
        // Un ffmpeg del sistema solo vale si es moderno; si no, se pasa a npm.
        return (await usableFfmpeg(ffmpeg))
          ? { ffmpeg, ffprobe: onPath("ffprobe") }
          : { ffmpeg: null, ffprobe: null };
      },
    },
    { label: "npm (ffmpeg-static)", find: fromNpm },
    { label: "static_ffmpeg del Python", find: () => fromPython(python) },
  ];

  for (const source of sources) {
    const found = await source.find();
    if (!ffmpeg && found.ffmpeg) {
      ffmpeg = found.ffmpeg;
      ffmpegSource = source.label;
    }
    if (!ffprobe && found.ffprobe) ffprobe = found.ffprobe;
    if (ffmpeg && ffprobe) break;
  }

  const problems: string[] = [];
  if (!python) {
    problems.push(
      "No hay un Python 3.11+ a la vista. El motor es Python (sin dependencias): instala Python 3.11+ o crea el venv del repo.",
    );
  }
  if (!ffmpeg || !ffprobe) {
    problems.push(
      "No se encontró FFmpeg. Ejecuta `npm install` dentro de `web/` (trae un FFmpeg estático) o instala FFmpeg en el PATH.",
    );
  }

  return { python, ffmpeg, ffprobe, ffmpegSource, problems };
}

let engineCache: Promise<Engine> | null = null;

/**
 * El motor que va a usar el panel. Se resuelve **una vez** (arrancar el panel es lo
 * que fija el entorno) y se reutiliza en todas las peticiones.
 */
export function resolveEngine(): Promise<Engine> {
  engineCache ??= detectEngine();
  return engineCache;
}
