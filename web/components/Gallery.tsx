"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  DEFAULT_SCORE_MIN,
  needsScore,
  titleFromName,
  type ScoreMode,
  type ScoreReport,
} from "@/lib/gallery-score";
import { formatDuration } from "@/lib/progress";
import CategoryPicker from "@/components/CategoryPicker";
import {
  autoReadiness,
  suggestAutoSelection,
  type AutoProposal,
} from "@/lib/auto-select";
import {
  canGenerate,
  canSelect,
  categoryKey,
  displayName,
  extensionOf,
  filterItems,
  LIBRARY_EXTENSIONS,
  LIBRARY_MAX_BYTES,
  MERGE_MAX,
  MERGE_MIN,
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

/** Clips con miniatura en la ventana de «Puntuar galería»: se pagina igual que la galería. */
const SCORE_PICK_PAGE = 24;

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
  // Fusión: los clips elegidos, en el orden del vídeo resultante, y la vista previa ya
  // montada que enseña cómo queda el clip unido.
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  // Duración medida en el navegador para los clips que no la traen del índice: así el
  // diálogo enseña su tiempo y su parte del ancho sin esperar a que el motor los mida.
  const [measuredDurations, setMeasuredDurations] = useState<Record<string, number>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Arrastrar una fila para reordenar: qué fila se arrastra y sobre cuál va a caer.
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const mergeVideo = useRef<HTMLVideoElement | null>(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [autoProposal, setAutoProposal] = useState<AutoProposal | null>(null);
  // P3-9: puntuación de toda la galería antes del automático. El informe enseña score y
  // título de edición; eliminar los que no pasan es un segundo paso confirmado.
  const [scoring, setScoring] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [scoreReport, setScoreReport] = useState<ScoreReport | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  // Antes de puntuar se elige qué se evalúa —los no puntuados o todos— y se ven los
  // clips de la pasada. El informe llega después, como siempre.
  const [scorePrompt, setScorePrompt] = useState<ScoreMode | null>(null);
  const [scorePickLimit, setScorePickLimit] = useState(SCORE_PICK_PAGE);
  const uploadInput = useRef<HTMLInputElement | null>(null);

  // Callback estable: las tarjetas memorizadas no se re-renderizan al cambiar la selección.
  const toggleItem = useCallback((id: string) => {
    setSelected((current) => toggleSelection(current, id));
  }, []);

  // El tope se aplica también al **estado** y no solo al clic: con más de diez la selección
  // no vale para un ranking, así que «Generar manual» se deshabilitaba sin decir por qué.
  useEffect(() => {
    setSelected((current) =>
      current.length > SELECTION_MAX ? current.slice(0, SELECTION_MAX) : current,
    );
  }, [selected]);

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
  const runGenerate = useCallback(async (ids: string[]) => {
    if (!canGenerate(ids) || generating || montageBusy) return;
    if (hasMontage) {
      const confirmed = window.confirm(
        "Ya hay un montaje abierto: al generar se reemplazan sus puestos y sus clips, y el ranking anterior dejará de estar disponible. ¿Quieres continuar?",
      );
      if (!confirmed) return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      setSelected(ids);
      await onGenerate(ids);
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
  }, [generating, hasMontage, montageBusy, onGenerate]);

  const generate = useCallback(() => {
    void runGenerate(selected);
  }, [runGenerate, selected]);

  // «Generar automático» (P3-7): propone una selección por score y diversidad y, al
  // aceptar, la importa con el mismo camino que «Generar manual» (casillas y ticks).
  const openAuto = useCallback(() => {
    if (!items) return;
    const result = suggestAutoSelection(items);
    if (!result.ok) {
      setGenerateError(result.reason);
      return;
    }
    setGenerateError(null);
    setAutoProposal(result.proposal);
  }, [items]);

  const acceptAuto = useCallback(() => {
    if (!autoProposal) return;
    const ids = autoProposal.clips.map((clip) => clip.id);
    setAutoProposal(null);
    setGenerateError(null);
    void runGenerate(ids);
  }, [autoProposal, runGenerate]);

  // «Puntuar galería» (P3-9) abre la ventana con los clips de la pasada: solo los no
  // puntuados por defecto o todos, para comparar claves y modelos.
  const openScoring = useCallback(() => {
    if (!items || items.length === 0) return;
    const pending = items.filter(needsScore).length;
    setScorePickLimit(SCORE_PICK_PAGE);
    setScoreError(null);
    setGenerateError(null);
    setScorePrompt(pending === 0 ? "all" : "pending");
  }, [items]);

  // Puntúa con el modo elegido y devuelve el informe con el umbral. No borra nada: eso
  // es el botón del propio informe.
  const runScoring = useCallback(async (mode: ScoreMode) => {
    if (scoring || dropping || !items || items.length === 0) return;
    setScoring(true);
    setScoreError(null);
    setGenerateError(null);
    try {
      const response = await fetch("/api/library/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "score", mode }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (ScoreReport & { error?: string })
        | null;
      if (!response.ok || !payload || !Array.isArray(payload.clips)) {
        throw new Error(payload?.error ?? "No se pudo puntuar la galería.");
      }
      setScoreReport(payload);
      setScorePrompt(null);
      await load();
    } catch (failure) {
      setScoreError(
        failure instanceof Error ? failure.message : "No se pudo puntuar la galería.",
      );
    } finally {
      setScoring(false);
    }
  }, [dropping, items, load, scoring]);

  // Borrado confirmado de los clips que no llegan al umbral: se van de la galería y de la
  // selección, y el automático se queda solo con los que pasan.
  const dropFailed = useCallback(async () => {
    if (!scoreReport || dropping) return;
    const failures = scoreReport.clips.filter((clip) => !clip.pass);
    if (failures.length === 0) return;
    const confirmed = window.confirm(
      failures.length === 1
        ? `Se eliminará 1 clip de la galería porque no llega al umbral de ${scoreReport.threshold}. Esta acción no se puede deshacer.`
        : `Se eliminarán ${failures.length} clips de la galería porque no llegan al umbral de ${scoreReport.threshold}. Esta acción no se puede deshacer.`,
    );
    if (!confirmed) return;

    setDropping(true);
    setScoreError(null);
    try {
      const response = await fetch("/api/library/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "drop",
          threshold: scoreReport.threshold,
          confirm: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        removed?: { id: string }[];
        error?: string;
      } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "No se pudieron eliminar los clips.");
      }
      const removed = new Set((payload?.removed ?? []).map((clip) => clip.id));
      setSelected((current) => current.filter((id) => !removed.has(id)));
      setScoreReport(null);
      await load();
    } catch (failure) {
      setScoreError(
        failure instanceof Error ? failure.message : "No se pudieron eliminar los clips.",
      );
    } finally {
      setDropping(false);
    }
  }, [dropping, load, scoreReport]);

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

  // Fusión de 2 a 4 clips: abre el diálogo con el orden de selección. El orden se cambia
  // dentro, así que seleccionar no obliga a acertar a la primera.
  const openMerge = useCallback(() => {
    if (selected.length < MERGE_MIN || selected.length > MERGE_MAX) return;
    setMergeError(null);
    setPreviewUrl(null);
    setPreviewError(null);
    setDraggingIndex(null);
    setDragOverIndex(null);
    setMergeIds([...selected]);
  }, [selected]);

  const closeMerge = useCallback(() => {
    mergeVideo.current?.pause();
    setMergeIds(null);
    setMergeError(null);
    setPreviewUrl(null);
    setPreviewError(null);
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  /** Mueve un clip en la cronología: la vista previa se vuelve a montar con ese orden. */
  const moveMerge = useCallback((from: number, to: number) => {
    setMergeIds((current) => {
      if (!current || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // La vista previa es el clip **ya unido** (el motor lo monta reducido y rápido), no la
  // lista de clips: así se ve el resultado real antes de confirmar. Se espera un poco para
  // no lanzar un montaje por cada flecha que se pulsa.
  useEffect(() => {
    if (!mergeIds || mergeIds.length < MERGE_MIN) return;
    let cancelled = false;
    setPreviewBusy(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/library/merge/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: mergeIds }),
          });
          const payload = (await response.json().catch(() => null)) as {
            url?: string;
            error?: string;
          } | null;
          if (!response.ok || !payload?.url) {
            throw new Error(payload?.error ?? "No se pudo preparar la vista previa.");
          }
          if (!cancelled) setPreviewUrl(payload.url);
        } catch (failure) {
          if (!cancelled) {
            setPreviewError(
              failure instanceof Error ? failure.message : "No se pudo preparar la vista previa.",
            );
          }
        } finally {
          if (!cancelled) setPreviewBusy(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mergeIds]);

  const confirmMerge = useCallback(async () => {
    if (!mergeIds || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const response = await fetch("/api/library/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: mergeIds }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "No se pudieron fusionar los clips.");
      mergeVideo.current?.pause();
      setMergeIds(null);
      setPreviewUrl(null);
      setSelected([]);
      await load();
    } catch (failure) {
      setMergeError(
        failure instanceof Error ? failure.message : "No se pudieron fusionar los clips.",
      );
    } finally {
      setMergeBusy(false);
    }
  }, [load, mergeBusy, mergeIds]);

  // El divisor trabaja con **un** clip: el único seleccionado.
  const splitCandidate =
    selected.length === 1 && items ? (items.find((item) => item.id === selected[0]) ?? null) : null;

  // La cronología del diálogo de fusión, en el orden que se haya dejado.
  const mergeItems: LibraryItem[] =
    mergeIds && items
      ? mergeIds
          .map((id) => items.find((item) => item.id === id))
          .filter((item): item is LibraryItem => item !== undefined)
      : [];
  const mergeSeconds = (item: LibraryItem) =>
    Math.max(item.duration_s ?? measuredDurations[item.id] ?? 0, 0);
  // El ancho de cada tramo es su parte del tiempo final. Muchos clips de la galería no
  // traen la duración medida: si pesaran 0,1 s el botón quedaría en una astilla y la fila
  // dejaría de repartir todo el ancho. Entran con la media de los que sí la tienen.
  const mergeKnown = mergeItems.map(mergeSeconds).filter((seconds) => seconds > 0);
  const mergeFallback =
    mergeKnown.length > 0
      ? mergeKnown.reduce((sum, seconds) => sum + seconds, 0) / mergeKnown.length
      : 1;
  const mergeWeights = mergeItems.map((item) => {
    const seconds = mergeSeconds(item);
    return seconds > 0 ? seconds : mergeFallback;
  });
  const mergeWeightTotal = mergeWeights.reduce((sum, weight) => sum + weight, 0);

  /** Lleva la vista previa al principio del clip `index` de la cronología. */
  const seekMerge = (index: number) => {
    const video = mergeVideo.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const before = mergeWeights.slice(0, index).reduce((sum, weight) => sum + weight, 0);
    const offset =
      mergeWeightTotal > 0
        ? (before / mergeWeightTotal) * video.duration
        : (index / Math.max(1, mergeItems.length)) * video.duration;
    video.currentTime = Math.min(Math.max(0, offset), Math.max(0, video.duration - 0.05));
    void video.play().catch(() => {});
  };

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
  const autoState = autoReadiness(items);

  // Datos de la ventana «Puntuar galería»: cuántos entran en cada modo y la página de
  // miniaturas que se ve. Un clip ya puntuado entra con «Todos» y se respeta con «Solo
  // los no puntuados».
  const pendingCount = items ? items.filter(needsScore).length : 0;
  const scoredCount = items ? items.length - pendingCount : 0;
  const scorePickShown = items ? items.slice(0, scorePickLimit) : [];
  const scorePickRemaining = items ? Math.max(0, items.length - scorePickShown.length) : 0;

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
              <CategoryPicker
                value={pendingCategory}
                categories={categories}
                onChange={setPendingCategory}
                ariaLabel="Categoría de los clips que se suben"
                disabled={uploading !== null}
                removeLabel="Sin categoría"
                onSubmit={() => void uploadPending()}
                onCancel={() => {
                  setPending([]);
                  setPendingCategory("");
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
                disabled={
                  selected.length < MERGE_MIN ||
                  selected.length > MERGE_MAX ||
                  splitBusy ||
                  deletingSelection ||
                  batchSaving ||
                  generating
                }
                aria-label="Fusionar los clips seleccionados en uno solo"
                title={
                  selected.length >= MERGE_MIN && selected.length <= MERGE_MAX
                    ? "Fusionar los seleccionados en un solo clip"
                    : `Elige entre ${MERGE_MIN} y ${MERGE_MAX} clips para fusionarlos`
                }
                onClick={openMerge}
              >
                <GalleryToolIcon name="merge" />
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
              <button
                className="gallery-tool"
                type="button"
                disabled={selected.length === 0}
                aria-label="Deseleccionar todos los clips"
                title="Deseleccionar todos"
                onClick={() => {
                  setSelected([]);
                  setEditingCategory(false);
                }}
              >
                <GalleryToolIcon name="x" />
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
              <CategoryPicker
                id="batch-category"
                value={batchDraft}
                categories={categories}
                onChange={setBatchDraft}
                ariaLabel="Categoría para los clips seleccionados"
                disabled={batchSaving}
                removeLabel="Sin categoría"
                onSubmit={() => void saveBatchCategory()}
                onCancel={() => setEditingCategory(false)}
              />
              <button
                className="gallery-tool primary"
                type="button"
                disabled={batchSaving}
                aria-label={batchSaving ? "Guardando la categoría" : "Guardar la categoría"}
                title={batchSaving ? "Guardando…" : "Guardar"}
                onClick={() => void saveBatchCategory()}
              >
                {batchSaving ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <GalleryToolIcon name="save" />
                )}
              </button>
              <button
                className="gallery-tool"
                type="button"
                disabled={batchSaving}
                aria-label="Cancelar el cambio de categoría"
                title="Cancelar"
                onClick={() => setEditingCategory(false)}
              >
                <GalleryToolIcon name="x" />
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
              aria-label={`Dividir ${displayName(splitTarget.name)} en dos escenas`}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSplit();
              }}
            >
              <header className="split-head">
                <h3>Dividir «{displayName(splitTarget.name)}» en dos escenas</h3>
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
                aria-label={`Vídeo de ${displayName(splitTarget.name)}`}
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

        {mergeIds ? (
          <div className="split-layer">
            <div className="split-backdrop" onClick={closeMerge} />
            <div
              className="split-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Fusionar ${mergeItems.length} clips en uno solo`}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeMerge();
              }}
            >
              <header className="split-head">
                <h3>Fusionar {mergeItems.length} clips en uno solo</h3>
                <button
                  className="secondary small split-close"
                  type="button"
                  aria-label="Cerrar la fusión"
                  title="Cerrar"
                  onClick={closeMerge}
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
              {previewBusy || !previewUrl ? (
                <div className="merge-preview-status hint" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  Montando la vista previa del clip unido…
                </div>
              ) : (
                <video
                  key={previewUrl}
                  ref={mergeVideo}
                  className="split-video"
                  src={previewUrl}
                  controls
                  playsInline
                  preload="auto"
                  aria-label="Vista previa del clip fusionado"
                />
              )}
              {previewError ? (
                <p className="hint error-text" role="alert">
                  {previewError}
                </p>
              ) : null}
              {/* Cada botón es el tramo **y** su puesto: ocupa el espacio que su clip ocupa en
                  el clip unido, enseña número, nombre y tiempo, se agarra y se suelta en
                  otro puesto, y al pulsarlo lleva la vista previa a ese punto. */}
              {/* Un clip sin duración en el índice se mide aquí una vez, con los metadatos
                  de su propio archivo; al llegar el dato desaparece el vídeo oculto. */}
              {mergeItems.map((item) =>
                item.duration_s == null && measuredDurations[item.id] === undefined ? (
                  <video
                    key={`medir-${item.id}`}
                    src={fileUrl(item.id)}
                    preload="metadata"
                    style={{ display: "none" }}
                    aria-hidden="true"
                    onLoadedMetadata={(event) => {
                      const media = event.currentTarget;
                      const seconds = Math.round(media.duration * 1000) / 1000;
                      if (!Number.isFinite(seconds) || seconds <= 0) return;
                      setMeasuredDurations((current) =>
                        current[item.id] === undefined
                          ? { ...current, [item.id]: seconds }
                          : current,
                      );
                    }}
                  />
                ) : null,
              )}
              <ol className="merge-order" aria-label="Orden de la fusión">
                {mergeItems.map((item, index) => (
                  <li
                    key={item.id}
                    className={`${draggingIndex === index ? "dragging" : ""}${
                      dragOverIndex === index && draggingIndex !== index ? " drop-target" : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    draggable
                    style={{ flexGrow: mergeWeights[index] ?? 1, flexBasis: 0 }}
                    aria-label={`Clip ${index + 1} de ${mergeItems.length}: ${displayName(item.name)}. Pulsa para ir a él o arrástralo para cambiar el orden.`}
                    onClick={() => seekMerge(index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        seekMerge(index);
                      }
                    }}
                    onDragStart={(event) => {
                      setDraggingIndex(index);
                      event.dataTransfer.effectAllowed = "move";
                      // Algunos navegadores no arrastran sin datos en el portapapeles.
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragEnd={() => {
                      setDraggingIndex(null);
                      setDragOverIndex(null);
                    }}
                    onDragOver={(event) => {
                      if (draggingIndex === null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOverIndex(index);
                    }}
                    onDragLeave={() => {
                      setDragOverIndex((current) => (current === index ? null : current));
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggingIndex !== null && draggingIndex !== index) {
                        moveMerge(draggingIndex, index);
                      }
                      setDraggingIndex(null);
                      setDragOverIndex(null);
                    }}
                  >
                    <span className="merge-order-position">#{index + 1}</span>
                    <span className="merge-order-info">
                      <span className="merge-order-name">{displayName(item.name)}</span>
                      <span className="merge-order-duration">
                        {mergeSeconds(item) > 0 ? formatDuration(mergeSeconds(item)) : "—"}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="actions split-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={mergeBusy || mergeItems.length < MERGE_MIN}
                  onClick={() => void confirmMerge()}
                >
                  {mergeBusy
                    ? "Fusionando…"
                    : `Fusionar ${mergeItems.length} clips en uno`}
                </button>
              </div>
              {mergeError ? (
                <div className="alert error" role="alert">
                  {mergeError}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {autoProposal ? (
          <div className="split-layer">
            <div className="split-backdrop" onClick={() => setAutoProposal(null)} />
            <div
              className="split-dialog auto-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Propuesta de selección automática"
              onKeyDown={(event) => {
                if (event.key === "Escape") setAutoProposal(null);
              }}
            >
              <header className="split-head">
                <h3>Propuesta automática · {autoProposal.clips.length} clips</h3>
                <button
                  className="secondary small split-close"
                  type="button"
                  aria-label="Cerrar la propuesta automática"
                  title="Cerrar"
                  onClick={() => setAutoProposal(null)}
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
              <p className="hint">
                Elegidos por score, con un máximo de dos clips por categoría y hasta 58 s.
                El #1 es el de mayor score y cierra el vídeo; la reproducción va del último
                al #1.
              </p>
              <ol className="auto-list" aria-label="Clips propuestos, del #1 al último">
                {autoProposal.clips.map((clip, index) => (
                  <li key={clip.id} className="auto-item">
                    <span className="auto-position">#{index + 1}</span>
                    <span className="auto-info">
                      <span className="auto-name">{clip.label}</span>
                      <span className="auto-meta">
                        {displayName(clip.name)} · Score {clip.score}/100 · {clip.score_source ?? "llm"}{" "}
                        · {formatDuration(clip.duration_s)} · {clip.category ?? "Sin categoría"}
                      </span>
                    </span>
                    <span className="auto-role">
                      {index === 0
                        ? "Cierra el vídeo"
                        : index === autoProposal.clips.length - 1
                          ? "Abre el vídeo"
                          : ""}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="auto-total">
                Total: {formatDuration(autoProposal.total_s)} · {autoProposal.clips.length}{" "}
                clips
              </p>
              {autoProposal.ignored > 0 ? (
                <p className="hint">
                  {autoProposal.ignored === 1
                    ? "1 clip sin score, sin duración o duplicado no entró en el cálculo."
                    : `${autoProposal.ignored} clips sin score, sin duración o duplicados no entraron en el cálculo.`}
                </p>
              ) : null}
              {autoProposal.warnings.map((warning) => (
                <p key={warning} className="hint error-text" role="alert">
                  {warning}
                </p>
              ))}
              <div className="actions split-actions">
                <button className="primary" type="button" onClick={acceptAuto}>
                  Generar con esta selección
                </button>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setAutoProposal(null)}
                >
                  Descartar
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {scorePrompt ? (
          <div className="split-layer">
            <div className="split-backdrop" onClick={() => setScorePrompt(null)} />
            <div
              className="split-dialog auto-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Elegir qué clips se puntúan"
              onKeyDown={(event) => {
                if (event.key === "Escape") setScorePrompt(null);
              }}
            >
              <header className="split-head">
                <h3>Puntuar la galería</h3>
                <button
                  className="secondary small split-close"
                  type="button"
                  aria-label="Cerrar la elección de clips"
                  title="Cerrar"
                  onClick={() => setScorePrompt(null)}
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
              <p className="hint">
                {items?.length ?? 0} clips en la galería · {pendingCount} sin puntuar ·{" "}
                {scoredCount} ya puntuados. Elige qué se evalúa; el informe dirá en qué
                queda cada uno.
              </p>
              <div className="settings-provider" role="radiogroup" aria-label="Qué clips se puntúan">
                <label className="settings-option">
                  <input
                    type="radio"
                    name="score-mode"
                    value="pending"
                    checked={scorePrompt === "pending"}
                    disabled={pendingCount === 0}
                    onChange={() => setScorePrompt("pending")}
                  />
                  <span>Solo los no puntuados</span>
                  <span className="settings-option-note">
                    {pendingCount === 0
                      ? "no queda ninguno sin puntuar"
                      : `${pendingCount} ${pendingCount === 1 ? "clip" : "clips"}`}
                  </span>
                </label>
                <label className="settings-option">
                  <input
                    type="radio"
                    name="score-mode"
                    value="all"
                    checked={scorePrompt === "all"}
                    onChange={() => setScorePrompt("all")}
                  />
                  <span>Todos los clips</span>
                  <span className="settings-option-note">
                    {items?.length ?? 0} clips · vuelve a puntuar los {scoredCount} que ya
                    lo estaban
                  </span>
                </label>
              </div>
              <ul className="score-pick-list" aria-label="Clips de la pasada">
                {scorePickShown.map((item) => {
                  const included = scorePrompt === "all" || needsScore(item);
                  return (
                    <li key={item.id} className={`score-pick${included ? "" : " skipped"}`}>
                      <video
                        className="score-pick-video"
                        src={fileUrl(item.id)}
                        muted
                        playsInline
                        preload="metadata"
                        aria-label={`Vista previa de ${displayName(item.name)}`}
                        onLoadedMetadata={(event) => {
                          event.currentTarget.currentTime = 0.1;
                        }}
                      />
                      <span className="auto-info">
                        <span className="auto-name">{displayName(item.name)}</span>
                        <span className="auto-meta">
                          {item.score != null ? `Score ${item.score}` : "Sin puntuar"}
                          {item.label ? ` · ${item.label}` : ""}
                        </span>
                      </span>
                      <span className="auto-role">{included ? "Se puntúa" : "Se respeta"}</span>
                    </li>
                  );
                })}
              </ul>
              {scorePickRemaining > 0 ? (
                <div className="gallery-more">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setScorePickLimit((value) => value + SCORE_PICK_PAGE)}
                  >
                    Mostrar {Math.min(scorePickRemaining, SCORE_PICK_PAGE)} más · quedan{" "}
                    {scorePickRemaining}
                  </button>
                </div>
              ) : null}
              <div className="actions split-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={
                    scoring || (scorePrompt === "pending" && pendingCount === 0)
                  }
                  onClick={() => void runScoring(scorePrompt)}
                >
                  {scoring
                    ? "Puntuando…"
                    : `Puntuar ${scorePrompt === "pending" ? pendingCount : items?.length ?? 0} clips`}
                </button>
                <button
                  className="secondary"
                  type="button"
                  disabled={scoring}
                  onClick={() => setScorePrompt(null)}
                >
                  Cancelar
                </button>
              </div>
              {scoreError ? (
                <div className="alert error" role="alert">
                  {scoreError}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {scoreReport ? (
          <div className="split-layer">
            <div className="split-backdrop" onClick={() => setScoreReport(null)} />
            <div
              className="split-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Resultado de puntuar la galería"
              onKeyDown={(event) => {
                if (event.key === "Escape") setScoreReport(null);
              }}
            >
              <header className="split-head">
                <h3>Galería puntuada · umbral {scoreReport.threshold}</h3>
                <button
                  className="secondary small split-close"
                  type="button"
                  aria-label="Cerrar el informe de puntuación"
                  title="Cerrar"
                  onClick={() => setScoreReport(null)}
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
              <p className="hint">
                {scoreReport.clips.length} clips con score: se quedan{" "}
                {scoreReport.clips.filter((clip) => clip.pass).length} y no pasan el umbral{" "}
                {scoreReport.clips.filter((clip) => !clip.pass).length}. En esta pasada se
                puntuaron {scoreReport.scored}
                {scoreReport.alreadyScored > 0
                  ? ` y se respetaron ${scoreReport.alreadyScored}`
                  : ""}
                . El título de cada uno es el que llevará su puesto en la edición.
              </p>
              {scoreReport.failed.length > 0 ? (
                <div className="alert error" role="alert">
                  <p>No se pudieron puntuar {scoreReport.failed.length} clips:</p>
                  <ul className="plain-list">
                    {scoreReport.failed.map((failure) => (
                      <li key={failure.name}>
                        {displayName(failure.name)}: {failure.error}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <ol className="auto-list" aria-label="Clips puntuados, de mayor a menor score">
                {scoreReport.clips.map((clip) => (
                  <li key={clip.id} className="auto-item">
                    <span className="auto-position">{clip.score}</span>
                    <span className="auto-info">
                      <span className="auto-name">{clip.label}</span>
                      <span className="auto-meta">
                        {displayName(clip.name)} · {clip.source ?? "llm"}
                      </span>
                    </span>
                    <span className={`auto-role${clip.pass ? "" : " error-text"}`}>
                      {clip.pass ? "Se queda" : "No pasa"}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="actions split-actions">
                {scoreReport.clips.some((clip) => !clip.pass) ? (
                  <button
                    className="primary"
                    type="button"
                    disabled={dropping}
                    onClick={() => void dropFailed()}
                  >
                    {dropping
                      ? "Eliminando…"
                      : `Eliminar ${scoreReport.clips.filter((clip) => !clip.pass).length} que no pasan`}
                  </button>
                ) : null}
                <button
                  className="secondary"
                  type="button"
                  onClick={() => setScoreReport(null)}
                >
                  Cerrar
                </button>
              </div>
              {scoreError ? (
                <div className="alert error" role="alert">
                  {scoreError}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

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
            {/* RF-21 / P3-9: puntúa toda la galería antes del automático. */}
            <button
              className="secondary"
              type="button"
              disabled={
                !items ||
                items.length === 0 ||
                scoring ||
                dropping ||
                generating ||
                montageBusy
              }
              title={`Puntúa la galería y devuelve el score y el título de cada clip; por debajo de ${DEFAULT_SCORE_MIN} se pueden eliminar`}
              onClick={openScoring}
            >
              {scoring ? "Puntuando la galería…" : "Puntuar galería"}
            </button>
            {/* RF-19 / P3-7: propone 5-10 por score y diversidad; aceptar genera. */}
            <button
              className="secondary"
              type="button"
              disabled={!autoState.ready || generating || montageBusy}
              aria-disabled={!autoState.ready || generating || montageBusy}
              aria-label="Generar automático por score y diversidad"
              title={
                !autoState.ready
                  ? autoState.reason
                  : montageBusy
                    ? "El montaje está en marcha; espera a que termine."
                    : "Propone de 5 a 10 clips por score y diversidad"
              }
              onClick={openAuto}
            >
              Generar automático
            </button>
          </div>
          {montageBusy ? (
            <p className="hint">El montaje está en marcha: cuando termine podrás generar otro ranking.</p>
          ) : null}
          {autoState.reason && items !== null ? (
            <p className="hint">{autoState.reason}</p>
          ) : null}
          {scoreError ? (
            <div className="alert error" role="alert">
              {scoreError}
            </div>
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
function GalleryToolIcon({
  name,
}: {
  name: "pen" | "trash" | "scissors" | "merge" | "save" | "x";
}) {
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
      ) : name === "merge" ? (
        // Merge arrow: dos trazos entran desde la izquierda y salen como una sola flecha,
        // «estos dos pasan a ser uno».
        <>
          <path d="M3 4l8 8-8 8" />
          <path d="M11 12h8" />
          <path d="m15 8 4 4-4 4" />
        </>
      ) : name === "save" ? (
        // Disquete de guardar: la caja, la lengüeta de abajo y la pestaña de la etiqueta.
        <>
          <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v5h8" />
        </>
      ) : name === "x" ? (
        // El trazo llega casi a las esquinas del lienzo, como las tijeras y el lápiz: una
        // X inscrita en el centro (6→18) se veía más pequeña que el resto de iconos.
        <>
          <path d="M4 4l16 16" />
          <path d="M20 4 4 20" />
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
 * El título de edición solo se pinta si dice algo distinto del nombre del archivo: cuando
 * el sistema lo deriva del nombre, repetirlo en la tarjeta no aporta nada.
 */
function showsEditionTitle(item: LibraryItem): boolean {
  if (!item.label) return false;
  return item.label.trim().toLocaleUpperCase("es") !== titleFromName(item.name);
}

/**
 * Tarjeta de un clip: miniatura reproducible igual que en el montaje, nombre original y
 * duración. La categoría no se repite aquí: el filtro ya la fija y se cambia con el lápiz
 * de la barra. Se elige pulsando cualquier parte que no sea el vídeo, y el puesto se ve
 * en la esquina.
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
          aria-label={`Vista previa de ${displayName(item.name)}`}
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
            picked
              ? `Quitar ${displayName(item.name)} del ranking`
              : `Elegir ${displayName(item.name)} para el ranking`
          }
          disabled={disabled}
          onClick={() => onToggle(item.id)}
        >
          {displayName(item.name)}
        </button>
      </h3>
      {/* La duración a un extremo y el puntaje al otro: el score se lee de un vistazo. */}
      <div className="gallery-facts">
        <p className="gallery-meta">
          {item.duration_s != null
            ? `Duración: ${formatDuration(item.duration_s)}`
            : duration === null
              ? "Duración: —"
              : `Duración: ${formatDuration(duration)}`}
        </p>
        {item.score != null ? (
          <p className="gallery-score" aria-label={`Puntaje ${item.score} de 100`}>
            <strong className="gallery-score-number">{item.score}</strong> pts
          </p>
        ) : null}
      </div>
      {showsEditionTitle(item) ? (
        <p className="gallery-meta gallery-title">Título en la edición: {item.label}</p>
      ) : null}
      {item.duplicateOf ? (
        <p className="gallery-meta gallery-duplicate">Posible duplicado de otro clip</p>
      ) : null}
    </li>
  );
});

export default memo(Gallery);
