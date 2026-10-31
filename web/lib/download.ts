/**
 * Descarga de la fuente (F3 · P3-2): lo **puro** —límites, argumentos de `yt-dlp` y
 * lectura de su línea de progreso—.
 *
 * `yt-dlp` es una herramienta externa (RPD §7.8): aquí solo se decide **con qué** se le
 * llama y **cómo** se lee lo que publica. El proceso, el estado y la cancelación viven en
 * `extract-job.ts`, así que esta parte se prueba sin red, sin disco y sin descargar nada.
 */

/** Límites de la fuente (RF-16.6): 60 min y 2 GB por defecto. */
export const DEFAULT_SOURCE_LIMITS = { maxMinutes: 60, maxMB: 2048 } as const;

/** Techos de cordura: un valor absurdo por entorno no puede dejar el panel sin límites. */
export const MAX_SOURCE_MINUTES = 600;
export const MAX_SOURCE_MB = 20480;

export interface SourceLimits {
  maxMinutes: number;
  maxMB: number;
}

/** Un límite por entorno: número positivo, redondeado y con techo; si no vale, el defecto. */
export function parseLimit(raw: string | undefined, fallback: number, ceiling: number): number {
  const value = Number.parseFloat(String(raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(ceiling, Math.round(value));
}

export function sourceLimits(env: Record<string, string | undefined> = process.env): SourceLimits {
  return {
    maxMinutes: parseLimit(
      env.OPENRANKS_SOURCE_MAX_MINUTES,
      DEFAULT_SOURCE_LIMITS.maxMinutes,
      MAX_SOURCE_MINUTES,
    ),
    maxMB: parseLimit(env.OPENRANKS_SOURCE_MAX_MB, DEFAULT_SOURCE_LIMITS.maxMB, MAX_SOURCE_MB),
  };
}

/** Tamaño máximo de la fuente en bytes (lo que se vigila mientras se descarga). */
export function maxSourceBytes(limits: SourceLimits): number {
  return limits.maxMB * 1024 * 1024;
}

/**
 * Argumentos de la descarga. Todo lo que puede rechazar la fuente **antes** de bajar los
 * bytes va aquí: sin lista de reproducción, con el techo de duración como filtro de
 * metadatos y el de tamaño como límite, y con un nombre fijo (`source.*`) para que el
 * trabajo sepa qué archivo acaba de dejar.
 *
 * `ffmpegLocation` es lo que permite que yt-dlp **fusione** vídeo y audio en un solo
 * `source.mp4`. Sin esa pista, yt-dlp no encuentra FFmpeg (el PATH del panel puede no
 * tenerlo) y deja dos pistas sueltas —vídeo y audio— que el análisis no puede usar.
 */
export function ytdlpArgs(
  url: string,
  limits: SourceLimits,
  outputTemplate: string,
  ffmpegLocation?: string | null,
): string[] {
  const args = [
    "--no-playlist",
    "--newline",
    "--progress",
    "--no-warnings",
    "--socket-timeout",
    "20",
    // yt-dlp comprueba el tamaño conocido antes de descargar; el proceso además vigila
    // lo que ocupa en disco (hay fuentes sin tamaño declarado).
    "--max-filesize",
    `${limits.maxMB}M`,
    // Los directos y los vídeos sin duración no pasan el filtro: no son fuente de un short.
    "--match-filter",
    `duration <= ${limits.maxMinutes * 60}`,
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
  ];
  if (ffmpegLocation) args.push("--ffmpeg-location", ffmpegLocation);
  args.push("-o", outputTemplate, url);
  return args;
}

export interface DownloadProgress {
  /** 0-100 tal como lo publica yt-dlp. */
  percent: number;
  /** Bytes descargados, calculados sobre el total; `null` si aún no hay total. */
  bytes: number | null;
  totalBytes: number | null;
  /** Velocidad ya formateada por yt-dlp (`1.23MiB/s`), que es lo que se enseña. */
  speed: string | null;
  /** Tiempo restante tal como lo da yt-dlp (`00:12` o `01:02:03`). */
  eta: string | null;
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  KIB: 1024,
  MB: 1000 * 1000,
  MIB: 1024 * 1024,
  GB: 1000 ** 3,
  GIB: 1024 ** 3,
  TB: 1000 ** 4,
  TIB: 1024 ** 4,
};

/** `123.4MiB` → bytes. */
export function parseSize(value: string, unit: string): number | null {
  const amount = Number.parseFloat(value);
  const factor = UNITS[unit.toUpperCase()];
  if (!Number.isFinite(amount) || factor === undefined) return null;
  return Math.round(amount * factor);
}

/**
 * Línea de progreso de yt-dlp (`--newline`):
 *
 *   [download]  12.3% of  123.45MiB at  1.23MiB/s ETA 00:12
 *
 * Devuelve `null` para cualquier otra línea (`Destination:`, avisos, la línea final).
 */
const PROGRESS_LINE =
  /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*(\d+(?:\.\d+)?)\s*(B|[KMGT]i?B)(?:\s+at\s+(\d+(?:\.\d+)?)\s*(B|[KMGT]i?B)\/s)?(?:\s+ETA\s+(\d+(?::\d+)+))?/i;

export function parseDownloadLine(line: string): DownloadProgress | null {
  const match = PROGRESS_LINE.exec(String(line ?? "").trim());
  if (!match) return null;

  const percent = Math.min(100, Math.max(0, Number.parseFloat(match[1])));
  const totalBytes = parseSize(match[2], match[3]);
  const speedValue = match[4];
  const speedUnit = match[5];
  // `1.00MiB/s` → `1MiB/s`, `1.23MiB/s` → `1,23MiB/s`: la misma cifra, en el idioma del panel.
  const speed =
    speedValue && speedUnit
      ? `${Number.parseFloat(speedValue)
          .toFixed(2)
          .replace(/\.?0+$/, "")
          .replace(".", ",")}${speedUnit}/s`
      : null;

  return {
    percent,
    totalBytes,
    bytes: totalBytes === null ? null : Math.round((percent / 100) * totalBytes),
    speed,
    eta: match[6] ?? null,
  };
}

