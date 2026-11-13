/**
 * Selección automática del ranking (RF-19, P3-7): lógica pura, sin DOM ni disco.
 *
 * El automático **propone** una selección; no monta nada. Usa el score que ya trae cada
 * clip —siempre del LLM— y no hace ninguna llamada al proveedor.
 *
 * Criterio:
 * - solo clips con score entero 0-100 y duración medida, sin duplicados de plano;
 * - de mayor a menor score, como mucho dos clips por categoría mientras haya margen;
 * - 5-10 clips y un total de hasta 58 s; si la suma no llega a 30 s se completa con
 *   clips más largos y, si aun así no llega, se propone con un aviso (igual que L1).
 *
 * La lista resultante va del **#1 (mejor)** al último: el #1 es el que cierra el vídeo.
 */
import { categoryKey, SELECTION_MAX, SELECTION_MIN, type LibraryItem } from "./gallery";
import { labelFor } from "./gallery-score";

/** Techo duro del vídeo unido (RPD §3). */
export const AUTO_MAX_TOTAL_S = 58;
/** Mínimo recomendado; por debajo se avisa, no se bloquea. */
export const AUTO_MIN_TOTAL_S = 30;
/** Diversidad: como mucho dos clips de la misma categoría mientras haya recambio. */
export const AUTO_MAX_PER_CATEGORY = 2;

const EPSILON = 1e-9;

/** Un clip ya listo para entrar en la propuesta. */
export interface AutoClip {
  id: string;
  name: string;
  /** Título con el que el clip entra en la edición. */
  label: string;
  score: number;
  category: string | null;
  duration_s: number;
  score_source: string | null;
}

export interface AutoProposal {
  /** Mejor primero: `clips[0]` es el #1 y cierra el vídeo; el último abre. */
  clips: AutoClip[];
  total_s: number;
  warnings: string[];
  /** Clips que no entraron en el cálculo por no tener score, duración o ser duplicados. */
  ignored: number;
}

export type AutoResult =
  | { ok: true; proposal: AutoProposal }
  | { ok: false; reason: string };

/** ¿Es un candidato con score y duración utilizables? */
function isCandidate(
  item: LibraryItem,
): item is LibraryItem & { score: number; duration_s: number } {
  return (
    !item.duplicateOf &&
    Number.isInteger(item.score) &&
    (item.score as number) >= 0 &&
    (item.score as number) <= 100 &&
    typeof item.duration_s === "number" &&
    Number.isFinite(item.duration_s) &&
    item.duration_s > 0
  );
}

function toClip(item: LibraryItem & { score: number; duration_s: number }): AutoClip {
  return {
    id: item.id,
    name: item.name,
    label: labelFor(item),
    score: item.score,
    category: item.category,
    duration_s: item.duration_s,
    score_source: item.score_source ?? null,
  };
}

/** Candidatos válidos, sin duplicados de plano ni clips sin score o sin duración. */
export function autoCandidates(items: LibraryItem[]): AutoClip[] {
  return items.filter(isCandidate).map(toClip);
}

/** ¿Hay suficientes clips puntuados para intentar el automático? */
export function autoReadiness(items: LibraryItem[] | null): { ready: boolean; reason: string } {
  if (items === null) return { ready: false, reason: "Leyendo la galería…" };
  const count = autoCandidates(items).length;
  if (count >= SELECTION_MIN) return { ready: true, reason: "" };
  return {
    ready: false,
    reason: `Necesitas al menos ${SELECTION_MIN} clips con score y duración medida para usar el automático; hay ${count}.`,
  };
}

