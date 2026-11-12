import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { JOBS_DIR, SAFE_ID_PATTERN } from "./paths";
import {
  categoriesOf,
  duplicatesByHash,
  filterItems,
  LIBRARY_EXTENSIONS,
  normalizeCategory,
  normalizeLabel,
  type LibraryItem,
} from "./gallery";

// Lo puro (formato, categorías, filtro y selección) vive en `gallery.ts`, que el panel
// también importa. Aquí solo se guarda: índice `library.json` y originales en `library/`.
export {
  categoriesOf,
  categoryKey,
  extensionOf,
  filterItems,
  LIBRARY_EXTENSIONS,
  LIBRARY_MAX_BYTES,
  MERGE_MAX,
  MERGE_MIN,
  normalizeCategory,
  type LibraryItem,
} from "./gallery";

interface LibraryIndex {
  version: 1;
  items: LibraryItem[];
}

const INDEX_FILE = path.join(JOBS_DIR, "library.json");
const LIBRARY_DIR = path.join(JOBS_DIR, "library");
const ALLOWED = LIBRARY_EXTENSIONS as readonly string[];

/** Identificador seguro: solo `[a-z0-9-]`, así que nunca sale del directorio. */
export function isSafeLibraryId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id);
}

/** Ruta del archivo original dentro de `library/`. */
export function libraryFilePath(item: Pick<LibraryItem, "id" | "ext">): string {
  return path.join(LIBRARY_DIR, `${item.id}${item.ext}`);
}

/** Nombre original saneado: sin rutas ni caracteres de control, nunca vacío. */
export function clipName(raw: string, ext: string): string {
  const cleaned = path
    .basename(String(raw ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned ? cleaned.slice(0, 200) : `clip${ext}`;
}

function isLibraryItem(value: unknown): value is LibraryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    SAFE_ID_PATTERN.test(item.id) &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.ext === "string" &&
    ALLOWED.includes(item.ext) &&
    typeof item.bytes === "number" &&
    Number.isFinite(item.bytes) &&
    item.bytes >= 0 &&
    (item.category === null || typeof item.category === "string") &&
    // Duración y hash son opcionales (los clips subidos a mano no los tienen); si vienen,
    // tienen que ser válidos.
    (item.duration_s === undefined ||
      item.duration_s === null ||
      (typeof item.duration_s === "number" &&
        Number.isFinite(item.duration_s) &&
        item.duration_s >= 0)) &&
    (item.sha256 === undefined ||
      item.sha256 === null ||
      (typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256))) &&
    (item.score === undefined ||
      item.score === null ||
      (typeof item.score === "number" &&
        Number.isInteger(item.score) &&
        item.score >= 0 &&
        item.score <= 100)) &&
    (item.score_source === undefined ||
      item.score_source === null ||
      typeof item.score_source === "string") &&
    (item.score_model === undefined ||
      item.score_model === null ||
      typeof item.score_model === "string") &&
    (item.scored_at === undefined ||
      item.scored_at === null ||
      typeof item.scored_at === "string") &&
    (item.label === undefined ||
      item.label === null ||
      typeof item.label === "string") &&
    (item.phash === undefined ||
      item.phash === null ||
      (typeof item.phash === "string" && /^[0-9a-f]{16}$/.test(item.phash)))
  );
}

/**
 * Solo los campos del contrato. Un índice viejo puede traer campos que ya no existen: se
 * descartan al leer, así la API nunca los devuelve.
 */
function normalizeItem(item: LibraryItem): LibraryItem {
  return {
    id: item.id,
    name: item.name,
    ext: item.ext,
    bytes: item.bytes,
    category: item.category,
    ...(typeof item.duration_s === "number" ? { duration_s: item.duration_s } : {}),
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
    ...(item.phash ? { phash: item.phash } : {}),
    ...(typeof item.score === "number" ? { score: item.score } : {}),
    ...(item.score_source ? { score_source: item.score_source } : {}),
    ...(item.score_model ? { score_model: item.score_model } : {}),
    ...(item.scored_at ? { scored_at: item.scored_at } : {}),
    ...(item.label ? { label: item.label } : {}),
  };
}

/**
 * Lee el índice. Un `library.json` corrupto no puede dejar el panel sin galería: se
 * devuelve vacío (los archivos de `library/` siguen ahí) en vez de reventar la API.
 */
export function readLibrary(): LibraryItem[] {
  if (!existsSync(INDEX_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(INDEX_FILE, "utf-8")) as Partial<LibraryIndex>;
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isLibraryItem).map(normalizeItem);
  } catch {
    return [];
  }
}

