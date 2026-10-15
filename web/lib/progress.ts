/**
 * Progreso del montaje tal y como lo publica el motor.
 *
 * El contrato vive en `openranks/core/progress.py`: una línea JSON por avance, en
 * **stderr**, con este prefijo, para no mezclarse con el resultado (stdout) ni con
 * los avisos de FFmpeg. Aquí solo se lee y se convierte en tiempo restante.
 */
export const PROGRESS_PREFIX = "OPENRANKS_PROGRESS ";

export interface ProgressEvent {
  percent: number;
  phase: string;
  label: string;
  step?: number;
  total?: number;
}

export function parseProgressLine(line: string): ProgressEvent | null {
  const text = line.trim();
  if (!text.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const payload = JSON.parse(text.slice(PROGRESS_PREFIX.length)) as Partial<ProgressEvent>;
    if (typeof payload.percent !== "number" || typeof payload.phase !== "string") return null;
    return {
      percent: payload.percent,
      phase: payload.phase,
      label: typeof payload.label === "string" ? payload.label : "",
      step: payload.step,
      total: payload.total,
    };
  } catch {
    return null;
  }
}

/**
 * Tiempo restante estimado, por regla de tres sobre lo que ya se ha hecho.
 *
 * Es una estimación honesta: sale del porcentaje real y del tiempo transcurrido, no
 * de un temporizador inventado. Si aún no hay datos suficientes devuelve `null`.
 */
export function estimateRemainingSeconds(percent: number, startedAtMs: number, nowMs: number): number | null {
  if (!Number.isFinite(percent) || percent <= 1 || percent >= 100) return null;
  const elapsedSeconds = (nowMs - startedAtMs) / 1000;
  if (elapsedSeconds <= 0) return null;
  const remaining = (elapsedSeconds / percent) * (100 - percent);
  // Un ETA absurdo (el motor terminó o se atascó) se prefiere no mostrar a mentir.
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 6 * 3600) return null;
  return Math.round(remaining);
}

/** `95` → `1:35`; `3725` → `1:02:05`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${minutes}:${String(secs).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : mmss;
}
