/**
 * Lógica pura de la galería (RF-11 y RF-12): sin Node y sin DOM, para que la compartan
 * la API (`lib/library.ts`, que es la que toca disco) y el panel
 * (`components/Gallery.tsx`) sin duplicar reglas. Se puede probar sin navegador.
 */
import { POSITIONS_MAX, POSITIONS_MIN } from "./limits";

/** Un clip de la galería, tal y como lo devuelve la API (nunca con rutas del host). */
export interface LibraryItem {
  /** Identificador público del clip en la galería. */
  id: string;
  /** Nombre original del archivo, sin rutas. No es único: dos clips pueden llamarse igual. */
  name: string;
  /** Extensión canónica, con punto (`".mp4"`). */
  ext: string;
  bytes: number;
  /** Texto libre; `null` es «Sin categoría» (RF-11.3). */
  category: string | null;
  /** Duración medida al recortar el tramo (segundos). */
  duration_s?: number | null;
  /** SHA-256 del clip: deduplicación al volver a extraer el mismo tramo. */
  sha256?: string | null;
  /** Huella perceptual del fotograma central; ausente si no se pudo calcular. */
  phash?: string | null;
  /** Id del clip más antiguo con el mismo plano: lo calcula el listado, no se guarda. */
  duplicateOf?: string | null;
}

/** Los mismos formatos que la subida de puestos (RF-11.2). */
export const LIBRARY_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"] as const;

/** 2 GB por archivo, igual que el límite de la subida actual. */
export const LIBRARY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Fusión de clips: de 2 a 4 se pegan en uno solo, en el orden que elija el operador. Por
 * debajo de dos no hay nada que pegar; por encima de cuatro deja de ser un clip de trabajo.
 */
export const MERGE_MIN = 2;
export const MERGE_MAX = 4;

const ALLOWED = LIBRARY_EXTENSIONS as readonly string[];

/**
 * Extensión aceptada, sacada del **nombre original** (no de una pista del cliente).
 * Devuelve `null` si el formato no es de vídeo o no está en la lista: el panel puede
 * rechazarlo antes de subir un solo byte (RF-11.2).
 */
export function extensionOf(name: string): string | null {
  const clean = String(name ?? "").trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const index = clean.lastIndexOf(".");
  if (index <= 0) return null;
  const ext = clean.slice(index);
  return ALLOWED.includes(ext) ? ext : null;
}

/**
 * Categoría normalizada: se recorta y se colapsa el espacio sobrante; vacía es
 * «Sin categoría» (`null`). Se comparan sin distinguir mayúsculas (RF-11.3).
 */
export function normalizeCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text ? text : null;
}

/** Clave de comparación: dos grafías que solo cambian en mayúsculas son la misma. */
export function categoryKey(category: string | null): string {
  return (category ?? "").normalize("NFC").toLocaleLowerCase("es");
}

/** Filtra por categoría; `undefined` es «Todas» y `null` es «Sin categoría». */
export function filterItems<T extends { category: string | null }>(
  items: T[],
  category: string | null | undefined,
): T[] {
  if (category === undefined) return items;
  const key = categoryKey(category);
  return items.filter((item) => categoryKey(item.category) === key);
}

/** Categorías existentes: sin repetir por mayúsculas, ordenadas y sin la vacía. */
export function categoriesOf(items: Array<{ category: string | null }>): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    if (!item.category) continue;
    const key = categoryKey(item.category);
    if (!seen.has(key)) seen.set(key, item.category);
  }
  return [...seen.values()].sort((left, right) => left.localeCompare(right, "es"));
}

/**
 * Selección ordenada (RF-12.1): el **orden de selección** fija el puesto, con el
 * primero como #1 (el mejor, cierra el vídeo). Deseleccionar renumera solo, porque el
 * puesto es la posición dentro de esta lista.
 */
export const SELECTION_MIN = POSITIONS_MIN;
export const SELECTION_MAX = POSITIONS_MAX;

/** Puesto que ocupa un clip en la selección (`#1` para el primero), o `null`. */
export function selectionPosition(selected: string[], id: string): number | null {
  const index = selected.indexOf(id);
  return index === -1 ? null : index + 1;
}

/** ¿Se puede marcar esta tarjeta? Ya elegida sí (para deseleccionar); si no, con hueco. */
export function canSelect(selected: string[], id: string): boolean {
  return selected.includes(id) || selected.length < SELECTION_MAX;
}

/** Marca o desmarca un clip. Con 10 ya elegidos no se añade ninguno más. */
export function toggleSelection(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((value) => value !== id);
  if (selected.length >= SELECTION_MAX) return selected;
  return [...selected, id];
}

/** Cuántos clips faltan para poder generar (0 cuando ya se puede, o si ya hay 10). */
export function missingForGeneration(selected: string[]): number {
  return Math.max(0, SELECTION_MIN - selected.length);
}

/** «Generar manual» solo se activa con 5 a 10 seleccionados (RF-12.2 y RF-12.3). */
export function canGenerate(selected: string[]): boolean {
  return selected.length >= SELECTION_MIN && selected.length <= SELECTION_MAX;
}

/** Distancia de Hamming con la que dos pHash son el mismo plano (huella de 64 bits). */
const PHASH_DUPLICATE_DISTANCE = 8;

const PHASH_PATTERN = /^[0-9a-f]{16}$/;

/** ¿Es una huella pHash de 16 dígitos hexadecimales? */
export function isPhash(value: unknown): value is string {
  return typeof value === "string" && PHASH_PATTERN.test(value);
}

/** Bits distintos entre dos huellas; 64 (el máximo) si alguna no es válida. */
export function hammingDistance(left: unknown, right: unknown): number {
  if (!isPhash(left) || !isPhash(right)) return 64;
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let bits = 0;
  while (difference > 0n) {
    bits += Number(difference & 1n);
    difference >>= 1n;
  }
  return bits;
}

/**
 * Planos repetidos: para cada clip, el id del **primero** (el más antiguo) que tiene la
 * misma huella. Se recorre de más antiguo a más reciente, así todas las copias apuntan
 * al original y no a la anterior.
 */
export function duplicatesByHash<T extends { id: string; phash?: string | null }>(
  chronological: T[],
  maxDistance = PHASH_DUPLICATE_DISTANCE,
): Map<string, string> {
  const duplicates = new Map<string, string>();
  for (let position = 0; position < chronological.length; position += 1) {
    const current = chronological[position];
    if (!isPhash(current.phash)) continue;
    for (let earlier = 0; earlier < position; earlier += 1) {
      const previous = chronological[earlier];
      if (hammingDistance(previous.phash, current.phash) <= maxDistance) {
        duplicates.set(current.id, previous.id);
        break;
      }
    }
  }
  return duplicates;
}
