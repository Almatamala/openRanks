/**
 * Límites del **texto editable** (RPD §9.5). Son un espejo de la validación de
 * `openranks/core/config.py` y `core/binding.py`: si el panel acepta algo que el
 * motor rechaza, el error llegaría al render en vez de al formulario.
 */
import { visibleLength } from "./title";

export const LIMITS = {
  titleLayerChars: 40,
  labelChars: 24,
} as const;

/**
 * Puestos del ranking: el formato va del TOP 5 al TOP 10 (§3). Espejo de
 * `Config.items_min` / `items_max` en `openranks/core/config.py` (hay un test que lo
 * comprueba, para que el panel no ofrezca lo que el motor rechaza).
 */
export const POSITIONS_MIN = 5;
export const POSITIONS_MAX = 10;

/** Deja el número de puestos dentro del formato. */
export function clampPositions(count: unknown): number {
  const value = typeof count === "number" ? count : Number.parseInt(String(count ?? ""), 10);
  if (!Number.isFinite(value)) return POSITIONS_MIN;
  return Math.min(POSITIONS_MAX, Math.max(POSITIONS_MIN, Math.round(value)));
}

/** Las posiciones de un ranking de `count` puestos, del último al primero (`5,4,…,1`). */
export function positionsFor(count: number): number[] {
  const size = clampPositions(count);
  return Array.from({ length: size }, (_, index) => size - index);
}

export function titleErrors(title: string): string[] {
  const errors: string[] = [];
  const text = title.trim();
  const length = visibleLength(text);
  if (!text) errors.push("Escribe un título para el vídeo.");
  else if (length > LIMITS.titleLayerChars)
    errors.push(`El título tiene ${length} caracteres; el máximo es ${LIMITS.titleLayerChars}.`);
  return errors;
}

/** El subtítulo es **opcional**; si se escribe, cabe en el mismo límite que una capa. */
export function subtitleErrors(subtitle: string): string[] {
  const text = subtitle.trim();
  if (!text) return [];
  const length = textLength(text);
  return length > LIMITS.titleLayerChars
    ? [`El subtítulo tiene ${length} caracteres; el máximo es ${LIMITS.titleLayerChars}.`]
    : [];
}

/** Cuenta caracteres Unicode (un emoji = 1), no unidades UTF-16 del navegador. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Cuerpo de texto que manda el panel (montar o unir): mismo saneado y las mismas
 * comprobaciones en los dos sitios, para que un texto que el formulario acepta no
 * llegue al motor como error.
 */
export interface TextRequest {
  title: string;
  subtitle: string;
  positions: number;
  labels: Record<string, string>;
  problems: string[];
}

export function parseTextRequest(body: {
  title?: unknown;
  subtitle?: unknown;
  labels?: unknown;
  positions?: unknown;
}): TextRequest {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  // Opcional: un subtítulo vacío es válido y el vídeo sale sin él.
  const subtitle = typeof body.subtitle === "string" ? body.subtitle.trim() : "";
  const positions = clampPositions(body.positions);
  const rawLabels = (body.labels ?? {}) as Record<string, unknown>;
  const labels: Record<string, string> = {};
  const problems = [...titleErrors(title), ...subtitleErrors(subtitle)];
  for (const position of positionsFor(positions)) {
    const label = typeof rawLabels[String(position)] === "string" ? String(rawLabels[String(position)]).trim() : "";
    labels[String(position)] = label;
    problems.push(...labelErrors(position, label));
  }
  return { title, subtitle, positions, labels, problems };
}

export function labelErrors(position: number, label: string): string[] {
  const errors: string[] = [];
  const text = label.trim();
  if (!text) {
    errors.push(`El puesto #${position} necesita un nombre.`);
    return errors;
  }
  // Sin tope de palabras: solo manda el ancho del rótulo (caracteres).
  const length = textLength(text);
  if (length > LIMITS.labelChars)
    errors.push(`El nombre del #${position} tiene ${length} caracteres; el máximo es ${LIMITS.labelChars}.`);
  return errors;
}
