import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { onPath, PROJECT_ROOT } from "./paths";

const run = promisify(execFile);

/**
 * Año mínimo de `yt-dlp`, que versiona por fecha (`AAAA.MM.DD`). Un binario de 2022 o
 * antes no entiende los enlaces actuales: R11 pide avisar con la orden de actualización
 * en vez de fallar en mitad de una descarga.
 */
const MIN_VERSION_YEAR = 2023;

/** Qué hacer cuando falta. Se enseña tal cual en el panel: sin rutas del host. */
const INSTALL_HINT =
  "Falta yt-dlp, la herramienta que descarga el vídeo del enlace. Instálala con " +
  "`pip install -U yt-dlp` (o `pip install -e \".[extract]\"` en el venv del repo) y vuelve a " +
  "abrir el panel, o define OPENRANKS_YTDLP con la ruta del ejecutable.";

/**
 * Lo que el panel sabe del descargador. **No es una dependencia del montaje**: sin
 * `yt-dlp` se sigue montando y uniendo como siempre; solo la extracción por enlace queda
 * parada, y esta capa lo dice con una salida accionable.
 */
export interface DownloaderStatus {
  /** Se puede descargar: el binario existe, se ejecuta y es de una versión reciente. */
  ready: boolean;
  /** Versión tal como la reporta `yt-dlp --version`; `null` si no se pudo leer. */
  version: string | null;
  /** De dónde salió (`OPENRANKS_YTDLP` o `PATH`), nunca una ruta del host. */
  source: string | null;
  /** Qué hacer, en lenguaje de operador; `null` cuando está listo. */
  hint: string | null;
  /**
   * Ejecutable resuelto. Es **interno**: la API lo quita antes de responder, porque la UI
   * no enseña rutas del host (§10.3). Solo lo usa quien lanza la descarga.
   */
  binary: string | null;
}

interface Candidate {
  command: string;
  source: string;
}

/**
 * `yt-dlp` dentro del venv del repo: lo deja `pip install -e ".[extract]"`. Es el mismo
 * criterio que el intérprete de Python (`.venv` primero si existe), para que el panel
 * funcione sin activar nada ni exportar variables.
 */
function fromVenv(): string {
  return process.platform === "win32"
    ? path.join(PROJECT_ROOT, ".venv", "Scripts", "yt-dlp.exe")
    : path.join(PROJECT_ROOT, ".venv", "bin", "yt-dlp");
}

/** `OPENRANKS_YTDLP` manda; después el venv del repo y, si no, el `PATH`. */
function candidates(): Candidate[] {
  const found: Candidate[] = [];
  const explicit = process.env.OPENRANKS_YTDLP?.trim();
  if (explicit) found.push({ command: explicit, source: "OPENRANKS_YTDLP" });
  const venv = fromVenv();
  if (existsSync(venv)) found.push({ command: venv, source: "venv del repo" });
  const fromPath = onPath("yt-dlp");
  if (fromPath) found.push({ command: fromPath, source: "PATH" });
  return found;
}

/** Año de la versión (`2026.10.27` → 2026), o `null` si no tiene forma de fecha. */
function versionYear(version: string): number | null {
  const found = /(\d{4})\.\d{2}\.\d{2}/.exec(version);
  return found ? Number(found[1]) : null;
}

/** Pregunta la versión **ejecutando** el binario, no mirando el archivo. */
async function probe(candidate: Candidate): Promise<DownloaderStatus | null> {
  if (path.isAbsolute(candidate.command) && !existsSync(candidate.command)) return null;
  try {
    const { stdout } = await run(candidate.command, ["--version"], { timeout: 20_000 });
    const version = stdout.trim().split(/\r?\n/)[0] ?? "";
    const year = versionYear(version);
    if (year !== null && year < MIN_VERSION_YEAR) {
      return {
        ready: false,
        version: version || null,
        source: candidate.source,
        binary: candidate.command,
        hint: `La versión de yt-dlp es antigua (${version}). Actualízala con \`yt-dlp -U\` y vuelve a intentarlo.`,
      };
    }
    // Sin versión legible se le da el beneficio de la duda, como al FFmpeg del PATH.
    return {
      ready: true,
      version: version || null,
      source: candidate.source,
      binary: candidate.command,
      hint: null,
    };
  } catch {
    return null;
  }
}

async function detectDownloader(): Promise<DownloaderStatus> {
  for (const candidate of candidates()) {
    const status = await probe(candidate);
    if (status) return status;
  }
  return { ready: false, version: null, source: null, binary: null, hint: INSTALL_HINT };
}

let cache: Promise<DownloaderStatus> | null = null;

/**
 * Se resuelve **una vez** por proceso, igual que el motor: arrancar el panel es lo que
 * fija el entorno, y por eso la ayuda pide volver a abrirlo tras instalar la herramienta.
 */
export function resolveDownloader(): Promise<DownloaderStatus> {
  cache ??= detectDownloader();
  return cache;
}
