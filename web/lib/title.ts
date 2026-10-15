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

/** Ciclo del selector: blanco → amarillo → azul → blanco. */
export function cycleColor(color: WordColor): WordColor {
  return color === "base" ? "yellow" : color === "yellow" ? "blue" : "base";
}

/** Caracteres **visibles** del título: las marcas de color no cuentan para el límite. */
export function visibleLength(title: string): number {
  return title.replace(/[*_]/g, "").length;
}
