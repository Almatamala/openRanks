"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  clampPositions,
  LIMITS,
  labelErrors,
  POSITIONS_MAX,
  POSITIONS_MIN,
  positionsFor,
  subtitleErrors,
  textLength,
  titleErrors,
} from "@/lib/limits";
import { formatDuration } from "@/lib/progress";
import { cycleColor, titleWords, visibleLength, wordsToTitle } from "@/lib/title";

type Artifact = { path: string; bytes: number };

type ProgressEvent = { percent: number; phase: string; label: string; step?: number; total?: number };

/** Estado de un puesto: se prepara al subirlo y su tick es la señal de que está listo. */
type ClipState = "uploading" | "preparing" | "ready" | "failed";

type ClipStatus = {
  state: ClipState;
  error: string | null;
  percent?: number;
};

type JoinState = "idle" | "joining" | "ready" | "failed";

interface Job {
  id: string;
  state: "created" | "uploading" | "running" | "done" | "failed";
  phase: string;
  progress: number;
  progressDetail: ProgressEvent | null;
  etaSeconds: number | null;
  elapsedSeconds: number | null;
  startedAt: string | null;
  error: string | null;
  artifacts: Artifact[];
  logTail: string;
  clips: Record<string, ClipStatus>;
  join: { state: JoinState; error: string | null };
}

/** La parte de la plantilla que el panel puede ajustar y guardar. */
interface EditablePreset {
  font: string;
  italic: boolean;
  title: { size: number; y: number };
  subtitle: { size: number };
  rank_ladder: { size: number; x: number; y_top: number; y_bottom: number };
}

type StylePatch = {
  font?: string;
  italic?: boolean;
  title?: Partial<EditablePreset["title"]>;
  subtitle?: Partial<EditablePreset["subtitle"]>;
  rank_ladder?: Partial<EditablePreset["rank_ladder"]>;
};

interface PresetRanges {
  titleSize: [number, number];
  titleY: [number, number];
  subtitleSize: [number, number];
  ladderSize: [number, number];
  x: [number, number];
  yTop: [number, number];
  yBottom: [number, number];
}

interface Preset {
  preset: string;
  font: string;
  editable: EditablePreset;
  saved: EditablePreset | null;
  fonts: string[];
  fontNotes: Record<string, string>;
  ranges: PresetRanges;
}

interface Slot {
  position: number;
  file: File | null;
  label: string;
}

const STORE_KEY = "openranks.panel.v1";

/** Puestos que ofrece el panel: del TOP 5 al TOP 10. */
const POSITION_CHOICES = Array.from(
  { length: POSITIONS_MAX - POSITIONS_MIN + 1 },
  (_, index) => POSITIONS_MIN + index,
);

function initialSlots(count: number): Slot[] {
  return positionsFor(count).map((position) => ({ position, file: null, label: "" }));
}

