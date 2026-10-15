import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { JOBS_DIR } from "./paths";

/**
 * El panel puede ajustar y **guardar** una parte del preset (el resto sigue fijo).
 * Se guarda un único preset, en el volumen de trabajos, y el motor lo lee por
 * `OPENRANKS_PRESET_FILE`: así el montaje usa exactamente lo que se ve en la vista
 * previa. Las claves permitidas espejan `openranks/core/overlay.py::EDITABLE_SECTIONS`.
 */
export interface EditablePreset {
  font: string;
  title: { size: number; background: boolean };
  rank_ladder: { size: number; x: number; y_top: number; y_bottom: number };
}

export const PRESET_PATH = path.join(JOBS_DIR, "preset.json");

/** Familias que la imagen de Docker trae instaladas (más Symbola para las medallas). */
export const FONT_CHOICES = ["DejaVu Sans", "Liberation Sans", "DejaVu Serif", "Symbola"] as const;

/** Rangos de los deslizadores: espejo del lienzo 1080x1920. */
export const PRESET_RANGES = {
  titleSize: [40, 220] as const,
  ladderSize: [60, 220] as const,
  x: [0, 1080] as const,
  yTop: [0, 1900] as const,
  yBottom: [0, 1900] as const,
};

function clamp(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function pickFont(value: unknown): string {
  return typeof value === "string" && (FONT_CHOICES as readonly string[]).includes(value)
    ? value
    : FONT_CHOICES[0];
}

/**
 * Deja el preset en algo que el motor puede dibujar: números dentro de rango y una
 * fuente de la lista blanca. Un valor raro nunca llega al script ASS.
 */
export function sanitizePreset(input: unknown): EditablePreset {
  const raw = (input ?? {}) as Partial<EditablePreset>;
  const title = (raw.title ?? {}) as Partial<EditablePreset["title"]>;
  const ladder = (raw.rank_ladder ?? {}) as Partial<EditablePreset["rank_ladder"]>;
  return {
    font: pickFont(raw.font),
    title: {
      size: clamp(title.size, PRESET_RANGES.titleSize, 104),
      background: Boolean(title.background),
    },
    rank_ladder: {
      size: clamp(ladder.size, PRESET_RANGES.ladderSize, 132),
      x: clamp(ladder.x, PRESET_RANGES.x, 176),
      y_top: clamp(ladder.y_top, PRESET_RANGES.yTop, 392),
      y_bottom: clamp(ladder.y_bottom, PRESET_RANGES.yBottom, 1496),
    },
  };
}

/** El preset guardado, o `null` si todavía no hay ninguno (se usan los de fábrica). */
export function readPreset(): EditablePreset | null {
  if (!existsSync(PRESET_PATH)) return null;
  try {
    return sanitizePreset(JSON.parse(readFileSync(PRESET_PATH, "utf-8")));
  } catch {
    return null;
  }
}

/** Guarda el preset (solo se conserva el último). */
export function writePreset(preset: EditablePreset): EditablePreset {
  mkdirSync(JOBS_DIR, { recursive: true });
  writeFileSync(PRESET_PATH, JSON.stringify(preset, null, 2) + "\n", "utf-8");
  return preset;
}

/** Vuelve a los valores de fábrica. */
export function clearPreset(): void {
  rmSync(PRESET_PATH, { force: true });
}
