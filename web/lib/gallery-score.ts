/**
 * Puntuación masiva de la galería (RF-21, P3-9): lógica pura, sin disco ni DOM.
 *
 * El operador puntúa **todos** los clips de la galería antes del automático. Cada clip
 * recibe su score 0-100 y un título corto para la edición (el rótulo de su puesto).
 * Los que no llegan al umbral (55 por defecto) se pueden eliminar de la galería para
 * que el automático solo elija entre los que valen.
 */
import { clipLabel, displayName, type LibraryItem } from "./gallery";

/** Umbral por defecto acordado con el operador; se puede ajustar por entorno. */
export const DEFAULT_SCORE_MIN = 55;

/**
 * Umbral normalizado a un entero 0-100. Un valor ausente o inválido cae al de fábrica;
 * así una variable de entorno mal escrita no deja la limpieza sin umbral.
 */
export function parseScoreThreshold(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return DEFAULT_SCORE_MIN;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Título sugerido para la edición a partir del nombre del archivo: sin extensión, sin
 * separadores y en mayúsculas, recortado al ancho de un rótulo (`LIMITS.labelChars`).
 * Es el respaldo determinista cuando el clip no trae uno guardado.
 */
export function titleFromName(name: string): string {
  const words = displayName(name).replace(/[_\-.]+/g, " ");
  return clipLabel(words.toLocaleUpperCase("es")) || "CLIP";
}

/**
 * Rótulo con el que el clip entra en la edición: manda el guardado; si el motor dio un
 * título en esta pasada, ese; y si no, el nombre del archivo. Mismo criterio en todos
 * los caminos (aprobar, automático, puntuación e informe).
 */
export function labelFor(
  item: Pick<LibraryItem, "name" | "label">,
  preferred?: string | null,
): string {
  return item.label ?? (preferred?.trim() || titleFromName(item.name));
}

/** ¿Le falta un score válido (entero 0-100) a este clip? */
export function needsScore(item: LibraryItem): boolean {
  return !(
    Number.isInteger(item.score) &&
    (item.score as number) >= 0 &&
    (item.score as number) <= 100
  );
}

/** Un clip ya puntuado, tal y como lo enseña el informe del panel. */
export interface ScoredClip {
  id: string;
  name: string;
  /** Título que tendrá en la edición. */
  label: string;
  score: number;
  threshold: number;
  pass: boolean;
  source: string | null;
}

export interface ScoreFailure {
  name: string;
  error: string;
}

export interface ScoreReport {
  threshold: number;
  /** De mayor a menor score; el primero es el mejor de la galería. */
  clips: ScoredClip[];
  failed: ScoreFailure[];
  /** Clips puntuados en esta pasada. */
  scored: number;
  /** Clips que ya traían score y solo se han etiquetado. */
  alreadyScored: number;
}

/**
 * Informe determinista: mismo conjunto y mismo umbral ⇒ mismo orden. El score manda y,
 * a igualdad, el título y el id desempatan para que dos pasadas no bailen.
 */
export function buildScoreReport(
  items: LibraryItem[],
  threshold: unknown,
  failed: ScoreFailure[] = [],
  scored = 0,
  alreadyScored = 0,
): ScoreReport {
  const value = parseScoreThreshold(threshold);
  const clips: ScoredClip[] = items
    .filter((item) => !needsScore(item))
    .map((item) => ({
      id: item.id,
      name: item.name,
      label: labelFor(item),
      score: item.score as number,
      threshold: value,
      pass: (item.score as number) >= value,
      source: item.score_source ?? null,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.label.localeCompare(right.label, "es", { sensitivity: "base" }) ||
        left.id.localeCompare(right.id),
    );

  return { threshold: value, clips, failed, scored, alreadyScored };
}
