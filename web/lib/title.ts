/**
 * El título lleva color por palabra: `*palabra*` sale en amarillo y `_palabra_` en
 * azul (base blanco con contorno negro). Estas marcas son la **única** fuente de
 * verdad, igual que en `openranks/core/specs.py`: el panel las lee para pintar el
 * selector de palabras y las reconstruye al tocar un color (el reparto en renglones lo
 * decide el motor al renderizar).
 */

export type WordColor = "base" | "yellow" | "blue";

export interface TitleWord {
  text: string;
  color: WordColor;
}

/**
 * Parte el título en palabras, cada una con su color (`base` si no lleva marca).
 *
 * Las marcas pueden abarcar varias palabras (`*TOP 5*`), igual que en el motor. Por eso
 * se recorre el texto por tramos marcados y cada tramo se parte en palabras, en vez de
 * exigir que la marca quepa dentro de una sola palabra.
 */
export function titleWords(title: string): TitleWord[] {
  const words: TitleWord[] = [];
  const pattern = /\*([^*]+)\*|_([^_]+)_|([^*_]+)/g;
  for (const match of title.matchAll(pattern)) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    const color: WordColor =
      match[1] !== undefined ? "yellow" : match[2] !== undefined ? "blue" : "base";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      words.push({ text: word, color });
    }
  }
  return words;
}

/** Vuelve a montar el texto con sus marcas a partir de las palabras coloreadas. */
export function wordsToTitle(words: TitleWord[]): string {
  return words
    .map((word) =>
      word.color === "yellow" ? `*${word.text}*` : word.color === "blue" ? `_${word.text}_` : word.text,
    )
    .join(" ");
}

/** Ciclo del selector: blanco → amarillo → azul → blanco. */
export function cycleColor(color: WordColor): WordColor {
  return color === "base" ? "yellow" : color === "yellow" ? "blue" : "base";
}

/**
 * Caracteres **visibles** del título: las marcas de color no cuentan.
 *
 * Se cuenta por puntos de código (un emoji = 1), no por unidades UTF-16: el motor
 * valida con `len()` de Python y el contador tiene que dar el mismo número.
 */
export function visibleLength(title: string): number {
  return Array.from(title.replace(/[*_]/g, "")).length;
}