/** Orden de calidad: score, duración, nombre y id. Nunca depende del orden de entrada. */
function byQuality(left: AutoClip, right: AutoClip): number {
  return (
    right.score - left.score ||
    right.duration_s - left.duration_s ||
    left.name.localeCompare(right.name, "es", { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function totalOf(clips: AutoClip[]): number {
  return Math.round(clips.reduce((sum, clip) => sum + clip.duration_s, 0) * 1000) / 1000;
}

function seconds(value: number): string {
  return `${value.toFixed(1).replace(".", ",")} s`;
}

/**
 * Propone una selección. Devuelve un `reason` legible cuando no hay 5 clips que quepan
 * en 58 s; si la suma queda por debajo de 30 s, propone igualmente y añade un aviso.
 */
export function suggestAutoSelection(items: LibraryItem[]): AutoResult {
  const candidates = autoCandidates(items);
  if (candidates.length < SELECTION_MIN) {
    return {
      ok: false,
      reason: `Necesitas al menos ${SELECTION_MIN} clips con score y duración medida para generar automático; hay ${candidates.length}.`,
    };
  }

  const ranked = [...candidates].sort(byQuality);
  const chosen: AutoClip[] = [];
  const perCategory = new Map<string, number>();
  let total = 0;

  const fits = (duration: number) => total + duration <= AUTO_MAX_TOTAL_S + EPSILON;
  const add = (clip: AutoClip) => {
    chosen.push(clip);
    total += clip.duration_s;
    const key = categoryKey(clip.category);
    perCategory.set(key, (perCategory.get(key) ?? 0) + 1);
  };
  const has = (clip: AutoClip) => chosen.some((entry) => entry.id === clip.id);

  // Primera pasada: calidad y diversidad, sin pasar de 58 s.
  for (const clip of ranked) {
    if (chosen.length >= SELECTION_MAX) break;
    if ((perCategory.get(categoryKey(clip.category)) ?? 0) >= AUTO_MAX_PER_CATEGORY) continue;
    if (!fits(clip.duration_s)) continue;
    add(clip);
  }

  // Si la diversidad dejó la propuesta por debajo de 5, se completa sin el tope por
  // categoría: el formato manda sobre la variedad.
  if (chosen.length < SELECTION_MIN) {
    for (const clip of ranked) {
      if (chosen.length >= SELECTION_MIN) break;
      if (has(clip) || !fits(clip.duration_s)) continue;
      add(clip);
    }
  }

  if (chosen.length < SELECTION_MIN) {
    return {
      ok: false,
      reason: `No hay ${SELECTION_MIN} clips con score que quepan en ${AUTO_MAX_TOTAL_S} s. Acorta algún clip o genera manualmente.`,
    };
  }

  // Por debajo de 30 s: añade los mejores clips que quepan y, si ya hay 10, cambia el
  // peor por uno más largo. El aviso solo queda si ni así se alcanza el mínimo.
  if (total < AUTO_MIN_TOTAL_S) {
    for (const clip of ranked) {
      if (chosen.length >= SELECTION_MAX || total >= AUTO_MIN_TOTAL_S) break;
      if (has(clip) || !fits(clip.duration_s)) continue;
      add(clip);
    }
  }

  let guard = 0;
  while (total < AUTO_MIN_TOTAL_S && guard < SELECTION_MAX * 2) {
    guard += 1;
    const worst = [...chosen].sort(byQuality).at(-1);
    if (!worst) break;

    let replacement: AutoClip | null = null;
    for (const clip of ranked) {
      if (has(clip)) continue;
      const next = total - worst.duration_s + clip.duration_s;
      if (next > total + EPSILON && next <= AUTO_MAX_TOTAL_S + EPSILON) {
        if (!replacement || byQuality(clip, replacement) < 0) replacement = clip;
      }
    }
    if (!replacement) break;

    chosen.splice(chosen.indexOf(worst), 1);
    chosen.push(replacement);
    total = totalOf(chosen);
  }

  const clips = [...chosen].sort(byQuality);
  const total_s = totalOf(clips);
  const warnings: string[] = [];
  if (total_s + EPSILON < AUTO_MIN_TOTAL_S) {
    warnings.push(
      `La selección suma ${seconds(total_s)}, por debajo de ${AUTO_MIN_TOTAL_S} s; el montaje lo avisará.`,
    );
  }

  return {
    ok: true,
    proposal: {
      clips,
      total_s,
      warnings,
      ignored: items.length - candidates.length,
    },
  };
}
