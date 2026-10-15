"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { LIMITS, labelErrors, labelFromFilename, titleErrors } from "@/lib/limits";
import { formatDuration } from "@/lib/progress";
import { cycleColor, titleSpans, titleWords, visibleLength, wordsToTitle } from "@/lib/title";

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

interface PresetSetting {
  group: string;
  key: string;
  value: unknown;
  what: string;
  where: string;
}

/** La parte de la plantilla que el panel puede ajustar y guardar. */
interface EditablePreset {
  font: string;
  title: { size: number; background: boolean };
  rank_ladder: { size: number; x: number; y_top: number; y_bottom: number };
}

type StylePatch = {
  font?: string;
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
  where: string;
  settings: PresetSetting[];
  editable: EditablePreset;
  saved: EditablePreset | null;
  hasSaved: boolean;
  fonts: string[];
  ranges: PresetRanges;
}

interface Slot {
  position: number;
  file: File | null;
  label: string;
}

/** Opciones de montaje. El "pull in" de CapCut es el `xfade` más parecido (§3). */
const TRANSITIONS = [
  { key: "cut", label: "Corte seco (lo más rápido)", seconds: 0, type: "slideup" },
  { key: "pullin", label: "Pull-in 0,35 s", seconds: 0.35, type: "slideup" },
  { key: "pullin-long", label: "Pull-in 0,5 s", seconds: 0.5, type: "slideup" },
  { key: "fade", label: "Fundido 0,4 s", seconds: 0.4, type: "fade" },
] as const;

const STORE_KEY = "openranks.panel.v1";

