"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { clampPositions, LIMITS, labelErrors, POSITIONS_MAX, POSITIONS_MIN, positionsFor, titleErrors } from "@/lib/limits";
import { formatDuration } from "@/lib/progress";
import { cycleColor, titleWords, visibleLength, wordsToTitle } from "@/lib/title";

type Artifact = { path: string; label: string; kind: "video" | "image" | "json"; bytes: number };

type ProgressEvent = { percent: number; phase: string; label: string; step?: number; total?: number };

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
  result: Record<string, unknown> | null;
}

/** La parte de la plantilla que el panel puede ajustar y guardar. */
interface EditablePreset {
  font: string;
  italic: boolean;
  title: { size: number; background: boolean };
  rank_ladder: { size: number; x: number; y_top: number; y_bottom: number };
}

type StylePatch = {
  font?: string;
  italic?: boolean;
  title?: Partial<EditablePreset["title"]>;
  rank_ladder?: Partial<EditablePreset["rank_ladder"]>;
};

interface PresetRanges {
  titleSize: [number, number];
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

/** `TOP 5 MOMENTOS` → `TOP 8 MOMENTOS`: el número del título sigue al de puestos. */
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
  const [title, setTitle] = useState("TOP 5 MOMENTOS");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
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
  const runToken = useRef(0);

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
        positions?: number;
        labels?: Record<string, string>;
      };
      const count = clampPositions(saved.positions ?? POSITIONS_MIN);
      if (saved.title) setTitle(saved.title);
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
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ title, positions, labels }));
    } catch {
      // Sin espacio o en modo privado: seguir, el estado vive en el servidor igual.
    }
  }, [slots, title, positions]);

  // El render del motor (FFmpeg) **no es instantáneo**: dibuja el overlay sobre negro
  // pero tarda unos segundos, así que se pide con retardo y nunca en vivo.
  const pedirRender = useCallback(() => {
    const params = new URLSearchParams({ title: title.trim(), positions: String(positions) });
    for (const slot of slots) params.set(`label${slot.position}`, slot.label.trim());
    if (style) params.set("style", JSON.stringify(style));
    setPreviewFailed(false);
    setRendering(true);
    setRenderUrl(`/api/preview?${params.toString()}&t=${Date.now()}`);
  }, [title, slots, style, positions]);

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

  // Al elegir el archivo solo se guarda el archivo: el nombre del puesto lo escribe el
  // operador (el panel no le pone texto solo por el nombre del fichero).
  const onPick = useCallback(
    (position: number, file: File | null) => {
      setSlot(position, { file });
    },
    [setSlot],
  );

  const problems = problemList(slots, title);

  const patchStyle = useCallback((patch: StylePatch) => {
    setStyle((current) =>
      current
        ? {
            font: patch.font ?? current.font,
            italic: patch.italic ?? current.italic,
            title: { ...current.title, ...patch.title },
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
  const dirty = style !== null && savedStyle !== null && styleKey(style) !== styleKey(savedStyle);

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
      labels: Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label.trim()])),
      positions,
    }),
    [slots, title, positions],
  );

  const montar = useCallback(async () => {
    if (problemList(slots, title).length > 0) {
      setError(problemList(slots, title)[0]);
      return;
    }
    const token = ++runToken.current;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const created = await fetch("/api/jobs", { method: "POST" }).then((response) => response.json());
      if (!created?.id) throw new Error(created?.error ?? "No se pudo abrir el trabajo en el servidor.");

      for (const slot of slots) {
        const extension = `.${(slot.file?.name.split(".").pop() ?? "mp4").toLowerCase()}`;
        const response = await fetch(
          `/api/jobs/${created.id}/clips/${slot.position}?ext=${encodeURIComponent(extension)}`,
          { method: "PUT", body: slot.file },
        );
        if (!response.ok) throw new Error((await response.json())?.error ?? "No se pudo subir un clip.");
      }

      const started = await fetch(`/api/jobs/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startPayload()),
      });
      if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo arrancar el montaje.");

      await poll(created.id, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Algo falló. Vuelve a intentarlo.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }, [slots, title, startPayload, poll]);

  const reintentar = useCallback(async () => {
    if (!job) {
      await montar();
      return;
    }
    const token = ++runToken.current;
    setBusy(true);
    setError(null);
    try {
      const started = await fetch(`/api/jobs/${job.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startPayload()),
      });
      if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo reintentar.");
      await poll(job.id, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Algo falló al reintentar.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }, [job, poll, montar, startPayload]);

  const running = busy || job?.state === "running" || job?.state === "uploading";

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
  const cover = job?.artifacts.find((artifact) => artifact.path === "cover.jpg");
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
      </Phone>
      {previewFailed ? (
        <div className="alert error" role="alert">
          No se pudo dibujar el render exacto del motor.
        </div>
      ) : null}
      <p className="hint center">
        Los cambios tardan unos segundos en verse
      </p>
      {rendering ? <p className="hint center">Dibujando el overlay…</p> : null}
    </>
  );

  return (
    <main className="shell">
      <header className="top">
        <div className="top-row">
          <div>
            <h1>openRanks · montar un TOP {positions}</h1>
            <p>
              Sube los clips, escribe los top y el titulo. El montaje union y edición es automático.
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
              Se encajan los clips a 9:16 y 30 fps (banda central, sin recortar arriba ni
              abajo) con el audio normalizado.
            </p>
            {slots.map((slot) => (
              <div className="slot" key={slot.position}>
                <div className="rank">
                  <div className="num">#{slot.position}</div>
                  <div className="when">
                    {slot.position === positions ? "abre" : slot.position === 1 ? "cierra" : ""}
                  </div>
                </div>
                <div className="fields">
                  <input
                    type="file"
                    accept="video/*"
                    aria-label={`Archivo del puesto ${slot.position}`}
                    disabled={running}
                    onChange={(event) => onPick(slot.position, event.target.files?.[0] ?? null)}
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
                      disabled={running}
                      onChange={(event) => setSlot(slot.position, { label: event.target.value })}
                    />
                    <div className={`counter ${slot.label.length >= LIMITS.labelChars ? "over" : ""}`}>
                      {slot.label.length}/{LIMITS.labelChars} caracteres · máximo {LIMITS.labelWords} palabras
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>
              <span className="step">2</span>El título
            </h2>
            <p className="hint">
              El número se pinta solo, con su propio color. Máximo {LIMITS.titleLayerChars} caracteres (las marcas
              de color no cuentan).
            </p>
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

          <section className="card">
            <h2>Montar el ranking</h2>
            <p className="hint">
              El montaje es siempre automático y <strong>en corte seco</strong>: los clips se pegan uno tras otro, en
              orden, sin transiciones. El estilo lo fija la plantilla.
            </p>

            <div className="actions">
              <button className="primary" onClick={montar} disabled={running || problems.length > 0}>
                {running ? "Montando…" : "Montar el ranking"}
              </button>
              {job?.state === "failed" ? (
                <button className="secondary" onClick={reintentar} disabled={running}>
                  Volver a intentarlo
                </button>
              ) : null}
            </div>
            {problems.length > 0 && !error ? <p className="hint">{problems[0]}</p> : null}
            {error ? (
              <div className="alert error" role="alert">
                {error}
              </div>
            ) : null}
          </section>
        </div>
        <div>
          <section className="card">
            <h2>Plantilla de renderizado</h2>
            <p></p>
            {previewPanel}
            <div className="actions">
              <button className="secondary" type="button" onClick={() => setDrawerOpen(true)}>
                Ajustar la plantilla
              </button>
            </div>
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
                      : "El vídeo aparecerá aquí en cuanto esté montado."}
                  </p>
                )}

                {cover ? (
                  <>
                    <p className="hint" style={{ marginTop: 16 }}>
                      Portada
                    </p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="cover" src={fileUrl(cover.path)} alt="Portada del ranking" />
                  </>
                ) : null}

                {job.artifacts.length > 0 ? (
                  <ul className="downloads">
                    {job.artifacts.map((artifact) => (
                      <li key={artifact.path}>
                        <a href={fileUrl(artifact.path)} download>
                          {artifact.label}
                        </a>
                        <span className="size">{humanSize(artifact.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {job.logTail ? (
                  <details className="log">
                    <summary>Detalles técnicos</summary>
                    <pre className="log">{job.logTail}</pre>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="hint">Aún no has montado nada. Cuando lo hagas, el vídeo se verá aquí mismo.</p>
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
                      {preset?.fontNotes?.[style.font] ? (
                        <p className="hint">{preset.fontNotes[style.font]}</p>
                      ) : null}
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

                    <label className="control switch">
                      <input
                        type="checkbox"
                        checked={style.title.background}
                        onChange={(event) => patchStyle({ title: { background: event.target.checked } })}
                      />
                      Fondo negro detrás del título
                    </label>

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
        Solo el título y los nombres de los puestos son editables: el resto del estilo vive en el preset bloqueado y el
        render es siempre automático.
      </footer>
    </main>
  );
}

/** Clave estable para comparar si la plantilla en pantalla difiere de la guardada. */
function styleKey(value: EditablePreset): string {
  const { font, italic, title, rank_ladder } = value;
  return [
    font,
    italic,
    title.size,
    title.background,
    rank_ladder.size,
    rank_ladder.x,
    rank_ladder.y_top,
    rank_ladder.y_bottom,
  ].join("|");
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

/** Deslizador con su valor a la vista. */
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
  return (
    <div className="control">
      <label className="field" htmlFor={id}>
        {label} <span className="value-pill">{value}</span>
      </label>
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

/** Reúne los problemas del formulario con el mismo límite que valida el motor (§9.5). */
function problemList(slots: Slot[], title: string): string[] {
  const list: string[] = [];
  const pending = slots.filter((slot) => !slot.file);
  if (pending.length === 1) list.push(`Falta el clip del puesto ${pending[0].position}.`);
  else if (pending.length > 1) list.push(`Faltan ${pending.length} clips: puestos ${pending.map((slot) => slot.position).join(", ")}.`);
  list.push(...titleErrors(title));
  for (const slot of slots) list.push(...labelErrors(slot.position, slot.label));
  return list;
}