function writeLibrary(items: LibraryItem[]): void {
  mkdirSync(JOBS_DIR, { recursive: true });
  const index: LibraryIndex = { version: 1, items };
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

/**
 * Orden base de la galería: por nombre y sin distinguir mayúsculas, con los números en su
 * sitio (`escena-2` va antes que `escena-10`). El id desempata para que el orden sea estable.
 */
function sortedLibrary(): LibraryItem[] {
  return readLibrary().sort(
    (left, right) =>
      left.name.localeCompare(right.name, "es", { numeric: true, sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Listado para la API: los clips (filtrados si se pide una categoría) y **todas** las
 * categorías, que son las que alimentan el autocompletado aunque haya filtro activo.
 */
export function libraryListing(category?: string | null): {
  items: LibraryItem[];
  categories: string[];
} {
  const all = sortedLibrary();
  // El duplicado se busca en **toda** la galería: un filtro activo no puede ocultar que
  // dos clips son el mismo plano. El mapa va de más antiguo a más reciente.
  const duplicates = duplicatesByHash([...all].reverse());
  const items = filterItems(all, category).map((item) => {
    const duplicateOf = duplicates.get(item.id);
    return duplicateOf ? { ...item, duplicateOf } : item;
  });
  return { items, categories: categoriesOf(all) };
}

/** Reserva un identificador y la ruta del original; el archivo lo escribe la API. */
export function newLibraryFile(ext: string): { id: string; destination: string } {
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const id = randomUUID();
  return { id, destination: libraryFilePath({ id, ext }) };
}

/** Da de alta un clip ya escrito en disco. El índice nunca apunta a un archivo a medias. */
export function addLibraryItem(input: {
  id: string;
  name: string;
  ext: string;
  bytes: number;
  category?: string | null;
  duration_s?: number | null;
  sha256?: string | null;
  phash?: string | null;
  score?: number | null;
  score_source?: string | null;
  score_model?: string | null;
  scored_at?: string | null;
  label?: string | null;
}): LibraryItem {
  const item: LibraryItem = {
    id: input.id,
    name: clipName(input.name, input.ext),
    ext: input.ext,
    bytes: input.bytes,
    category: normalizeCategory(input.category ?? null),
    // Solo se escriben cuando existen: el contrato de los clips subidos a mano no cambia.
    ...(typeof input.duration_s === "number" ? { duration_s: input.duration_s } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.phash ? { phash: input.phash } : {}),
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    ...(input.score_source ? { score_source: input.score_source } : {}),
    ...(input.score_model ? { score_model: input.score_model } : {}),
    ...(input.scored_at ? { scored_at: input.scored_at } : {}),
    ...(input.label ? { label: input.label } : {}),
  };
  writeLibrary([item, ...readLibrary()]);
  return item;
}

/** Quita un clip de la galería y borra su original. `null` si ya no está. */
export function removeLibraryItem(id: string): LibraryItem | null {
  const items = readLibrary();
  const item = items.find((entry) => entry.id === id);
  if (!item) return null;
  try {
    rmSync(libraryFilePath(item), { force: true });
  } catch {
    // El archivo puede estar abierto (reproduciéndose en la galería). La entrada se va
    // igual: es lo que ve el operador, y el archivo suelto no se sirve sin índice.
  }
  writeLibrary(items.filter((entry) => entry.id !== id));
  return item;
}

/** Cambia (o borra, con `null`) la categoría de un clip. `null` si ya no existe. */
export function setCategory(id: string, raw: unknown): LibraryItem | null {
  const items = readLibrary();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const updated: LibraryItem = { ...items[index], category: normalizeCategory(raw) };
  items[index] = updated;
  writeLibrary(items);
  return updated;
}

/** Guarda el score de un clip (P3-9) y, si llega, su título de edición. */
export function setScore(
  id: string,
  input: {
    score: number;
    score_source?: string | null;
    score_model?: string | null;
    scored_at?: string | null;
    duration_s?: number | null;
    label?: string | null;
  },
): LibraryItem | null {
  const items = readLibrary();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) return null;
  const label = normalizeLabel(input.label);

  const item: LibraryItem = {
    ...items[index],
    score: input.score,
    ...(input.score_source ? { score_source: input.score_source } : {}),
    ...(input.score_model ? { score_model: input.score_model } : {}),
    ...(input.scored_at ? { scored_at: input.scored_at } : {}),
    ...(typeof input.duration_s === "number" &&
    Number.isFinite(input.duration_s) &&
    input.duration_s > 0
      ? { duration_s: input.duration_s }
      : {}),
    ...(label ? { label } : {}),
  };
  items[index] = item;
  writeLibrary(items);
  return item;
}

/** Título corto con el que el clip entra en la edición; vacío lo quita. */
export function setLabel(id: string, raw: unknown): LibraryItem | null {
  const items = readLibrary();
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return null;

  const label = normalizeLabel(raw);
  const item: LibraryItem = { ...items[index] };
  if (label) item.label = label;
  else delete item.label;
  items[index] = item;
  writeLibrary(items);
  return item;
}
