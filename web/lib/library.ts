import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { JOBS_DIR } from "./paths";
import {
  categoriesOf,
  filterItems,
  LIBRARY_EXTENSIONS,
  normalizeCategory,
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
  normalizeCategory,
  type LibraryItem,
} from "./gallery";

interface LibraryIndex {
  version: 1;
  items: LibraryItem[];
}

const INDEX_FILE = path.join(JOBS_DIR, "library.json");
const LIBRARY_DIR = path.join(JOBS_DIR, "library");
const ID_PATTERN = /^[a-z0-9-]{6,64}$/;
const ALLOWED = LIBRARY_EXTENSIONS as readonly string[];

export function libraryDir(): string {
  return LIBRARY_DIR;
}

/** Identificador seguro: solo `[a-z0-9-]`, así que nunca sale del directorio. */
export function isSafeLibraryId(id: string): boolean {
  return ID_PATTERN.test(id);
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
    ID_PATTERN.test(item.id) &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    typeof item.ext === "string" &&
    ALLOWED.includes(item.ext) &&
    typeof item.bytes === "number" &&
    Number.isFinite(item.bytes) &&
    item.bytes >= 0 &&
    (item.category === null || typeof item.category === "string") &&
    typeof item.addedAt === "string"
  );
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
    return parsed.items.filter(isLibraryItem);
  } catch {
    return [];
  }
}

function writeLibrary(items: LibraryItem[]): void {
  mkdirSync(JOBS_DIR, { recursive: true });
  const index: LibraryIndex = { version: 1, items };
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

/** Índice completo, de lo más reciente a lo más antiguo. */
function sortedLibrary(): LibraryItem[] {
  return readLibrary().sort(
    (left, right) => right.addedAt.localeCompare(left.addedAt) || right.id.localeCompare(left.id),
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
  return { items: filterItems(all, category), categories: categoriesOf(all) };
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
}): LibraryItem {
  const item: LibraryItem = {
    id: input.id,
    name: clipName(input.name, input.ext),
    ext: input.ext,
    bytes: input.bytes,
    category: normalizeCategory(input.category ?? null),
    addedAt: new Date().toISOString(),
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
