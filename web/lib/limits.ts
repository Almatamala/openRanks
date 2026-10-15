/**
 * Límites del **texto editable** (plan §9.5). Son un espejo de la validación de
 * `openranks/core/config.py` y `core/binding.py`: si el panel acepta algo que el
 * motor rechaza, el error llegaría al render en vez de al formulario.
 */
import { visibleLength } from "./title";

export const LIMITS = {
  titleLayerChars: 28,
  titleLayersMax: 3,
  labelChars: 24,
  labelWords: 4,
  positions: [5, 4, 3, 2, 1],
} as const;

export function titleErrors(title: string): string[] {
  const errors: string[] = [];
  const text = title.trim();
  const length = visibleLength(text);
  if (!text) errors.push("Escribe un título para el vídeo.");
  else if (length > LIMITS.titleLayerChars)
    errors.push(`El título tiene ${length} caracteres; el máximo es ${LIMITS.titleLayerChars}.`);
  return errors;
}

export function labelErrors(position: number, label: string): string[] {
  const errors: string[] = [];
  const text = label.trim();
  if (!text) {
    errors.push(`El puesto #${position} necesita un nombre.`);
    return errors;
  }
  if (text.length > LIMITS.labelChars)
    errors.push(`El nombre del #${position} tiene ${text.length} caracteres; el máximo es ${LIMITS.labelChars}.`);
  if (text.split(/\s+/).length > LIMITS.labelWords)
    errors.push(`El nombre del #${position} tiene más de ${LIMITS.labelWords} palabras.`);
  return errors;
}

/** `gato_volador.mp4` → `GATO VOLADOR` (≤ 24 caracteres, ≤ 4 palabras). */
export function labelFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const words = base
    .replace(/[_\-.]+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, LIMITS.labelWords);
  const text = words.join(" ").slice(0, LIMITS.labelChars).trim();
  return text;
}
