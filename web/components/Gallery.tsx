"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { formatDuration } from "@/lib/progress";
import {
  canGenerate,
  canSelect,
  categoryKey,
  extensionOf,
  filterItems,
  LIBRARY_EXTENSIONS,
  LIBRARY_MAX_BYTES,
  missingForGeneration,
  normalizeCategory,
  SELECTION_MAX,
  SELECTION_MIN,
  selectionPosition,
  toggleSelection,
  type LibraryItem,
} from "@/lib/gallery";

/** Valores del filtro que no son una categoría real. */
const ALL = "__todas__";
const NONE = "__sin_categoria__";

const FORMATS = LIBRARY_EXTENSIONS.map((ext) => ext.slice(1).toUpperCase()).join(", ");

/** Tarjetas que se montan de una vez: con muchas más, la galería se arrastra. */
const PAGE_SIZE = 24;

/**
 * `12.345` → `0:12.345`: el divisor corta por milisegundos, así que la línea de tiempo
 * enseña las tres cifras y no redondea a segundos como el resto de duraciones del panel.
 */
function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = String(total % 1000).padStart(3, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${millis}`
    : `${minutes}:${String(secs).padStart(2, "0")}.${millis}`;
}

/** Origen reproducible de un original de la galería. */
function fileUrl(id: string): string {
  return `/api/library/${id}/file`;
}

/**
 * Galería de la Fase 2 (RF-11 y RF-12): sube originales, los etiqueta y deja elegir
 * entre 5 y 10 en el orden del ranking. La selección vive en la sesión —no se guarda—
 * y sobrevive a cambiar de sección; el orden de selección fija el puesto (#1 el primero).
 */
function Gallery({
  active,
  hasMontage,
  montageBusy,
  onGenerate,
  refreshKey = 0,
}: {
  /** La sección de galería está a la vista: sin esto no se montan sus tarjetas ni sus vídeos. */
  active: boolean;
  /** Hay un montaje abierto en la sesión: generar pedirá confirmación antes de reemplazarlo. */
  hasMontage: boolean;
  /** El montaje está en marcha: no se puede generar otro hasta que termine. */
  montageBusy: boolean;
  /** Importa la selección al trabajo y abre Montar; lanza un error si el servidor falla. */
  onGenerate: (ids: string[]) => Promise<void>;
  /** Cambia cuando se borran clips fuera de la galería: se recarga y se limpia la selección. */
  refreshKey?: number;
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<string>(ALL);
  // La galería se pagina: montar cientos de tarjetas (y sus vídeos) de golpe la frena.
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Subida: los archivos se eligen primero y la categoría se pregunta antes de subirlos.
  const [pending, setPending] = useState<File[]>([]);
  const [pendingCategory, setPendingCategory] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);

  const [deletingSelection, setDeletingSelection] = useState(false);
  const [toolbarError, setToolbarError] = useState<string | null>(null);
  const [editingCategory, setEditingCategory] = useState(false);
  const [batchDraft, setBatchDraft] = useState("");
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  // Divisor manual: el clip elegido y el segundo por el que se parte en dos escenas.
  const [splitTarget, setSplitTarget] = useState<LibraryItem | null>(null);
  const [splitDuration, setSplitDuration] = useState<number | null>(null);
  const [splitAt, setSplitAt] = useState(0);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const splitVideo = useRef<HTMLVideoElement | null>(null);
  // Vista previa de la barra: se guarda el último punto pedido y se pide en cuanto el
  // vídeo termina de mostrar el anterior. Así la imagen sigue el arrastre en vez de
  // encolar un salto por cada evento y quedarse congelada hasta soltar.
  const splitPreview = useRef(0);
  const splitSeeking = useRef(false);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);

  // Callback estable: las tarjetas memorizadas no se re-renderizan al cambiar la selección.
  const toggleItem = useCallback((id: string) => {
    setSelected((current) => toggleSelection(current, id));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      if (!response.ok) throw new Error("sin respuesta");
      const data = (await response.json()) as { items?: LibraryItem[]; categories?: string[] };
      setItems(Array.isArray(data.items) ? data.items : []);
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setLoadError(null);
    } catch {
      setLoadError("No se pudo leer la galería. Vuelve a intentarlo.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // «Borrar videos utilizados» deja la galería sin esos clips: se recarga la lista y la
  // selección se vacía, porque los ids elegidos ya no existen.
  useEffect(() => {
    if (refreshKey === 0) return;
    setSelected([]);
    void load();
  }, [load, refreshKey]);

  // Cada filtro empieza por la primera página; si no, cambiar de categoría dejaría
  // ocultos clips que sí encajan y el operador no sabría por qué.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [filter, refreshKey]);

  // Si el filtro se queda sin categoría (porque el último clip cambió de etiqueta o se
  // borró), se vuelve a «Todas» en vez de dejar la galería en blanco sin explicación.
  useEffect(() => {
    if (filter === ALL) return;
    if (filter === NONE) {
      if (items && !items.some((item) => item.category === null)) setFilter(ALL);
      return;
    }
    if (categories.every((category) => categoryKey(category) !== categoryKey(filter))) {
      setFilter(ALL);
    }
  }, [categories, filter, items]);

  /** Comprueba formato y tamaño en el navegador y deja los buenos listos para subir. */
  const stageFiles = useCallback((files: FileList | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    // El mismo archivo se puede volver a elegir después de un fallo.
    if (uploadInput.current) uploadInput.current.value = "";

    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of list) {
      if (!extensionOf(file.name)) {
        problems.push(`«${file.name}» no es un formato válido. La galería acepta ${FORMATS}.`);
      } else if (file.size > LIBRARY_MAX_BYTES) {
        problems.push(`«${file.name}» pasa de 2 GB.`);
      } else {
        accepted.push(file);
      }
    }
    setUploadErrors(problems);
    setPending(accepted);
    setPendingCategory("");
  }, []);

  /** Sube los archivos elegidos con la categoría que se haya escrito (opcional). */
  const uploadPending = useCallback(async () => {
    if (pending.length === 0 || uploading) return;
    const problems: string[] = [];
    const category = normalizeCategory(pendingCategory);

    setUploading({ done: 0, total: pending.length });
    for (const [index, file] of pending.entries()) {
      try {
        const params = new URLSearchParams({ name: file.name });
        if (category) params.set("category", category);
        const response = await fetch(`/api/library?${params.toString()}`, {
          method: "POST",
          body: file,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          problems.push(payload?.error ?? `No se pudo subir «${file.name}».`);
        }
      } catch {
        problems.push(`No se pudo subir «${file.name}».`);
      }
      setUploading({ done: index + 1, total: pending.length });
    }

    setUploading(null);
    setUploadErrors(problems);
    setPending([]);
    setPendingCategory("");
    await load();
  }, [load, pending, pendingCategory, uploading]);

  // El basurero del toolbar borra los clips seleccionados. No toca el montaje: el
  // trabajo guarda su propia copia de cada clip que ya importó.
  const deleteSelected = useCallback(async () => {
    if (selected.length === 0 || deletingSelection) return;
    const count = selected.length;
    const confirmed = window.confirm(
      count === 1
        ? "Se eliminará 1 clip de la galería. Esta acción no se puede deshacer."
        : `Se eliminarán ${count} clips de la galería. Esta acción no se puede deshacer.`,
    );
    if (!confirmed) return;

    setDeletingSelection(true);
    setToolbarError(null);
    const targets = [...selected];
    const deleted = new Set<string>();
    let latestCategories = categories;
    const failures: string[] = [];

    for (const id of targets) {
      try {
        const response = await fetch(`/api/library/${id}`, { method: "DELETE" });
        const payload = (await response.json().catch(() => null)) as {
          categories?: string[];
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "No se pudo eliminar el clip.");
        deleted.add(id);
        latestCategories = payload?.categories ?? latestCategories;
        setItems((current) => (current ? current.filter((entry) => entry.id !== id) : current));
      } catch (failure) {
        failures.push(failure instanceof Error ? failure.message : "No se pudo eliminar el clip.");
      }
    }

    setCategories(latestCategories);
    setSelected((current) => current.filter((id) => !deleted.has(id)));
    setDeletingSelection(false);
    if (failures.length > 0) setToolbarError(failures[0]);
  }, [categories, deletingSelection, selected]);

  // El lápiz del toolbar aplica una categoría a **todos** los seleccionados.
  const saveBatchCategory = useCallback(async () => {
    if (selected.length === 0 || batchSaving) return;
    setBatchSaving(true);
    setBatchError(null);

    const targets = [...selected];
    let latestCategories = categories;
    const failures: string[] = [];
    for (const id of targets) {
      try {
        const response = await fetch(`/api/library/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: batchDraft }),
        });
        const payload = (await response.json().catch(() => null)) as {
          item?: LibraryItem;
          categories?: string[];
          error?: string;
        } | null;
        if (!response.ok || !payload?.item) {
          throw new Error(payload?.error ?? "No se pudo cambiar la categoría.");
        }
        const saved = payload.item;
        latestCategories = payload.categories ?? latestCategories;
        setItems((current) =>
          current ? current.map((entry) => (entry.id === id ? saved : entry)) : current,
        );
      } catch (failure) {
        failures.push(failure instanceof Error ? failure.message : "No se pudo cambiar la categoría.");
      }
    }

    setCategories(latestCategories);
    setBatchSaving(false);
    if (failures.length > 0) {
      setBatchError(failures[0]);
      return;
    }
    setEditingCategory(false);
    setBatchDraft("");
  }, [batchDraft, batchSaving, categories, selected]);

  // «Generar manual» (RF-12.3): con un montaje abierto se confirma antes de reemplazarlo.
  // Si el operador cancela, no se crea ni se modifica ningún trabajo y la selección sigue.
  const generate = useCallback(async () => {
    if (!canGenerate(selected) || generating || montageBusy) return;
    if (hasMontage) {
      const confirmed = window.confirm(
        "Ya hay un montaje abierto: al generar se reemplazan sus puestos y sus clips, y el ranking anterior dejará de estar disponible. ¿Quieres continuar?",
      );
      if (!confirmed) return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      await onGenerate(selected);
      setSelected([]);
    } catch (failure) {
      setGenerateError(
        failure instanceof Error
          ? failure.message
          : "No se pudo preparar el montaje con los clips elegidos.",
      );
    } finally {
      setGenerating(false);
    }
  }, [generating, hasMontage, montageBusy, onGenerate, selected]);

  // Divisor manual: el automático no siempre separa dos escenas que van en el mismo
  // archivo, así que el punto de corte lo marca el operador.
  const openSplit = useCallback((item: LibraryItem) => {
    const known = item.duration_s ?? null;
    setSplitTarget(item);
    setSplitDuration(known);
    setSplitAt(known ? Math.round((known / 2) * 1000) / 1000 : 0);
    setSplitError(null);
    splitPreview.current = 0;
    splitSeeking.current = false;
  }, []);

  const closeSplit = useCallback(() => {
    splitVideo.current?.pause();
    splitPreview.current = 0;
    splitSeeking.current = false;
    setSplitTarget(null);
    setSplitDuration(null);
    setSplitError(null);
  }, []);

  /** Lleva el vídeo al fotograma de `seconds` sin encolar saltos sobre el anterior. */
  const seekSplitPreview = useCallback((seconds: number) => {
    const video = splitVideo.current;
    if (!video) return;
    splitPreview.current = seconds;
    // Arrastrar la barra manda sobre la reproducción: si venía sonando, se pausa para que
    // la imagen no se escape del fotograma que anuncia la leyenda.
    if (!video.paused) video.pause();
    if (splitSeeking.current || video.seeking) return;
    // Si el vídeo ya está en ese fotograma no hay salto que pedir: no llegaría el
    // `seeked` que desbloquea la cadena y la barra dejaría de actualizar la imagen.
    if (Math.abs(video.currentTime - seconds) < 0.001) return;
    splitSeeking.current = true;
    video.currentTime = seconds;
  }, []);

  /** Terminado un salto: si la barra siguió moviéndose, se va al último punto pedido. */
  const handleSplitSeeked = useCallback(() => {
    splitSeeking.current = false;
    const video = splitVideo.current;
    if (!video || !video.paused) return;
    const target = splitPreview.current;
    if (Math.abs(video.currentTime - target) > 0.002) {
      splitSeeking.current = true;
      video.currentTime = target;
    }
  }, []);

  const confirmSplit = useCallback(async () => {
    if (!splitTarget || splitBusy) return;
    setSplitBusy(true);
    setSplitError(null);
    const removedId = splitTarget.id;
    try {
      const response = await fetch(`/api/library/${removedId}/split`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: splitAt }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "No se pudo dividir el clip.");
      setSelected((current) => current.filter((id) => id !== removedId));
      closeSplit();
      await load();
    } catch (failure) {
      setSplitError(failure instanceof Error ? failure.message : "No se pudo dividir el clip.");
    } finally {
      setSplitBusy(false);
    }
  }, [closeSplit, load, splitAt, splitBusy, splitTarget]);

  // El divisor trabaja con **un** clip: el único seleccionado.
  const splitCandidate =
    selected.length === 1 && items ? (items.find((item) => item.id === selected[0]) ?? null) : null;

  // `undefined` es «Todas» y `null` es «Sin categoría»: filtrar nunca toca la selección.
  const filterValue = filter === ALL ? undefined : filter === NONE ? null : filter;
  const visible = items ? filterItems(items, filterValue) : [];
  const shown = visible.slice(0, limit);
  const remaining = visible.length - shown.length;
  const hiddenSelected = items
    ? selected.filter((id) => !visible.some((item) => item.id === id)).length
    : 0;
  const hasUncategorized = items?.some((item) => item.category === null) ?? false;
  const missing = missingForGeneration(selected);
  const ready = canGenerate(selected);

  const summary =
    selected.length === 0
      ? `Ningún clip seleccionado. Elige entre ${SELECTION_MIN} y ${SELECTION_MAX}.`
      : missing > 0
        ? `${selected.length} de ${SELECTION_MAX} seleccionados. Faltan ${missing} para poder generar.`
        : selected.length === SELECTION_MAX
          ? `${SELECTION_MAX} de ${SELECTION_MAX} seleccionados: has llegado al máximo. Para cambiar, deselecciona uno.`
          : `${selected.length} de ${SELECTION_MAX} seleccionados. Listo para generar.`;

  let content: ReactNode;
  if (!active) {
    // La sección está oculta: no se montan tarjetas ni vídeos. El estado (selección,
    // filtro y lista) sigue vivo en este componente y aparece al volver.
    content = null;
  } else if (loadError) {
    content = (
      <div className="alert error" role="alert">
        <p>{loadError}</p>
        <div className="actions">
          <button className="secondary" type="button" onClick={() => void load()}>
            Reintentar
          </button>
        </div>
      </div>
    );
  } else if (items === null) {
    content = (
      <p className="hint" role="status">
        Leyendo la galería…
      </p>
    );
  } else if (items.length === 0) {
    content = <div className="empty-state">Todavía no hay clips en la galería. Sube los primeros arriba.</div>;
  } else if (visible.length === 0) {
    content = (
      <div className="empty-state">No hay clips en esta categoría. Prueba con «Todas las categorías».</div>
    );
  } else {
    content = (
      <>
        <ul className="gallery-grid" aria-label="Clips de la galería">
          {shown.map((item) => (
            <GalleryCard
              key={item.id}
              item={item}
              position={selectionPosition(selected, item.id)}
              picked={selected.includes(item.id)}
              disabled={!canSelect(selected, item.id)}
              onToggle={toggleItem}
            />
          ))}
        </ul>
        {remaining > 0 ? (
          <div className="gallery-more">
            <button
              className="secondary"
              type="button"
              onClick={() => setLimit((value) => value + PAGE_SIZE)}
            >
              Mostrar {Math.min(remaining, PAGE_SIZE)} más · quedan {remaining}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="gallery">
      <section
        className={`card ${dragActive ? "drag-over" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          stageFiles(event.dataTransfer?.files ?? null);
        }}
      >
        <h2>Subir clips a la galería</h2>
        <p className="hint">
          Se guardan tal cual, sin prepararlos: la preparación ocurre al generar el ranking.
        </p>

        <div
          className={`upload-drop ${dragActive ? "drag-over" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Subir clips a la galería"
          onClick={() => uploadInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              uploadInput.current?.click();
            }
          }}
        >
          <strong>Arrastra los clips aquí</strong>
          <span>
            o pulsa para elegirlos · {FORMATS} · hasta 2 GB por archivo
          </span>
        </div>
        <input
          ref={uploadInput}
          className="slot-file-hidden"
          type="file"
          accept="video/*"
          multiple
          aria-label="Clips que se suben a la galería"
          disabled={uploading !== null}
          onChange={(event) => stageFiles(event.target.files)}
        />

        {pending.length > 0 ? (
          <div className="upload-ask">
            <p>
              {pending.length === 1
                ? "1 clip listo para subir."
                : `${pending.length} clips listos para subir.`}{" "}
              ¿Con qué categoría?
            </p>
            <div className="upload-ask-row">
              <input
                type="text"
                list="gallery-categories"
                value={pendingCategory}
                aria-label="Categoría de los clips que se suben"
                autoComplete="off"
                disabled={uploading !== null}
                onChange={(event) => setPendingCategory(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void uploadPending();
                  }
                  if (event.key === "Escape") {
                    setPending([]);
                    setPendingCategory("");
                  }
                }}
              />
              <button
                className="primary small"
                type="button"
                disabled={uploading !== null}
                onClick={() => void uploadPending()}
              >
                Subir
              </button>
              <button
                className="secondary small"
                type="button"
                disabled={uploading !== null}
                onClick={() => {
                  setPending([]);
                  setPendingCategory("");
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : null}

        {uploading ? (
          <p className="hint upload-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Subiendo {uploading.done} de {uploading.total}…
          </p>
        ) : null}
        {uploadErrors.length > 0 ? (
          <div className="alert error" role="alert">
            <ul className="plain-list">
              {uploadErrors.map((message, index) => (
                <li key={`${message}-${index}`}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="gallery-toolbar">
          <select
            id="gallery-filter"
            aria-label="Filtrar la galería por categoría"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value={ALL}>Todas las categorías</option>
            {hasUncategorized ? <option value={NONE}>Sin categoría</option> : null}
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <div className="gallery-side">
            <div className="gallery-summary" role="status" aria-live="polite">
              <p>{summary}</p>
              {hiddenSelected > 0 ? (
                <p className="hint">
                  {hiddenSelected === 1
                    ? "1 de los seleccionados no se ve con este filtro."
                    : `${hiddenSelected} de los seleccionados no se ven con este filtro.`}
                </p>
              ) : null}
            </div>
            <div className="gallery-tools">
              <button
                className="gallery-tool"
                type="button"
                disabled={!splitCandidate || splitBusy || deletingSelection || batchSaving}
                aria-label="Dividir el clip seleccionado en dos escenas"
                title={
                  splitCandidate
                    ? "Dividir el clip seleccionado en dos escenas"
                    : "Selecciona un solo clip para dividirlo"
                }
                onClick={() => {
                  if (splitCandidate) openSplit(splitCandidate);
                }}
              >
                <GalleryToolIcon name="scissors" />
              </button>
              <button
                className="gallery-tool"
                type="button"
                disabled={selected.length === 0 || batchSaving || deletingSelection}
                aria-label="Cambiar la categoría de los clips seleccionados"
                title="Cambiar la categoría de los seleccionados"
                onClick={() => {
                  setBatchDraft("");
                  setBatchError(null);
                  setEditingCategory(true);
                }}
              >
                <GalleryToolIcon name="pen" />
              </button>
              <button
                className="gallery-tool"
                type="button"
                disabled={selected.length === 0 || deletingSelection || batchSaving}
                aria-label="Eliminar los clips seleccionados de la galería"
                title="Eliminar los seleccionados"
                onClick={() => void deleteSelected()}
              >
                <GalleryToolIcon name="trash" />
              </button>
            </div>
          </div>
        </div>

        {toolbarError ? (
          <div className="alert error" role="alert">
            {toolbarError}
          </div>
        ) : null}

        {editingCategory ? (
          <div className="gallery-batch">
            <label className="field" htmlFor="batch-category">
              Categoría para {selected.length}{" "}
              {selected.length === 1 ? "clip seleccionado" : "clips seleccionados"}
            </label>
            <div className="upload-ask-row">
              <input
                id="batch-category"
                type="text"
                list="gallery-categories"
                value={batchDraft}
                autoComplete="off"
                disabled={batchSaving}
                onChange={(event) => setBatchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveBatchCategory();
                  }
                  if (event.key === "Escape") setEditingCategory(false);
                }}
              />
              <button
                className="primary small"
                type="button"
                disabled={batchSaving}
                onClick={() => void saveBatchCategory()}
              >
                {batchSaving ? "Guardando…" : "Guardar"}
              </button>
              <button
                className="secondary small"
                type="button"
                disabled={batchSaving}
                onClick={() => setEditingCategory(false)}
              >
                Cancelar
              </button>
            </div>
            {batchError ? (
              <p className="hint error-text" role="alert">
                {batchError}
              </p>
            ) : null}
          </div>
        ) : null}

        {splitTarget ? (
          <div className="split-layer">
            <div className="split-backdrop" onClick={closeSplit} />
            <div
              className="split-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Dividir ${splitTarget.name} en dos escenas`}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSplit();
              }}
            >
              <header className="split-head">
                <h3>Dividir «{splitTarget.name}» en dos escenas</h3>
                <button
                  className="secondary small split-close"
                  type="button"
                  aria-label="Cerrar el divisor de escenas"
                  title="Cerrar"
                  onClick={closeSplit}
                >
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </header>
              <video
                ref={splitVideo}
                className="split-video"
                src={fileUrl(splitTarget.id)}
                controls
                playsInline
                preload="auto"
                aria-label={`Vídeo de ${splitTarget.name}`}
                onLoadedMetadata={(event) => {
                  const value = event.currentTarget.duration;
                  if (!Number.isFinite(value) || value <= 0) return;
                  setSplitDuration(value);
                  const target =
                    splitAt > 0 && splitAt < value ? splitAt : Math.round((value / 2) * 1000) / 1000;
                  setSplitAt(target);
                  // La imagen que se ve al abrir es la del punto marcado, no el primer
                  // fotograma: la leyenda y el vídeo cuentan lo mismo desde el principio.
                  seekSplitPreview(target);
                }}
                onSeeked={handleSplitSeeked}
                onTimeUpdate={(event) => {
                  // Mientras la barra está buscando, el fotograma va por detrás del punto
                  // pedido: devolver ese valor a la barra la hacía ir y volver.
                  if (splitSeeking.current) return;
                  const value = Math.round(event.currentTarget.currentTime * 1000) / 1000;
                  setSplitAt(value);
                  // Si el fotograma lo pidió el vídeo (reproducción o sus propios
                  // controles), ese pasa a ser el punto de la barra.
                  splitPreview.current = value;
                }}
              />
              <div className="split-timeline">
                <input
                  type="range"
                  min={0}
                  max={splitDuration ?? 0}
                  step={0.001}
                  value={splitAt}
                  aria-label="Punto de corte en la línea de tiempo"
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value) * 1000) / 1000;
                    setSplitAt(value);
                    // La barra es la línea de tiempo: moverla lleva el vídeo a ese fotograma,
                    // también a mitad del arrastre (la imagen no espera a que se suelte).
                    seekSplitPreview(value);
                  }}
                />
                <div className="split-legend">
                  <span>
                    Escena 1 · {formatTimecode(0)}–{formatTimecode(splitAt)}
                  </span>
                  <strong>{formatTimecode(splitAt)}</strong>
                  <span>
                    Escena 2 · {formatTimecode(splitAt)}–{" "}
                    {splitDuration === null ? "—" : formatTimecode(splitDuration)}
                  </span>
                </div>
              </div>
              <div className="actions split-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={splitBusy || splitDuration === null}
                  onClick={() => void confirmSplit()}
                >
                  {splitBusy ? "Dividiendo…" : "Dividir en dos"}
                </button>
              </div>
              {splitError ? (
                <div className="alert error" role="alert">
                  {splitError}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Autocompletado de categorías: las existentes, sin pantalla de administración. */}
        <datalist id="gallery-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>

        {content}

        {/* Barra inferior pegada al viewport: los botones de generar no se pierden al
            recorrer una galería larga. */}
        <div className="gallery-footer">
          <div className="actions gallery-actions">
            <button
              className="primary"
              type="button"
              disabled={!ready || generating || montageBusy}
              onClick={() => void generate()}
            >
              {generating ? "Preparando los clips…" : "Generar manual"}
            </button>
            {/* RF-15 / P2-7: visible y deshabilitado; sin endpoint ni efectos. */}
            <button
              className="secondary"
              type="button"
              disabled
              aria-disabled="true"
              aria-label="Generar automático, próximamente"
              title="La generación automática estará disponible próximamente."
            >
              Generar automático · Próximamente
            </button>
          </div>
          {montageBusy ? (
            <p className="hint">El montaje está en marcha: cuando termine podrás generar otro ranking.</p>
          ) : null}
          {generateError ? (
            <div className="alert error" role="alert">
              {generateError}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Iconos de la barra de la galería (trazos de Lucide, sin dependencia extra). */
function GalleryToolIcon({ name }: { name: "pen" | "trash" | "scissors" }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "pen" ? (
        <>
          <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z" />
        </>
      ) : name === "scissors" ? (
        <>
          <circle cx="6" cy="6" r="3" />
          <path d="M8.12 8.12 12 12" />
          <path d="M20 4 8.12 15.88" />
          <circle cx="6" cy="18" r="3" />
          <path d="M14.8 14.8 20 20" />
        </>
      ) : (
        <>
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </>
      )}
    </svg>
  );
}

/**
 * Tarjeta de un clip: miniatura reproducible igual que en el montaje, nombre original,
 * duración y categoría de solo lectura (se cambia con el lápiz de la barra). Se elige
 * pulsando cualquier parte que no sea el vídeo, y el puesto se ve en la esquina.
 */
const GalleryCard = memo(function GalleryCard({
  item,
  position,
  picked,
  disabled,
  onToggle,
}: {
  item: LibraryItem;
  position: number | null;
  picked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  // La duración sale del propio vídeo al leer sus metadatos: no hace falta sondear
  // 159 archivos en el servidor para pintar la galería.
  const [duration, setDuration] = useState<number | null>(null);

  return (
    <li
      className={`gallery-card ${picked ? "picked" : ""}`}
      onClick={(event) => {
        if (disabled) return;
        // La miniatura se queda para reproducir el vídeo: el resto de la tarjeta elige.
        const target = event.target as HTMLElement;
        if (target.closest("video, input, button, a, label")) return;
        onToggle(item.id);
      }}
    >
      <div className="gallery-thumb">
        <video
          src={fileUrl(item.id)}
          controls
          playsInline
          preload="metadata"
          aria-label={`Vista previa de ${item.name}`}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = 0.1;
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) setDuration(value);
          }}
        />
        {position !== null ? <span className="gallery-position">#{position}</span> : null}
      </div>

      <h3 className="gallery-name">
        <button
          className="gallery-name-button"
          type="button"
          aria-pressed={picked}
          aria-label={
            picked ? `Quitar ${item.name} del ranking` : `Elegir ${item.name} para el ranking`
          }
          disabled={disabled}
          onClick={() => onToggle(item.id)}
        >
          {item.name}
        </button>
      </h3>
      <p className="gallery-meta">
        {item.duration_s != null
          ? `Duración: ${formatDuration(item.duration_s)}`
          : duration === null
            ? "Duración: —"
            : `Duración: ${formatDuration(duration)}`}
      </p>
      {item.source ? (
        <p className="gallery-meta">Fuente: {item.source.platform ?? "archivo local"}</p>
      ) : null}
      {item.duplicateOf ? (
        <p className="gallery-meta gallery-duplicate">Posible duplicado de otro clip</p>
      ) : null}

      <p className={`gallery-category ${item.category ? "" : "empty"}`}>
        <span className="gallery-category-label">Categoría:</span>{" "}
        {item.category ?? "Sin categoría"}
      </p>
    </li>
  );
});

export default memo(Gallery);
