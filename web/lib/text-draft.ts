import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { JOBS_DIR } from "./paths";

/**
 * Respaldo del texto que el operador guarda con el botón **Guardar** (RF-9.7).
 *
 * El borrador de trabajo vive en el navegador; este archivo existe para recuperar el
 * último texto guardado en una sesión limpia (otro equipo, almacenamiento borrado) sin
 * tocar el preset, que solo guarda estilo.
 */
export interface SavedText {
  title: string;
  subtitle: string;
  savedAt: string;
}

export const TEXT_DRAFT_PATH = path.join(JOBS_DIR, "text.json");

/** `null` si todavía no se guardó nada o el archivo no es válido. */
export function readSavedText(): SavedText | null {
  if (!existsSync(TEXT_DRAFT_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(TEXT_DRAFT_PATH, "utf-8")) as Partial<SavedText>;
    if (typeof parsed.title !== "string" || typeof parsed.subtitle !== "string") return null;
    return {
      title: parsed.title,
      subtitle: parsed.subtitle,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Guarda el texto actual. Es un **borrador**, no una validación: el formulario sigue
 * mostrando sus límites y el motor valida al montar (§9.5). Así nunca se pierde lo que
 * el operador está escribiendo por guardar un texto a medio corregir.
 */
export function writeSavedText(input: { title?: unknown; subtitle?: unknown }): SavedText {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const subtitle = typeof input.subtitle === "string" ? input.subtitle.trim() : "";
  const saved: SavedText = { title, subtitle, savedAt: new Date().toISOString() };
  mkdirSync(JOBS_DIR, { recursive: true });
  writeFileSync(TEXT_DRAFT_PATH, JSON.stringify(saved, null, 2) + "\n", "utf-8");
  return saved;
}
