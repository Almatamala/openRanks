"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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

/** Origen reproducible de un original de la galería. */
function fileUrl(id: string): string {
  return `/api/library/${id}/file`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Galería de la Fase 2 (RF-11 y RF-12): sube originales, los etiqueta y deja elegir
 * entre 5 y 10 en el orden del ranking. La selección vive en la sesión —no se guarda—
 * y sobrevive a cambiar de sección; el orden de selección fija el puesto (#1 el primero).
 */
export default function Gallery({
  hasMontage,
  montageBusy,
  onGenerate,
  refreshKey = 0,
}: {
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

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);

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

  // `undefined` es «Todas» y `null` es «Sin categoría»: filtrar nunca toca la selección.
  const filterValue = filter === ALL ? undefined : filter === NONE ? null : filter;
  const visible = items ? filterItems(items, filterValue) : [];
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
  if (loadError) {
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
      <ul className="gallery-grid" aria-label="Clips de la galería">
        {visible.map((item) => (
          <GalleryCard
            key={item.id}
            item={item}
            position={selectionPosition(selected, item.id)}
            picked={selected.includes(item.id)}
            disabled={!canSelect(selected, item.id)}
            onToggle={() => setSelected((current) => toggleSelection(current, item.id))}
          />
        ))}
      </ul>
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
                placeholder="Sin categoría"
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
          <div>
            <label className="field" htmlFor="gallery-filter">
              Ver
            </label>
            <select id="gallery-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value={ALL}>Todas las categorías</option>
              {hasUncategorized ? <option value={NONE}>Sin categoría</option> : null}
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="gallery-side">
            <div className="gallery-tools">
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
                placeholder="Sin categoría"
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

        {/* Autocompletado de categorías: las existentes, sin pantalla de administración. */}
        <datalist id="gallery-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>

        {content}

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
      </section>
    </div>
  );
}

/** Iconos de la barra de la galería (trazos de Lucide, sin dependencia extra). */
function GalleryToolIcon({ name }: { name: "pen" | "trash" }) {
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
 * tamaño y categoría de solo lectura (se cambia con el lápiz de la barra). Se elige
 * pulsando cualquier parte que no sea el vídeo, y el puesto se ve en la esquina.
 */
function GalleryCard({
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
  onToggle: () => void;
}) {
  return (
    <li
      className={`gallery-card ${picked ? "picked" : ""}`}
      onClick={(event) => {
        if (disabled) return;
        // La miniatura se queda para reproducir el vídeo: el resto de la tarjeta elige.
        const target = event.target as HTMLElement;
        if (target.closest("video, input, button, a, label")) return;
        onToggle();
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
          onClick={onToggle}
        >
          {item.name}
        </button>
      </h3>
      <p className="gallery-meta">{humanSize(item.bytes)}</p>

      <p className={`gallery-category ${item.category ? "" : "empty"}`}>
        <span className="gallery-category-label">Categoría:</span>{" "}
        {item.category ?? "Sin categoría"}
      </p>
    </li>
  );
}
