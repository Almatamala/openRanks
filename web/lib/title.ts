/**
 * El título lleva color por palabra: `*palabra*` sale en amarillo y `_palabra_` en
 * azul (base blanco con contorno negro). Estas marcas son la **única** fuente de
 * verdad, igual que en `openranks/core/specs.py`, así que el panel solo las lee para
 * pintar el selector de palabras y las reconstruye al tocar un color.
 */

export type WordColor = "base" | "yellow" | "blue";

export interface TitleWord {
  text: string;
  color: WordColor;
}

/** Parte el título en palabras, cada una con su color (`base` si no lleva marca). */
export function titleWords(title: string): TitleWord[] {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^\*.+\*$/.test(word)) return { text: word.slice(1, -1), color: "yellow" as const };
      if (/^_.+_$/.test(word)) return { text: word.slice(1, -1), color: "blue" as const };
      return { text: word, color: "base" as const };
    });
}

/** Vuelve a montar el texto con sus marcas a partir de las palabras coloreadas. */
export function wordsToTitle(words: TitleWord[]): string {
  return words
    .map((word) =>
      word.color === "yellow" ? `*${word.text}*` : word.color === "blue" ? `_${word.text}_` : word.text,
    )
    .join(" ");
}

/** Un trozo de título con su color y su escala (el número va mayor, §3). */
export interface TitleSpan {
  text: string;
  color: WordColor;
  scale: number;
}

const MARKED = /\*([^*]+)\*|_([^_]+)_/g;
const NUMBER = /(\d+)/;

/** Texto sin marcas: el primer número va en acento y con más cuerpo. */
function plainSpans(text: string): TitleSpan[] {
  const match = NUMBER.exec(text);
  if (!match) return text ? [{ text, color: "base", scale: 1 }] : [];
  const spans: TitleSpan[] = [];
  const before = text.slice(0, match.index);
  if (before) spans.push({ text: before, color: "base", scale: 1 });
  spans.push({ text: match[1], color: "yellow", scale: 1.35 });
  const after = text.slice(match.index + match[1].length);
  if (after) spans.push({ text: after, color: "base", scale: 1 });
  return spans;
}

/**
 * Trocea el título igual que `title_layers()` en `openranks/core/specs.py`: las
 * marcas `*amarillo*` / `_azul_` no se dibujan y el número suelto va en acento.
 */
export function titleSpans(title: string): TitleSpan[] {
  const spans: TitleSpan[] = [];
  let cursor = 0;
  for (const match of title.matchAll(MARKED)) {
    const index = match.index ?? 0;
    spans.push(...plainSpans(title.slice(cursor, index)));
    const text = match[1] ?? match[2] ?? "";
    if (text) spans.push({ text, color: match[1] !== undefined ? "yellow" : "blue", scale: 1 });
    cursor = index + match[0].length;
  }
  spans.push(...plainSpans(title.slice(cursor)));
  return spans.length > 0 ? spans : [{ text: title, color: "base", scale: 1 }];
}

/** Ciclo del selector: blanco → amarillo → azul → blanco. */
export function cycleColor(color: WordColor): WordColor {
  return color === "base" ? "yellow" : color === "yellow" ? "blue" : "base";
}

/** Caracteres **visibles** del título: las marcas de color no cuentan para el límite. */
export function visibleLength(title: string): number {
  return title.replace(/[*_]/g, "").length;
}