/** `TOP 5 MOMENTOS` → `TOP 8 MOMENTOS`: si el título lleva un número, sigue al de puestos. */
function retitleForCount(title: string, count: number): string {
  return title.replace(/^(\s*top\s*)\d+/i, (_, head: string) => `${head}${count}`);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Page() {
  const [positions, setPositions] = useState(POSITIONS_MIN);
  const [slots, setSlots] = useState<Slot[]>(() => initialSlots(POSITIONS_MIN));
  const [title, setTitle] = useState("Ranking funny moments");
  const [subtitle, setSubtitle] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  // Espejo local de lo que dice el servidor, para pintar el tick sin esperar la consulta.
  const [prep, setPrep] = useState<Record<number, ClipStatus>>({});
  // Sube cuando algo cambia fuera del sondeo (subida, unión, montaje) para reactivarlo.
  const [pollNonce, setPollNonce] = useState(0);
  const jobPromise = useRef<Promise<string> | null>(null);
  const pickTokens = useRef<Record<number, number>>({});
  // Inputs de archivo por puesto: al soltar un clip se refleja su nombre en el selector.
  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({});
  const uploadsInFlight = useRef<Set<number>>(new Set());
  const [preset, setPreset] = useState<Preset | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [style, setStyle] = useState<EditablePreset | null>(null);
  const [savedStyle, setSavedStyle] = useState<EditablePreset | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [styleError, setStyleError] = useState<string | null>(null);
  // Puesto sobre el que se está arrastrando un archivo: resalta toda su casilla.
  const [dragSlot, setDragSlot] = useState<number | null>(null);
  // Recorrido **real** de la altura del título, calculado por el motor: fuera de él
  // el render no cambia (el título ya está pegado a la zona segura o a la escalera).
  const [titleYRange, setTitleYRange] = useState<[number, number] | null>(null);
  const runToken = useRef(0);
  const previewToken = useRef(0);

  // La plantilla vive en el motor: el panel la lee, la edita y la guarda (§RF-9.10).
  const cargarPlantilla = useCallback(async () => {
    try {
      const response = await fetch("/api/preset", { cache: "no-store" });
      if (!response.ok) throw new Error("sin respuesta");
      const data = (await response.json()) as Preset;
      setPreset(data);
      setStyle(data.saved ?? data.editable);
      setSavedStyle(data.saved ?? data.editable);
      setPresetError(null);
    } catch {
      setPresetError("No se pudo leer la plantilla del motor.");
    }
  }, []);

  useEffect(() => {
    void cargarPlantilla();
  }, [cargarPlantilla]);

  // RF-9.7: nada del trabajo en curso se pierde al recargar.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        title?: string;
        subtitle?: string;
        positions?: number;
        labels?: Record<string, string>;
      };
      const count = clampPositions(saved.positions ?? POSITIONS_MIN);
      if (saved.title) setTitle(saved.title);
      if (typeof saved.subtitle === "string") setSubtitle(saved.subtitle);
      setPositions(count);
      setSlots(
        positionsFor(count).map((position) => ({ position, file: null, label: saved.labels?.[String(position)] ?? "" })),
      );
    } catch {
      // Un almacén corrupto no puede impedir usar el panel.
    }
  }, []);

  useEffect(() => {
    const labels = Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label]));
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ title, subtitle, positions, labels }));
    } catch {
      // Sin espacio o en modo privado: seguir, el estado vive en el servidor igual.
    }
  }, [slots, title, subtitle, positions]);

  // El render del motor (FFmpeg) **no es instantáneo**: dibuja el overlay sobre negro
  // pero tarda unos segundos, así que se pide con retardo y nunca en vivo. Se descarga
  // con `fetch` para leer el recorrido real de la altura del título que manda el motor
  // en las cabeceras; la imagen se sirve como blob para no depender de la caché.
  const pedirRender = useCallback(async () => {
    const token = ++previewToken.current;
    const params = new URLSearchParams({ title: title.trim(), subtitle: subtitle.trim(), positions: String(positions) });
    for (const slot of slots) params.set(`label${slot.position}`, slot.label.trim());
    if (style) params.set("style", JSON.stringify(style));
    setPreviewFailed(false);
    setRendering(true);
    try {
      const response = await fetch(`/api/preview?${params.toString()}&t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("sin vista previa");
      if (previewToken.current !== token) return;

      const rawMin = Number.parseFloat(response.headers.get("X-OpenRanks-Title-Y-Min") ?? "");
      const rawMax = Number.parseFloat(response.headers.get("X-OpenRanks-Title-Y-Max") ?? "");
      if (Number.isFinite(rawMin) && Number.isFinite(rawMax) && rawMax >= rawMin) {
        const bounds: [number, number] = [Math.round(rawMin), Math.round(rawMax)];
        setTitleYRange(bounds);
        // Si el valor guardado quedó fuera del hueco (otro texto o tamaño), se deja en
        // el borde para que lo que muestra la plantilla sea lo que se guarda.
        setStyle((current) => {
          if (!current) return current;
          const clamped = Math.min(bounds[1], Math.max(bounds[0], current.title.y));
          return clamped === current.title.y
            ? current
            : { ...current, title: { ...current.title, y: clamped } };
        });
      }

      const blob = await response.blob();
      if (previewToken.current !== token) return;
      setRenderUrl(URL.createObjectURL(blob));
    } catch {
      if (previewToken.current === token) setPreviewFailed(true);
    } finally {
      if (previewToken.current === token) setRendering(false);
    }
  }, [title, subtitle, slots, style, positions]);

  // La imagen vive en un objeto URL: se libera al desmontar o al llegar otra nueva.
  useEffect(() => {
    if (!renderUrl) return;
    return () => URL.revokeObjectURL(renderUrl);
  }, [renderUrl]);

  useEffect(() => () => {
    previewToken.current += 1;
  }, []);

  // El render exacto es **implícito**: no hay botón que lo pida. Se pide solo, con una
  // pausa, cuando cambia el título, un rótulo o la plantilla: arrastrar un deslizador no
  // lanza un FFmpeg por cada tirón.
  useEffect(() => {
    if (!style) return;
    const timer = window.setTimeout(() => pedirRender(), 900);
    return () => window.clearTimeout(timer);
  }, [style, pedirRender]);

  // Cambiar los puestos deja la escalera a medida: se conservan los clips y los nombres
  // que ya estaban puestos y el número del título sigue al del ranking.
  const cambiarPuestos = useCallback((raw: number) => {
    const count = clampPositions(raw);
    setPositions(count);
    setSlots((current) => {
      const byPosition = new Map(current.map((slot) => [slot.position, slot]));
      return positionsFor(count).map(
        (position) => byPosition.get(position) ?? { position, file: null, label: "" },
      );
    });
    setTitle((current) => retitleForCount(current, count));
  }, []);

  const setSlot = useCallback((position: number, patch: Partial<Slot>) => {
    setSlots((current) => current.map((slot) => (slot.position === position ? { ...slot, ...patch } : slot)));
  }, []);

  // El trabajo se abre la **primera** vez que entra un clip, no al montar. Si dos
  // puestos se suben a la vez, los dos esperan al mismo trabajo.
  const ensureJob = useCallback((): Promise<string> => {
    if (jobPromise.current) return jobPromise.current;
    const created = (async () => {
      const response = await fetch("/api/jobs", { method: "POST" });
      const payload = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !payload?.id) {
        throw new Error(payload?.error ?? "No se pudo abrir el trabajo en el servidor.");
      }
      setJobId(payload.id);
      return payload.id;
    })();
    jobPromise.current = created;
    created.catch(() => {
      jobPromise.current = null;
    });
    return created;
  }, []);

  // Al elegir el archivo se sube y se prepara **enseguida**: el trabajo pesado ocurre
  // mientras el operador sigue con los otros puestos o escribe los nombres. El tick es
  // la señal de que ese clip ya está en el formato final (no un «subido» sin más).
  const onPick = useCallback(
    (position: number, file: File | null) => {
      setSlot(position, { file });
      const token = (pickTokens.current[position] ?? 0) + 1;
      pickTokens.current[position] = token;
      if (!file) {
        setPrep((current) => {
          const next = { ...current };
          delete next[position];
          return next;
        });
        return;
      }

      uploadsInFlight.current.add(position);
      setError(null);
      setPrep((current) => ({
        ...current,
        [position]: { state: "uploading", error: null, percent: 0 },
      }));

      void (async () => {
        try {
          const id = await ensureJob();
          if (pickTokens.current[position] !== token) return;
          const extension = `.${(file.name.split(".").pop() ?? "mp4").toLowerCase()}`;
          const uploaded = await fetch(
            `/api/jobs/${id}/clips/${position}?ext=${encodeURIComponent(extension)}&items=${positions}`,
            { method: "PUT", body: file },
          );
          if (!uploaded.ok) throw new Error((await uploaded.json())?.error ?? "No se pudo subir el clip.");
          if (pickTokens.current[position] !== token) return;

          const started = await fetch(`/api/jobs/${id}/clips/${position}/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ positions }),
          });
          if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo preparar el clip.");
        } catch (failure) {
          if (pickTokens.current[position] !== token) return;
          setPrep((current) => ({
            ...current,
            [position]: {
              state: "failed",
              error: failure instanceof Error ? failure.message : "No se pudo preparar el clip.",
            },
          }));
        } finally {
          uploadsInFlight.current.delete(position);
          setPollNonce((value) => value + 1);
        }
      })();
    },
    [ensureJob, positions, setSlot],
  );

  // Todos los puestos con su tick: es lo que dispara la unión y lo que habilita «Montar».
  const allReady = slots.length > 0 && slots.every((slot) => prep[slot.position]?.state === "ready");

  const problems = problemList(slots, title, subtitle, prep);

  const patchStyle = useCallback((patch: StylePatch) => {
    setStyle((current) =>
      current
        ? {
            font: patch.font ?? current.font,
            italic: patch.italic ?? current.italic,
            title: { ...current.title, ...patch.title },
            subtitle: { ...current.subtitle, ...patch.subtitle },
            rank_ladder: { ...current.rank_ladder, ...patch.rank_ladder },
          }
        : current,
    );
  }, []);

  const guardarPlantilla = useCallback(async () => {
    if (!style) return;
    setSaving(true);
    setStyleError(null);
    try {
      const response = await fetch("/api/preset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(style),
      });
      if (!response.ok) throw new Error("No se pudo guardar la plantilla.");
      const data = (await response.json()) as { saved: EditablePreset };
      setSavedStyle(data.saved);
      setStyle(data.saved);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2500);
    } catch (failure) {
      setStyleError(failure instanceof Error ? failure.message : "No se pudo guardar la plantilla.");
    } finally {
      setSaving(false);
    }
  }, [style]);

  const restablecerPlantilla = useCallback(async () => {
    setSaving(true);
    setStyleError(null);
    try {
      const response = await fetch("/api/preset", { method: "DELETE" });
      if (!response.ok) throw new Error("No se pudo restablecer la plantilla.");
      await cargarPlantilla();
    } catch (failure) {
      setStyleError(failure instanceof Error ? failure.message : "No se pudo restablecer la plantilla.");
    } finally {
      setSaving(false);
    }
  }, [cargarPlantilla]);

  // Hay cambios en pantalla que el montaje todavía no usaría: se avisa.
  const dirty = savedStyle !== null && style !== null && styleKey(style) !== styleKey(savedStyle);

  // El deslizador de altura solo recorre el hueco donde el motor mueve el título.
  const titleYBounds: [number, number] = titleYRange ?? preset?.ranges?.titleY ?? [96, 900];
  const titleYValue = Math.min(titleYBounds[1], Math.max(titleYBounds[0], style?.title.y ?? titleYBounds[0]));

  const poll = useCallback(async (id: string, token: number) => {
    for (;;) {
      if (runToken.current !== token) return;
      const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!response.ok) {
        setError("Se perdió la conexión con el servidor mientras montaba.");
        return;
      }
      const next = (await response.json()) as Job;
      if (runToken.current !== token) return;
      setJob(next);
      if (next.state === "done" || next.state === "failed") return;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }, []);

  // Lo que el motor necesita para arrancar: el mismo cuerpo lo usan «Montar» y
  // «Volver a intentarlo», así que se construye en un solo sitio.
  const startPayload = useCallback(
    () => ({
      title: title.trim(),
      subtitle: subtitle.trim(),
      labels: Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label.trim()])),
      positions,
    }),
    [slots, title, subtitle, positions],
  );

  // Sonda del trabajo: se reactiva con cada subida, unión o montaje y se para sola
  // cuando ya no hay nada en marcha (no deja un sondeo eterno de fondo).
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!alive) return;
        if (response.ok) {
          const next = (await response.json()) as Job;
          if (!alive) return;
          setJob(next);
          setPrep((current) => {
            const merged = { ...current };
            for (const [key, status] of Object.entries(next.clips ?? {})) {
              const position = Number(key);
              // Una subida local que aún no llegó al servidor no se pisa con el estado viejo.
              if (uploadsInFlight.current.has(position)) continue;
              merged[position] = status;
            }
            return merged;
          });
          const busy =
            next.state === "running" ||
            next.join.state === "joining" ||
            Object.values(next.clips ?? {}).some(
              (clip) => clip.state === "uploading" || clip.state === "preparing",
            );
          if (!busy) return;
        }
      } catch {
        // Se reintenta en el siguiente ciclo.
      }
      if (alive) timer = window.setTimeout(load, 1200);
    };
    void load();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId, pollNonce]);

  // «Montar» une los clips preparados (si aún no hay unión) y compone la edición encima.
  const montar = useCallback(async () => {
    const currentProblems = problemList(slots, title, subtitle, prep);
    if (currentProblems.length > 0) {
      setError(currentProblems[0]);
      return;
    }
    if (!jobId) {
      setError("Añade primero los clips del ranking.");
      return;
    }
    const token = ++runToken.current;
    setBusy(true);
    setError(null);
    try {
      const started = await fetch(`/api/jobs/${jobId}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startPayload()),
      });
      if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo arrancar el montaje.");
      await poll(jobId, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Algo falló. Vuelve a intentarlo.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }, [jobId, poll, prep, slots, startPayload, subtitle, title]);

  const running = busy || job?.state === "running";

  // La barra solo se mueve mientras hay trabajo; el reloj va por dentro para que el
  // tiempo restante baje cada segundo y no solo cuando llega una consulta nueva.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const percent = job?.progress ?? 0;
  const startedAtMs = job?.startedAt ? Date.parse(job.startedAt) : null;
  const elapsed = startedAtMs === null ? null : Math.max(0, Math.round((tick - startedAtMs) / 1000));
  const measured = job?.progressDetail?.percent ?? null;
  const etaFromMeasurement =
    running && measured !== null && measured > 1 && measured < 100 && startedAtMs !== null
      ? Math.max(0, ((tick - startedAtMs) / 1000 / measured) * (100 - measured))
      : null;
  const eta = etaFromMeasurement ?? (running ? (job?.etaSeconds ?? null) : null);

  const ranking = job?.artifacts.find((artifact) => artifact.path === "ranking.mp4");
  const fileUrl = (path: string) => `/api/jobs/${job?.id}/files?path=${encodeURIComponent(path)}`;

  // Móvil con el **render exacto** dentro: es el motor el que dibuja el overlay sobre
  // negro, así que lo que se ve es lo que saldrá en el vídeo. No hay vista «en vivo»:
  // la réplica del navegador no cuadraba con el render y mentía.
  const previewPanel = (
    <>
      <Phone>
        {renderUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="phone-screen"
            src={renderUrl}
            alt="Render exacto del overlay sobre fondo negro"
            onLoad={() => setRendering(false)}
            onError={() => {
              setRendering(false);
              setPreviewFailed(true);
            }}
          />
        ) : (
          <div className="phone-screen empty">Preparando…</div>
        )}
        {rendering ? (
          <div className="phone-loading" role="status" aria-label="Dibujando la vista previa">
            <span className="spinner" aria-hidden="true" />
          </div>
        ) : null}
      </Phone>
      {previewFailed ? (
        <div className="alert error" role="alert">
          No se pudo dibujar el render exacto del motor.
        </div>
      ) : null}
    </>
  );

  return (
    <main className="shell">
      <header className="top">
        <div className="top-row">
          <div>
            <h1>openRanks · montar un TOP {positions}</h1>
            <p>
              Sube los clips y escribe los puestos y el título. Cada clip se prepara solo al entrar:
              cuando todos tienen su tick, «Montar» une los clips y añade la edición.
            </p>
          </div>
        </div>
      </header>

      <div className="layout">
        <div>
          <section className="card">
            <h2>
              <span className="step">1</span>Tus{" "}
              <select
                id="positions"
                className="title-select"
                aria-label="Cuántos puestos tiene el ranking"
                value={positions}
                disabled={running}
                onChange={(event) => cambiarPuestos(Number(event.target.value))}
                style={{
                  WebkitAppearance: 'none',
                  outline: 'none',
                }}
              >
                {POSITION_CHOICES.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>{" "}
              clips
            </h2>
            <p className="hint">
              Al elegir un clip se prepara en segundo plano (área útil, 9:16, 30 fps y audio
              normalizado).
            </p>
            {slots.map((slot) => (
              <div
                className={`slot ${dragSlot === slot.position ? "drag-over" : ""}`}
                key={slot.position}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!running) setDragSlot(slot.position);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  const next = event.relatedTarget;
                  if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                    setDragSlot((current) => (current === slot.position ? null : current));
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragSlot(null);
                  if (running) return;
                  const file = event.dataTransfer?.files?.[0];
                  if (!file) return;
                  // El selector nativo solo cambia su etiqueta si el archivo entra en su
                  // lista; reflejarlo aquí evita que siga diciendo «sin archivos seleccionados».
                  const input = fileInputs.current[slot.position];
                  if (input) {
                    try {
                      const transfer = new DataTransfer();
                      transfer.items.add(file);
                      input.files = transfer.files;
                    } catch {
                      // Sin soporte para asignar archivos: el clip se sube igual.
                    }
                  }
                  onPick(slot.position, file);
                }}
              >
                {dragSlot === slot.position ? (
                  <div className="slot-drop-hint" aria-hidden="true">
                    Suelta el clip en este puesto
                  </div>
                ) : null}
                <div className="rank">
                  {slot.file ? (
                    <SlotThumb file={slot.file} position={slot.position} />
                  ) : (
                    <div className="num">#{slot.position}</div>
                  )}
                </div>
                <div className="fields">
                  <div className="file-field">
                    <input
                      type="file"
                      accept="video/*"
                      aria-label={`Archivo del puesto ${slot.position}`}
                      disabled={running}
                      ref={(node) => {
                        fileInputs.current[slot.position] = node;
                      }}
                      onChange={(event) => onPick(slot.position, event.target.files?.[0] ?? null)}
                    />
                    <ClipBadge status={prep[slot.position]} />
                  </div>
                  <SlotStatus
                    status={prep[slot.position]}
                    onRetry={slot.file && !running ? () => onPick(slot.position, slot.file) : undefined}
                  />
                  <div>
                    <label className="field" htmlFor={`label-${slot.position}`}>
                      Nombre del puesto #{slot.position}
                    </label>
                    <input
                      id={`label-${slot.position}`}
                      type="text"
                      value={slot.label}
                      maxLength={LIMITS.labelChars}
                      placeholder="p. ej. GATO VOLADOR"
                      onChange={(event) => setSlot(slot.position, { label: event.target.value })}
                    />
                    <div className={`counter ${slot.label.length >= LIMITS.labelChars ? "over" : ""}`}>
                      {slot.label.length}/{LIMITS.labelChars} caracteres
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>
              <span className="step">2</span>El título y el subtítulo
            </h2>

            <label className="field" htmlFor="title">
              Título del vídeo
            </label>
            <input
              id="title"
              type="text"
              value={title}
              maxLength={LIMITS.titleLayerChars * 2}
              disabled={running}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className={`counter ${visibleLength(title) > LIMITS.titleLayerChars ? "over" : ""}`}>
              {visibleLength(title)}/{LIMITS.titleLayerChars} caracteres
            </div>
            <label className="field" htmlFor="subtitle" style={{ marginTop: 16 }}>
              Subtítulo del vídeo (opcional)
            </label>
            <input
              id="subtitle"
              type="text"
              value={subtitle}
              maxLength={LIMITS.titleLayerChars * 2}
              placeholder="p. ej. LOS MOMENTOS MÁS LOCOS"
              disabled={running}
              onChange={(event) => setSubtitle(event.target.value)}
            />
            <div className={`counter ${textLength(subtitle.trim()) > LIMITS.titleLayerChars ? "over" : ""}`}>
              {textLength(subtitle.trim())}/{LIMITS.titleLayerChars} caracteres
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              Toca una palabra para cambiar su color: blanco → <strong>amarillo</strong> → <strong>azul</strong>. En
              el texto se marca con <code>*amarillo*</code> y <code>_azul_</code>.
            </p>
            <div className="words">
              {titleWords(title).map((word, index) => (
                <button
                  key={`${word.text}-${index}`}
                  type="button"
                  className={`word ${word.color}`}
                  disabled={running}
                  aria-label={`${word.text}: cambiar color (ahora ${word.color})`}
                  onClick={() => {
                    const words = titleWords(title);
                    words[index] = { ...words[index], color: cycleColor(words[index].color) };
                    setTitle(wordsToTitle(words));
                  }}
                >
                  {word.text}
                </button>
              ))}
            </div>
          </section>

        </div>
        <div>
          <section className="card preview-card">
            <h2>Plantilla de renderizado</h2>
            {previewPanel}
            <div className="actions">
              <button className="secondary" type="button" onClick={() => setDrawerOpen(true)}>
                Ajustar la plantilla
              </button>
            </div>
          </section>

          <section className="card montar-card">
            <div className="actions montar-actions">
              <button
                className="primary"
                onClick={montar}
                disabled={running || problems.length > 0 || !allReady}
              >
                {running ? "Montando…" : "Montar el ranking"}
              </button>
              {job?.state === "failed" ? (
                <button className="secondary" onClick={montar} disabled={running}>
                  Volver a intentarlo
                </button>
              ) : null}
            </div>
            {problems.length > 0 && !error ? <p className="hint">{problems[0]}</p> : null}
            {error ? (
              <div className="alert error " role="alert">
                {error}
              </div>
            ) : null}
          </section>

          <section className="card" aria-live="polite">
            <h2>Resultado</h2>

            {job ? (
              <>
                <div className="phase">
                  <span>{job.phase}</span>
                  <span>{percent}%</span>
                </div>
                <div
                  className={`progress ${running && percent < 4 ? "indeterminate" : ""}`}
                  role="progressbar"
                  aria-label="Avance del montaje"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-valuetext={`${job.phase}, ${percent}%${eta !== null ? `, quedan unos ${formatDuration(eta)}` : ""}`}
                >
                  <span style={{ width: `${percent}%` }} />
                </div>
                <div className="phase clock">
                  <span>{startedAtMs !== null ? `Lleva ${formatDuration(elapsed ?? 0)}` : ""}</span>
                  <span>
                    {running
                      ? eta !== null
                        ? `Quedan ~${formatDuration(eta)}`
                        : "Calculando el tiempo restante…"
                      : job.state === "done"
                        ? `Hecho en ${formatDuration(elapsed ?? 0)}`
                        : ""}
                  </span>
                </div>
                {running ? <p className="hint eta">Estimación por lo que ya se ha montado; se ajusta sola.</p> : null}

                {job.state === "failed" && job.error ? (
                  <div className="alert error" role="alert">
                    {job.error}
                  </div>
                ) : null}

                {ranking ? (
                  <>
                    <div className="alert ok" role="status">
                      Tu ranking está listo. Se reproduce en 9:16 y ya lleva la edición.
                    </div>
                    <video key={ranking.path} src={fileUrl(ranking.path)} controls playsInline preload="metadata" />
                  </>
                ) : (
                  <p className="hint">
                    {job.state === "done"
                      ? "El montaje terminó, pero no hay vídeo que mostrar."
                      : allReady
                        ? "Los clips están listos: pulsa Montar para unirlos y añadir la edición."
                        : "El vídeo aparecerá aquí en cuanto esté montado."}
                  </p>
                )}

                {ranking ? (
                  <div className="actions">
                    {/* Lo único que se entrega es el ranking final: ni unión, ni spec,
                        ni manifiesto, ni portada. */}
                    <a className="button-link" href={fileUrl(ranking.path)} download>
                      Descargar el ranking ({humanSize(ranking.bytes)})
                    </a>
                  </div>
                ) : null}

                {job.logTail ? (
                  <details className="log">
                    <summary>Detalles técnicos</summary>
                    <pre className="log">{job.logTail}</pre>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="hint">
                Sube los clips: cada uno se prepara al entrar y aquí verás el ranking en cuanto lo montes.
              </p>
            )}
          </section>

        </div>
      </div>

      {drawerOpen ? (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="Plantilla de la edición">
            <header className="drawer-top">
              <h2>Plantilla de la edición</h2>
              <button className="secondary" type="button" onClick={() => setDrawerOpen(false)}>
                Cerrar
              </button>
            </header>

            <div className="drawer-body">
              <div className="drawer-controls">
                {style ? (
                  <>
                    <div className="control">
                      <label className="field" htmlFor="font">
                        Fuente
                      </label>
                      <select
                        id="font"
                        value={style.font}
                        onChange={(event) => patchStyle({ font: event.target.value })}
                      >
                        {(preset?.fonts ?? [style.font]).map((family) => (
                          <option key={family} value={family}>
                            {family}
                          </option>
                        ))}
                      </select>
                    </div>

                    <label className="control switch">
                      <input
                        type="checkbox"
                        checked={style.italic}
                        onChange={(event) => patchStyle({ italic: event.target.checked })}
                      />
                      Letras cursivas (itálica)
                    </label>

                    <RangeControl
                      id="title-size"
                      label="Tamaño de las letras del título"
                      value={style.title.size}
                      range={preset?.ranges?.titleSize ?? ([40, 220] as [number, number])}
                      onChange={(value) => patchStyle({ title: { size: value } })}
                    />

                    <RangeControl
                      id="title-y"
                      label="Altura del título"
                      value={titleYValue}
                      range={titleYBounds}
                      onChange={(value) => patchStyle({ title: { y: value } })}
                    />

                    <RangeControl
                      id="subtitle-size"
                      label="Tamaño de las letras del subtítulo"
                      value={style.subtitle.size}
                      range={preset?.ranges?.subtitleSize ?? ([24, 140] as [number, number])}
                      onChange={(value) => patchStyle({ subtitle: { size: value } })}
                    />

                    <RangeControl
                      id="ladder-size"
                      label="Tamaño de las letras del top (todas iguales)"
                      value={style.rank_ladder.size}
                      range={preset?.ranges?.ladderSize ?? ([60, 220] as [number, number])}
                      onChange={(value) => patchStyle({ rank_ladder: { size: value } })}
                    />

                    <RangeControl
                      id="ladder-x"
                      label="Posición horizontal del top"
                      value={style.rank_ladder.x}
                      range={preset?.ranges?.x ?? ([0, 1080] as [number, number])}
                      onChange={(value) => patchStyle({ rank_ladder: { x: value } })}
                    />

                    <RangeControl
                      id="ladder-top"
                      label="Altura del #1 (arriba)"
                      value={style.rank_ladder.y_top}
                      range={preset?.ranges?.yTop ?? ([0, 1900] as [number, number])}
                      onChange={(value) => patchStyle({ rank_ladder: { y_top: value } })}
                    />

                    <RangeControl
                      id="ladder-bottom"
                      label="Altura del #5 (abajo)"
                      value={style.rank_ladder.y_bottom}
                      range={preset?.ranges?.yBottom ?? ([0, 1900] as [number, number])}
                      onChange={(value) => patchStyle({ rank_ladder: { y_bottom: value } })}
                    />

                    <div className="actions">
                      <button className="primary" type="button" onClick={guardarPlantilla} disabled={saving || !dirty}>
                        {saving ? "Guardando…" : "Guardar plantilla"}
                      </button>
                      <button className="secondary" type="button" onClick={restablecerPlantilla} disabled={saving}>
                        Restablecer
                      </button>
                    </div>
                    {savedFlash ? <p className="hint ok">Plantilla guardada. El próximo montaje la usará.</p> : null}
                    {dirty ? (
                      <p className="hint">
                        El render ya muestra los cambios; guarda para que el próximo montaje los use.
                      </p>
                    ) : null}
                    {styleError ? (
                      <div className="alert error" role="alert">
                        {styleError}
                      </div>
                    ) : null}
                  </>
                ) : presetError ? (
                  <div className="alert error" role="alert">
                    {presetError}
                  </div>
                ) : (
                  <p className="hint">Leyendo la plantilla…</p>
                )}
              </div>
              <div className="drawer-stage">
                {previewPanel}
              </div>
            </div>
          </aside>
        </>
      ) : null}

      <footer className="note">
        Solo el título, el subtítulo opcional y los nombres de los puestos son editables: el resto del estilo vive en el
        preset bloqueado y el render es siempre automático.
      </footer>
    </main>
  );
}

/** Clave estable para comparar si la plantilla en pantalla difiere de la guardada. */
function styleKey(value: EditablePreset): string {
  const { font, italic, title, subtitle, rank_ladder } = value;
  return [
    font,
    italic,
    title.size,
    title.y,
    subtitle.size,
    rank_ladder.size,
    rank_ladder.x,
    rank_ladder.y_top,
    rank_ladder.y_bottom,
  ].join("|");
}

/**
 * Miniatura del clip elegido, en el hueco del número del puesto, con ese número
 * en la esquina superior izquierda. El objeto URL se crea y se libera con el archivo.
 */
function SlotThumb({ file, position }: { file: File; position: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  return (
    <div className="slot-thumb">
      {url ? (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={`Miniatura reproducible del clip del puesto ${position}`}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = 0.1;
          }}
        />
      ) : null}
      <span className="slot-thumb-number">#{position}</span>
    </div>
  );
}

/** Móvil: el marco es decorativo, dentro va el render exacto del motor. */
function Phone({ children }: { children: ReactNode }) {
  return (
    <div className="phone">
      <span className="phone-notch" aria-hidden="true" />
      <div className="phone-stage">{children}</div>
    </div>
  );
}

/** Deslizador con su valor a la vista: el número se puede clicar y escribir. */
function RangeControl({
  id,
  label,
  value,
  range,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  range: [number, number];
  onChange: (value: number) => void;
}) {
  // Mientras se escribe manda el borrador; al salir se ajusta al rango del motor.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isFinite(parsed)
      ? Math.min(range[1], Math.max(range[0], parsed))
      : value;
    setDraft(null);
    if (next !== value) onChange(next);
  };

  return (
    <div className="control">
      <div className="control-head">
        <label className="field" htmlFor={id}>
          {label}
        </label>
        <input
          className="value-pill"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={draft ?? String(value)}
          aria-label={`Valor de ${label}`}
          title="Haz clic y escribe un número"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, "").slice(0, 4))}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
        />
      </div>
      <input
        id={id}
        type="range"
        min={range[0]}
        max={range[1]}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/**
 * Estado del puesto en el extremo derecho del selector de archivo (esquina del puesto):
 * spinner mientras sube o se prepara, y tick cuando ese clip ya está listo.
 */
function ClipBadge({ status }: { status?: ClipStatus }) {
  if (!status || status.state === "failed") return null;
  if (status.state === "ready") {
    return (
      <span className="file-badge ready" role="status">
        <span className="tick" aria-hidden="true">
          ✓
        </span>
        Clip listo
      </span>
    );
  }
  return (
    <span className="file-badge busy" role="status">
      <span className="spinner" aria-hidden="true" />
      {status.state === "uploading" ? "Subiendo…" : "Preparando…"}
    </span>
  );
}

/** Error del puesto, debajo del selector: qué pasó y botón para reintentar. */
function SlotStatus({ status, onRetry }: { status?: ClipStatus; onRetry?: () => void }) {
  if (!status || status.state !== "failed") return null;

  return (
    <div className="slot-status failed" role="alert">
      <span>{status.error ?? "No se pudo preparar el clip."}</span>
      {onRetry ? (
        <button className="secondary small" type="button" onClick={onRetry}>
          Reintentar
        </button>
      ) : null}
    </div>
  );
}

/** Reúne los problemas del formulario con el mismo límite que valida el motor (RPD §9.5). */
function problemList(
  slots: Slot[],
  title: string,
  subtitle: string,
  prep: Record<number, ClipStatus>,
): string[] {
  const list: string[] = [];
  const pending = slots.filter((slot) => prep[slot.position]?.state !== "ready");
  if (pending.length === 1)
    list.push(`El clip del puesto ${pending[0].position} todavía no está listo.`);
  else if (pending.length > 1)
    list.push(
      `Faltan ${pending.length} clips por preparar: puestos ${pending.map((slot) => slot.position).join(", ")}.`,
    );
  list.push(...titleErrors(title));
  list.push(...subtitleErrors(subtitle));
  for (const slot of slots) list.push(...labelErrors(slot.position, slot.label));
  return list;
}
