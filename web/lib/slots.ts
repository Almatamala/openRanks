/**
 * Puestos de la vista de montaje: lo que ocupa cada casilla y el intercambio de dos
 * puestos (RF-13). Es lógica pura —sin DOM y sin disco— para poder probarla con
 * `node --test`; el servidor mueve los archivos en `lib/reorder.ts`.
 */

/** Una casilla del montaje. El puesto manda; el clip, el nombre importado y el rótulo viajan. */
export interface Slot {
  position: number;
  file: File | null;
  /** Nombre del clip que vino de la galería: el archivo está en el servidor, no aquí. */
  imported: string | null;
  label: string;
}

/**
 * Intercambia el contenido de dos puestos **sin tocar sus números**: la casilla del #1
 * pasa a mostrar el clip del #5 y al revés. Si alguno de los dos no existe, no cambia
 * nada (el arrastre llega con índices de una vista que puede haberse actualizado).
 */
export function swapSlots(slots: Slot[], from: number, to: number): Slot[] {
  if (from === to) return slots;
  const source = slots.find((slot) => slot.position === from);
  const target = slots.find((slot) => slot.position === to);
  if (!source || !target) return slots;
  return slots.map((slot) => {
    if (slot.position === from) {
      return { ...slot, file: target.file, imported: target.imported, label: target.label };
    }
    if (slot.position === to) {
      return { ...slot, file: source.file, imported: source.imported, label: source.label };
    }
    return slot;
  });
}