function initialSlots(): Slot[] {
  return LIMITS.positions.map((position) => ({ position, file: null, label: "" }));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Page() {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [title, setTitle] = useState("TOP 5 MOMENTOS");
  const [transition, setTransition] = useState<string>("pullin");
  const [coldOpen, setColdOpen] = useState(false);
  const [zoom, setZoom] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"live" | "render">("live");
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
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
        transition?: string;
        coldOpen?: boolean;
        zoom?: boolean;
        labels?: Record<string, string>;
      };
      if (saved.title) setTitle(saved.title);
      if (saved.transition) setTransition(saved.transition);
      if (typeof saved.coldOpen === "boolean") setColdOpen(saved.coldOpen);
      if (typeof saved.zoom === "boolean") setZoom(saved.zoom);
      if (saved.labels) {
        setSlots((current) =>
          current.map((slot) => ({ ...slot, label: saved.labels?.[String(slot.position)] ?? slot.label })),
        );
      }
    } catch {
      // Un almacén corrupto no puede impedir usar el panel.
    }
  }, []);

  useEffect(() => {
    const labels = Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label]));
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ title, transition, coldOpen, zoom, labels }));
    } catch {
      // Sin espacio o en modo privado: seguir, el estado vive en el servidor igual.
    }
  }, [slots, title, transition, coldOpen, zoom]);

  // Los valores no editables (tamaños de rótulo, colores, CTA…) los manda el motor en
  // su listado: así la vista previa en vivo usa los **mismos números** que el render.
  const settingsMap = useMemo(
    () => Object.fromEntries((preset?.settings ?? []).map((setting) => [setting.key, setting.value])),
    [preset],
  );
  const labelMap = useMemo(
    () => Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label.trim()])),
    [slots],
  );

  // El render del motor (FFmpeg) no es instantáneo: se pide solo al pulsar, para
  // comprobar el resultado exacto; mientras se ajusta manda la vista en vivo.
  const pedirRender = useCallback(() => {
    const params = new URLSearchParams({ title: title.trim() });
    for (const slot of slots) params.set(`label${slot.position}`, slot.label.trim());
    if (style) params.set("style", JSON.stringify(style));
    setPreviewFailed(false);
    setRenderUrl(`/api/preview?${params.toString()}&t=${Date.now()}`);
    setPreviewMode("render");
  }, [title, slots, style]);

  const setSlot = useCallback((position: number, patch: Partial<Slot>) => {
    setSlots((current) => current.map((slot) => (slot.position === position ? { ...slot, ...patch } : slot)));
  }, []);

  const onPick = useCallback(
    (position: number, file: File | null) => {
      setSlot(position, { file, label: file ? labelFromFilename(file.name) || "" : "" });
    },
    [setSlot],
  );

  const problems = problemList(slots, title);

  const patchStyle = useCallback((patch: StylePatch) => {
    setStyle((current) =>
      current
        ? {
            font: patch.font ?? current.font,
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

      const chosen = TRANSITIONS.find((option) => option.key === transition) ?? TRANSITIONS[0];
      const labels = Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label.trim()]));
      const started = await fetch(`/api/jobs/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          labels,
          transitionSeconds: chosen.seconds,
          transition: chosen.type,
          coldOpenSeconds: coldOpen ? 2 : 0,
          zoom: zoom ? 0.08 : 0,
        }),
      });
      if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo arrancar el montaje.");

      await poll(created.id, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Algo falló. Vuelve a intentarlo.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }, [slots, title, transition, coldOpen, zoom, poll]);

  const reintentar = useCallback(async () => {
    if (!job) {
      await montar();
      return;
    }
    const token = ++runToken.current;
    setBusy(true);
    setError(null);
    try {
      const chosen = TRANSITIONS.find((option) => option.key === transition) ?? TRANSITIONS[0];
      const labels = Object.fromEntries(slots.map((slot) => [String(slot.position), slot.label.trim()]));
      const started = await fetch(`/api/jobs/${job.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          labels,
          transitionSeconds: chosen.seconds,
          transition: chosen.type,
          coldOpenSeconds: coldOpen ? 2 : 0,
          zoom: zoom ? 0.08 : 0,
        }),
      });
      if (!started.ok) throw new Error((await started.json())?.error ?? "No se pudo reintentar.");
      await poll(job.id, token);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Algo falló al reintentar.");
    } finally {
      if (runToken.current === token) setBusy(false);
    }
  }, [job, slots, title, transition, coldOpen, zoom, poll, montar]);

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
  const etaRatio = etaFromMeasurement ?? job?.etaSeconds ?? null;
  const spread = etaRatio !== null && elapsed !== null && elapsed > 0 ? etaRatio / (etaRatio + elapsed) : 0.5;

  const ranking = job?.artifacts.find((artifact) => artifact.path === "ranking.mp4");
  const cover = job?.artifacts.find((artifact) => artifact.path === "cover.jpg");
  const fileUrl = (path: string) => `/api/jobs/${job?.id}/files?path=${encodeURIComponent(path)}`;

  // Móvil con la vista previa dentro: en vivo (instantánea) o el render exacto del motor.
  const previewPanel = (
    <>
      <Phone>
        {previewMode === "render" && renderUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="phone-screen"
            src={renderUrl}
            alt="Render exacto del overlay sobre fondo negro"
            onError={() => setPreviewFailed(true)}
          />
        ) : style ? (
          <LivePreview style={style} title={title} labels={labelMap} settings={settingsMap} />
        ) : (
          <div className="phone-screen empty">Preparando…</div>
        )}
      </Phone>
      {previewFailed ? (
        <div className="alert error" role="alert">
          No se pudo dibujar el render exacto del motor.
        </div>
      ) : null}
      <div className="preview-switch">
        <button
          type="button"
          className={previewMode === "live" ? "primary" : "secondary"}
          onClick={() => setPreviewMode("live")}
        >
          En vivo
        </button>
        <button type="button" className={previewMode === "render" ? "primary" : "secondary"} onClick={pedirRender} disabled={!style}>
          Render exacto
        </button>
      </div>
    </>
  );

  return (
    <main className="shell">
      <header className="top">
        <div className="top-row">
          <div>
            <h1>openRanks · montar un TOP 5</h1>
            <p>
              Sube cinco clips y escribe dos cosas: el título y el nombre de cada puesto. El montaje —orden, unión,
              transiciones y edición— es automático.
            </p>
          </div>
          <button className="secondary" type="button" onClick={() => setDrawerOpen(true)}>
            Plantilla
          </button>
        </div>
      </header>

      <div className="layout">
        <div>
          <section className="card">
            <h2>
              <span className="step">1</span>Tus cinco clips
            </h2>
            <p className="hint">
              El orden es el del vídeo: el <strong>#5</strong> abre y el <strong>#1</strong> cierra, que es el mejor.
              Los clips se dan por buenos: se encajan <strong>enteros, sin recortar</strong>, a 9:16 y 30 fps, con el
              audio normalizado.
            </p>
            {slots.map((slot) => (
              <div className="slot" key={slot.position}>
                <div className="rank">
                  <div className="num">#{slot.position}</div>
                  <div className="when">{slot.position === 5 ? "abre" : slot.position === 1 ? "cierra" : ""}</div>
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
            <h2>
              <span className="step">3</span>El montaje
            </h2>
            <p className="hint">El estilo está fijado por el preset: solo eliges el tipo de corte y dos extras.</p>
            <div className="options">
              <div>
                <label className="field" htmlFor="transition">
                  Transición entre clips
                </label>
                <select
                  id="transition"
                  value={transition}
                  disabled={running}
                  onChange={(event) => setTransition(event.target.value)}
                >
                  {TRANSITIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <label>
                <input type="checkbox" checked={zoom} disabled={running} onChange={(e) => setZoom(e.target.checked)} />
                Zoom de entrada en el primer clip
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={coldOpen}
                  disabled={running}
                  onChange={(e) => setColdOpen(e.target.checked)}
                />
                Arrancar con 2 s del #1 (gancho)
              </label>
            </div>

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
            <h2>Vista previa de la plantilla</h2>
            <p className="hint">
              El motor dibuja el texto sobre <strong>fondo negro</strong> antes de montar: es exactamente el overlay
              que llevará el vídeo.
            </p>
            {previewFailed ? (
              <div className="alert error" role="alert">
                No se pudo dibujar la vista previa.
              </div>
            ) : null}
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

          <section className="card">
            <h2>Plantilla de la edición</h2>
            <p className="hint">
              Así está configurado el texto que va sobre el vídeo. Puedes ajustar el tamaño, la posición y la fuente
              en el menú lateral, con la vista previa sobre negro; se guarda la <strong>última plantilla</strong>.
            </p>
            <div className="actions">
              <button className="secondary" type="button" onClick={() => setDrawerOpen(true)}>
                Ajustar la plantilla
              </button>
              {preset?.hasSaved ? <span className="hint">Usando tu plantilla guardada.</span> : null}
            </div>
            {presetError ? <div className="alert error">{presetError}</div> : null}
            {preset ? (
              <details className="preset" open>
                <summary>
                  {preset.preset} · fuente {preset.font}
                </summary>
                <p className="hint where">{preset.where}</p>
                {groupSettings(preset.settings).map(([group, rows]) => (
                  <div key={group}>
                    <h3>{group}</h3>
                    <table className="preset-table">
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.key}>
                            <th scope="row">{row.key}</th>
                            <td className="value">{formatSetting(row.value)}</td>
                            <td className="what">{row.what}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </details>
            ) : (
              !presetError && <p className="hint">Leyendo la plantilla…</p>
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
                      <p className="hint">La vista previa ya muestra los cambios; guarda para que el montaje los use.</p>
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
                <p className="hint center">Se actualiza al instante; «Render exacto» pide el overlay al motor.</p>
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
  const { font, title, rank_ladder } = value;
  return [font, title.size, title.background, rank_ladder.size, rank_ladder.x, rank_ladder.y_top, rank_ladder.y_bottom].join("|");
}

/** Móvil: el marco es decorativo, dentro va la vista previa (en vivo o el render). */
function Phone({ children }: { children: ReactNode }) {
  return (
    <div className="phone">
      <span className="phone-notch" aria-hidden="true" />
      <div className="phone-stage">{children}</div>
    </div>
  );
}

function settingNumber(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" ? value : fallback;
}

function settingString(settings: Record<string, unknown>, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : fallback;
}

/**
 * La plantilla dibujada **en vivo** en el navegador.
 *
 * Todos los números (tamaños, posiciones, colores, medallas) vienen del propio motor —
 * los editables del panel y el resto del listado de `/api/preset` — y se pintan sobre
 * un lienzo de 1080x1920, así que un deslizador se ve al instante. La única fórmula
 * replicada es la de `badge_y()` (`openranks/core/specs.py`).
 */
function LivePreview({
  style,
  title,
  labels,
  settings,
}: {
  style: EditablePreset;
  title: string;
  labels: Record<string, string>;
  settings: Record<string, unknown>;
}) {
  const titleRef = useRef<SVGTextElement | null>(null);
  const [titleWidth, setTitleWidth] = useState(0);

  const ladder = style.rank_ladder;
  const slots = settingNumber(settings, "rank_ladder.slots", 5);
  const dx = settingNumber(settings, "clip_label.dx", 132);
  const titleY = settingNumber(settings, "title.y", 168);
  const titleStroke = settingNumber(settings, "title.stroke_px", 9);
  const bgPad = settingNumber(settings, "title.bg_pad", 26);
  const badgeStroke = settingNumber(settings, "rank_ladder.stroke_px", 10);
  const labelSize = settingNumber(settings, "clip_label.size", 64);
  const labelStroke = settingNumber(settings, "clip_label.stroke_px", 8);
  const ctaY = settingNumber(settings, "cta.y", 1610);
  const ctaSize = settingNumber(settings, "cta.size", 58);
  const ctaText = settingString(settings, "cta.text", "");
  const baseColor = settingString(settings, "title.color", "#FFFFFF");
  const accent = settingString(settings, "title.accent", "#FFD60A");
  const accentBlue = settingString(settings, "title.accent_blue", "#3B82F6");
  const colours = (settings["rank_colors"] ?? {}) as Record<string, string>;
  const medals = (settings["rank_ladder.medals"] ?? {}) as Record<string, string>;

  const spans = titleSpans(title);
  const boxed = style.title.background;

  // El ancho real del texto mide la caja negra del título (igual que hace libass).
  useLayoutEffect(() => {
    setTitleWidth(titleRef.current?.getBBox().width ?? 0);
  }, [title, style.title.size, style.font, boxed]);

  // Igual que `badge_y()`: #5 abajo, #1 arriba.
  const badgeY = (position: number): number => {
    if (slots <= 1) return ladder.y_bottom;
    const index = slots - position;
    return ladder.y_bottom - (ladder.y_bottom - ladder.y_top) * (index / (slots - 1));
  };

  return (
    <svg
      className="phone-screen"
      viewBox="0 0 1080 1920"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Vista previa de la plantilla sobre fondo negro"
    >
      <rect x="0" y="0" width="1080" height="1920" fill="#000000" />

      {boxed && titleWidth > 0 ? (
        <rect
          x={540 - titleWidth / 2 - bgPad}
          y={titleY - (style.title.size * 1.4) / 2}
          width={titleWidth + bgPad * 2}
          height={style.title.size * 1.4}
          fill="#000000"
        />
      ) : null}

      <text
        ref={titleRef}
        x={540}
        y={titleY}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={style.font}
        fontWeight={800}
        fontSize={style.title.size}
        fill={baseColor}
        stroke="#000000"
        strokeWidth={titleStroke}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {spans.map((span, index) => (
          <tspan
            key={index}
            fill={span.color === "yellow" ? accent : span.color === "blue" ? accentBlue : baseColor}
            fontSize={span.scale === 1 ? undefined : style.title.size * span.scale}
          >
            {span.text}
          </tspan>
        ))}
      </text>

      {LIMITS.positions.map((position) => (
        <Fragment key={position}>
          <text
            x={ladder.x}
            y={badgeY(position)}
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily={style.font}
            fontWeight={800}
            fontSize={ladder.size}
            fill={colours[String(position)] ?? "#3B82F6"}
            stroke="#000000"
            strokeWidth={badgeStroke}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {medals[String(position)] ?? String(position)}
          </text>
          <text
            x={ladder.x + dx}
            y={badgeY(position)}
            textAnchor="start"
            dominantBaseline="central"
            fontFamily={style.font}
            fontWeight={700}
            fontSize={labelSize}
            fill="#FFFFFF"
            stroke="#000000"
            strokeWidth={labelStroke}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {labels[String(position)] ?? ""}
          </text>
        </Fragment>
      ))}

      <text
        x={540}
        y={ctaY}
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily={style.font}
        fontWeight={700}
        fontSize={ctaSize}
        fill="#FFFFFF"
        stroke="#000000"
        strokeWidth={7}
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        {ctaText}
      </text>
    </svg>
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

/** Agrupa los ajustes del preset para pintarlos por secciones. */
function groupSettings(settings: PresetSetting[]): [string, PresetSetting[]][] {
  const groups = new Map<string, PresetSetting[]>();
  for (const setting of settings) {
    const list = groups.get(setting.group) ?? [];
    list.push(setting);
    groups.set(setting.group, list);
  }
  return [...groups.entries()];
}

function formatSetting(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Reúne los problemas del formulario con el mismo límite que valida el motor (§9.5). */
function problemList(slots: Slot[], title: string): string[] {
  const list: string[] = [];
  if (!slots.every((slot) => slot.file)) list.push("Sube los cinco clips.");
  list.push(...titleErrors(title));
  for (const slot of slots) list.push(...labelErrors(slot.position, slot.label));
  return list;
}
