"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  EMPTY_DECLARATION,
  formatBytes,
  parseLink,
  platformLabel,
  sourceProblems,
  type DeclarationField,
  type DeclarationProblem,
  type SourceDeclaration,
} from "@/lib/extract";
import { extensionOf } from "@/lib/gallery";

/** Lo que el panel sabe del descargador (`/api/extract`); nunca su ruta. */
type Downloader = {
  ready: boolean;
  version: string | null;
  source: string | null;
  hint: string | null;
};

/** Un tramo propuesto por el análisis (P3-3), con la decisión del operador. */
type Candidate = {
  /** Identidad estable: no cambia al dividir o unir el tramo. */
  id: string;
  /** Número de la parrilla (1..n), renumerado tras cada corrección. */
  index: number;
  start: number;
  end: number;
  duration: number;
  /** Miniatura del análisis que ilustra el tramo. */
  thumb: number;
  thumbnail: string;
  verdict: "pending" | "approved" | "discarded";
  /** Huella perceptual del fotograma central: planos repetidos. */
  phash: string | null;
  /** Número de la escena anterior que repite el mismo plano, si lo hay. */
  duplicateOf: number | null;
};

/** La extracción en curso (o terminada), tal como la devuelve la API. */
type Extraction = {
  id: string;
  state: "downloading" | "analyzing" | "done" | "failed" | "cancelled";
  phase: string;
  progress: number;
  download: {
    percent: number;
    bytes: number | null;
    totalBytes: number | null;
    speed: string | null;
    eta: string | null;
  } | null;
  /** De dónde salió: un enlace (URL) o un vídeo local (URL vacía). */
  source: { url: string; platform: string | null };
  error: string | null;
  file: { name: string; bytes: number } | null;
  limits: { maxMinutes: number; maxMB: number };
  candidates?: Candidate[] | null;
  warnings?: string[];
};

/** Tiempo de reloj (`m:ss`) para la parrilla de candidatos. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Duración de un tramo, en segundos y con coma decimal. */
function durationLabel(seconds: number): string {
  return `${seconds.toFixed(1).replace(".", ",")} s`;
}

const MODES = [
  { id: "link", label: "Enlace de YouTube o TikTok" },
  { id: "file", label: "Archivo local" },
] as const;

type Mode = (typeof MODES)[number]["id"];

/** Cada cuánto se pregunta por el avance: la descarga ya publica su propio porcentaje. */
const POLL_MS = 1000;

const TERMS_LABEL = "Confirmo que cumplo los términos de la plataforma y la política de privacidad.";
const TERMS_PROBLEM = "Marca que cumples los términos de la plataforma y la política de privacidad.";

/** Los mismos formatos que la galería: el vídeo local se sube tal cual. */
const FILE_FORMATS = "MP4, MOV, MKV, WEBM, M4V y AVI";
const FILE_MAX_MB = 2048;

/**
 * Extraer clips (F3 · P3-1 y P3-2): la entrada de material de la extractora. Un enlace o un
 * vídeo completo del equipo, la casilla de cumplimiento justo debajo y, si el panel puede
 * trabajar, el avance real con su botón de cancelar.
 *
 * Las dos entradas acaban en el **área temporal** (`extract/<id>/source.*`), nunca en la
 * galería: solo los tramos aprobados lo harán cuando exista la revisión (P3-4).
 */
export default function Extract({
  onOpenGallery,
  onApproved,
}: {
  onOpenGallery: () => void;
  onApproved: () => void;
}) {
  const [mode, setMode] = useState<Mode>("link");
  const [declaration, setDeclaration] = useState<SourceDeclaration>(EMPTY_DECLARATION);
  const [touched, setTouched] = useState<Partial<Record<DeclarationField, boolean>>>({});
  const [downloader, setDownloader] = useState<Downloader | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // «Archivo local»: el vídeo completo elegido, que se sube al área temporal.
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvedMessage, setApprovedMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Último fotograma de cada tramo: es donde «Dividir» corta el vídeo.
  const playheads = useRef<Record<string, number>>({});

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const response = await fetch("/api/extract", { cache: "no-store" });
      if (!response.ok) throw new Error("sin respuesta");
      const data = (await response.json()) as {
        downloader?: Downloader;
        current?: Extraction | null;
      };
      if (!data.downloader) throw new Error("sin datos");
      setDownloader(data.downloader);
      // Una descarga que ya estaba en marcha (otra pestaña, o el panel recargado) se
      // retoma aquí: si no, el operador no tendría forma de verla ni de cancelarla.
      if (data.current) setExtraction(data.current);
    } catch {
      setDownloader(null);
      setStatusError("No se pudo comprobar la herramienta de descarga.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // La casilla de cumplimiento se firma en las dos entradas; el enlace solo se exige en
  // la suya, para que elegir un archivo no arrastre un error de URL.
  const problems: DeclarationProblem[] =
    mode === "file"
      ? declaration.terms
        ? []
        : [{ field: "terms", message: TERMS_PROBLEM }]
      : sourceProblems(declaration);
  const link = parseLink(declaration.url);
  const platform = platformLabel(link.platform);
  const busy = starting || extraction?.state === "downloading";
  const ready =
    problems.length === 0 && !busy && (mode === "file" ? file !== null : downloader?.ready === true);

  const update = (patch: Partial<SourceDeclaration>) =>
    setDeclaration((current) => ({ ...current, ...patch }));
  const touch = (field: DeclarationField) =>
    setTouched((current) => ({ ...current, [field]: true }));
  // Antes de tocar un campo no se le pone en rojo: el aviso llega al salir de él.
  const shownProblem = (field: DeclarationField) => {
    const empty = declaration[field] === "" || declaration[field] === false;
    if (!touched[field] && empty) return null;
    return problems.find((problem) => problem.field === field)?.message ?? null;
  };

  const blocker =
    mode === "file"
      ? problems.length > 0
        ? "Marca la casilla para poder extraer."
        : file === null
          ? "Elige el vídeo completo del que saldrán los clips."
          : ""
      : problems.length > 0
        ? "Pega el enlace y marca la casilla para poder extraer."
        : downloader === null
          ? "Comprobando la herramienta de descarga…"
          : !downloader.ready
            ? "Sin yt-dlp no se puede descargar el vídeo."
            : "";

  const start = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setActionError(null);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(declaration),
      });
      const payload = (await response.json().catch(() => null)) as {
        extraction?: Extraction;
        error?: string;
      } | null;
      if (!response.ok || !payload?.extraction) {
        throw new Error(payload?.error ?? "No se pudo empezar la descarga. Vuelve a intentarlo.");
      }
      setExtraction(payload.extraction);
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : "No se pudo empezar la descarga.",
      );
    } finally {
      setStarting(false);
    }
  }, [declaration, starting]);

  /** Valida el vídeo antes de subir un solo byte: formato y tope de tamaño. */
  const pickFile = useCallback((chosen: File | null) => {
    setFileError(null);
    if (!chosen) return;
    if (!extensionOf(chosen.name)) {
      setFileError(`Ese formato no es válido. Acepta ${FILE_FORMATS}.`);
      return;
    }
    if (chosen.size > FILE_MAX_MB * 1024 * 1024) {
      setFileError(`El vídeo pasa de ${FILE_MAX_MB} MB: elige uno más pequeño.`);
      return;
    }
    setFile(chosen);
  }, []);

  const startUpload = useCallback(async () => {
    if (!file || starting) return;
    setStarting(true);
    setActionError(null);
    try {
      const params = new URLSearchParams({
        name: file.name,
        terms: declaration.terms ? "1" : "0",
      });
      const response = await fetch(`/api/extract/local?${params.toString()}`, {
        method: "POST",
        body: file,
      });
      const payload = (await response.json().catch(() => null)) as {
        extraction?: Extraction;
        error?: string;
      } | null;
      if (!response.ok || !payload?.extraction) {
        throw new Error(payload?.error ?? "No se pudo subir el vídeo. Vuelve a intentarlo.");
      }
      setExtraction(payload.extraction);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "No se pudo subir el vídeo.");
    } finally {
      setStarting(false);
    }
  }, [declaration.terms, file, starting]);

  // El servidor es quien tiene el estado: se le pregunta mientras la descarga corre.
  const track = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/extract/${id}`, { cache: "no-store" });
      if (response.status === 404) {
        setExtraction(null);
        return;
      }
      if (!response.ok) return;
      const payload = (await response.json()) as { extraction?: Extraction };
      if (payload.extraction) setExtraction(payload.extraction);
    } catch {
      // Un fallo de red suelto no corta la descarga: se vuelve a preguntar.
    }
  }, []);

  // La descarga y el análisis publican su estado en el trabajo: se sondea mientras
  // cualquiera de los dos está en marcha.
  const liveId =
    extraction?.state === "downloading" || extraction?.state === "analyzing"
      ? extraction.id
      : null;
  useEffect(() => {
    if (!liveId) return;
    const timer = setInterval(() => void track(liveId), POLL_MS);
    return () => clearInterval(timer);
  }, [liveId, track]);

  const discard = useCallback(async () => {
    if (!extraction) return;
    const id = extraction.id;
    setActionError(null);
    try {
      const response = await fetch(`/api/extract/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("sin respuesta");
      setExtraction(null);
    } catch {
      setActionError("No se pudo descartar la extracción. Vuelve a intentarlo.");
    }
  }, [extraction]);

  // «Analizar las escenas»: una pasada sin recodificar; el servidor responde con el
  // trabajo ya en marcha y el sondeo trae los candidatos al terminar.
  const analyze = useCallback(async () => {
    if (!extraction || starting) return;
    setStarting(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/extract/${extraction.id}/analyze`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as {
        extraction?: Extraction;
        error?: string;
      } | null;
      if (!response.ok || !payload?.extraction) {
        throw new Error(
          payload?.error ?? "No se pudo dividir el vídeo en escenas. Vuelve a intentarlo.",
        );
      }
      setExtraction(payload.extraction);
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "No se pudo dividir el vídeo en escenas.",
      );
    } finally {
      setStarting(false);
    }
  }, [extraction, starting]);

  // Dividir, unir o aprobar todos: el servidor reescribe los tramos y devuelve el trabajo
  // entero, así que la parrilla se repinta con lo que de verdad quedó guardado.
  const changeCandidates = useCallback(
    async (body: Record<string, unknown>, busyIndex: number | null) => {
      if (!extraction || reviewing !== null || bulkBusy) return;
      if (busyIndex === null) setBulkBusy(true);
      else setReviewing(busyIndex);
      setActionError(null);
      try {
        const response = await fetch(`/api/extract/${extraction.id}/candidates`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => null)) as {
          extraction?: Extraction;
          error?: string;
        } | null;
        if (!response.ok || !payload?.extraction) {
          throw new Error(payload?.error ?? "No se pudo guardar la decisión.");
        }
        setExtraction(payload.extraction);
      } catch (failure) {
        setActionError(
          failure instanceof Error ? failure.message : "No se pudo guardar la decisión.",
        );
      } finally {
        setReviewing(null);
        setBulkBusy(false);
      }
    },
    [bulkBusy, extraction, reviewing],
  );

  // Aprobar, descartar o devolver un tramo a «pendiente». La decisión la guarda el
  // servidor en el trabajo, así que sobrevive a recargar el panel.
  const review = useCallback(
    (candidate: Candidate, verdict: Candidate["verdict"]) =>
      changeCandidates({ id: candidate.id, verdict }, candidate.index),
    [changeCandidates],
  );

  // Un corte mal hecho: se parte por el fotograma que está viendo el operador y, si no
  // movió el vídeo, por la mitad. El servidor exige medio segundo a cada lado.
  const split = useCallback(
    (candidate: Candidate) => {
      const playhead = playheads.current[candidate.id];
      const inside =
        typeof playhead === "number" &&
        playhead >= candidate.start + 0.5 &&
        playhead <= candidate.end - 0.5
          ? playhead
          : (candidate.start + candidate.end) / 2;
      return changeCandidates({ action: "split", id: candidate.id, at: inside }, candidate.index);
    },
    [changeCandidates],
  );

  // Dos tramos que en realidad eran una escena: se une el tramo con el siguiente.
  const merge = useCallback(
    (candidate: Candidate) =>
      changeCandidates({ action: "merge", id: candidate.id }, candidate.index),
    [changeCandidates],
  );

  // «Aprobar todos»: la misma decisión para la parrilla entera en una sola petición.
  const approveAll = useCallback(
    () => changeCandidates({ action: "verdict-all", verdict: "approved" }, null),
    [changeCandidates],
  );

  // «Extraer aprobados a la galería» (P3-4): el servidor recorta cada tramo, lo da de
  // alta con su procedencia y borra el temporal. Los ya existentes se reutilizan.
  const approve = useCallback(async () => {
    if (!extraction || approving) return;
    setApproving(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/extract/${extraction.id}/approve`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as {
        items?: unknown[];
        reused?: number;
        error?: string;
      } | null;
      if (!response.ok || !payload?.items) {
        throw new Error(
          payload?.error ?? "No se pudieron añadir las escenas a la galería.",
        );
      }
      const count = payload.items.length;
      setApprovedMessage(
        count === 0
          ? "No se extrajo ningún tramo."
          : `${count} ${count === 1 ? "clip" : "clips"} en la galería${
              payload.reused ? ` · ${payload.reused} ya existían y se reutilizaron` : ""
            }.`,
      );
      setExtraction(null);
      setFile(null);
      onApproved();
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "No se pudieron añadir las escenas a la galería.",
      );
    } finally {
      setApproving(false);
    }
  }, [approving, extraction, onApproved]);

  const detail = extraction?.download;
  const progressDetail = [
    `${extraction?.progress ?? 0} %`,
    detail?.totalBytes ? `${formatBytes(detail.bytes)} de ${formatBytes(detail.totalBytes)}` : "",
    detail?.speed ? detail.speed : "",
    detail?.eta ? `quedan ${detail.eta}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const isLocalSource = extraction?.source.url === "";

  const candidates = extraction?.candidates ?? [];
  const approved = candidates.filter((candidate) => candidate.verdict === "approved").length;
  const reviewPanel = (
    <div className="candidates">
      <div className="candidates-head">
        <h3>Escenas propuestas</h3>
        <p className="hint">
          {candidates.length} escenas · {approved} aprobadas
        </p>
      </div>
      {(extraction?.warnings ?? []).map((warning) => (
        <p className="hint candidate-warning" key={warning}>
          {warning}
        </p>
      ))}
      <ul className="candidate-grid">
        {candidates.map((candidate) => (
          <li key={candidate.id} className={`candidate ${candidate.verdict}`}>
            {/* El tramo se reproduce del propio vídeo temporal, acotado a su ventana:
                la miniatura del análisis hace de póster y al arrancar salta al inicio. */}
            <video
              className="candidate-thumb"
              src={`/api/extract/${extraction?.id}/source`}
              poster={`/api/extract/${extraction?.id}/thumb?index=${candidate.thumb}`}
              controls
              playsInline
              preload="metadata"
              aria-label={`Escena ${candidate.index}: reproducir del ${clock(candidate.start)} al ${clock(candidate.end)}`}
              onLoadedMetadata={(event) => {
                event.currentTarget.currentTime = candidate.start;
              }}
              onPlay={(event) => {
                const video = event.currentTarget;
                if (video.currentTime < candidate.start || video.currentTime >= candidate.end) {
                  video.currentTime = candidate.start;
                }
              }}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                // El fotograma que se está viendo es el punto de corte de «Dividir».
                playheads.current[candidate.id] = video.currentTime;
                if (video.currentTime >= candidate.end) video.pause();
              }}
              onSeeking={(event) => {
                // Los controles permiten arrastrar fuera del tramo: se devuelve al inicio.
                const video = event.currentTarget;
                if (video.currentTime < candidate.start || video.currentTime > candidate.end) {
                  video.currentTime = candidate.start;
                }
              }}
            />
            <p className="candidate-title">#{candidate.index}</p>
            <p className="hint candidate-meta">
              {clock(candidate.start)} – {clock(candidate.end)} · {durationLabel(candidate.duration)}
            </p>
            {candidate.duplicateOf !== null ? (
              <p className="hint candidate-duplicate">
                Mismo plano que la escena #{candidate.duplicateOf}
              </p>
            ) : null}
            <div className="candidate-actions">
              <button
                className="small secondary"
                type="button"
                disabled={reviewing !== null}
                aria-pressed={candidate.verdict === "approved"}
                onClick={() =>
                  void review(candidate, candidate.verdict === "approved" ? "pending" : "approved")
                }
              >
                {candidate.verdict === "approved" ? "Quitar" : "Aprobar"}
              </button>
              <button
                className="small secondary"
                type="button"
                disabled={reviewing !== null}
                aria-pressed={candidate.verdict === "discarded"}
                onClick={() =>
                  void review(
                    candidate,
                    candidate.verdict === "discarded" ? "pending" : "discarded",
                  )
                }
              >
                {candidate.verdict === "discarded" ? "Recuperar" : "Descartar"}
              </button>
              <button
                className="small secondary"
                type="button"
                disabled={reviewing !== null || bulkBusy}
                title="Divide este tramo en dos por el fotograma donde esté el vídeo"
                onClick={() => void split(candidate)}
              >
                Dividir
              </button>
              {candidate.index < candidates.length ? (
                <button
                  className="small secondary"
                  type="button"
                  disabled={reviewing !== null || bulkBusy}
                  title="Une este tramo con el siguiente: eran una sola escena"
                  onClick={() => void merge(candidate)}
                >
                  Unir con la siguiente
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="hint">
        Las escenas aprobadas se recortan del temporal y entran en la galería; al cerrar la
        revisión el vídeo original se borra. Si un corte salió mal, «Dividir» parte el tramo por
        el fotograma que estés viendo y «Unir con la siguiente» pega dos que eran una escena.
      </p>
      <div className="actions">
        <a
          className="button-link"
          href={`/api/extract/${extraction?.id}/source?download=1`}
          download
        >
          Descargar vídeo
        </a>
        <button
          className="primary"
          type="button"
          disabled={approved === 0 || approving}
          onClick={() => void approve()}
        >
          {approving
            ? "Añadiendo escenas…"
            : `Añadir escenas a la galería (${approved})`}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={bulkBusy || reviewing !== null || approved === candidates.length}
          onClick={() => void approveAll()}
        >
          {bulkBusy ? "Aprobando…" : "Aprobar todos"}
        </button>
        <button className="secondary" type="button" onClick={() => void discard()}>
          Descartar el vídeo y las escenas
        </button>
      </div>
    </div>
  );

  // Herramienta de descarga (modo enlace) o el recordatorio del vídeo local. Va arriba,
  // como el estado del motor en el montaje: el operador sabe con qué cuenta antes de nada.
  const toolPanel =
    mode === "link" ? (
      <>
        <h2>Herramienta de descarga</h2>
        {statusError ? (
          <div className="alert error" role="alert">
            <p>{statusError}</p>
            <div className="actions">
              <button className="secondary" type="button" onClick={() => void loadStatus()}>
                Volver a comprobar
              </button>
            </div>
          </div>
        ) : downloader === null ? (
          <p className="hint" role="status">
            <span className="spinner" aria-hidden="true" /> Comprobando si el panel puede
            descargar vídeos…
          </p>
        ) : downloader.ready ? (
          <p className="hint ok">
            yt-dlp {downloader.version ?? "instalado"} disponible
            {downloader.source ? ` · ${downloader.source}` : ""}. Límite por fuente:{" "}
            {extraction?.limits.maxMinutes ?? 60} min y {extraction?.limits.maxMB ?? 2048} MB,
            una extracción a la vez.
          </p>
        ) : (
          <div className="alert error" role="alert">
            <p>{downloader.hint ?? "Falta la herramienta de descarga."}</p>
            <div className="actions">
              <button className="secondary" type="button" onClick={() => void loadStatus()}>
                Volver a comprobar
              </button>
            </div>
          </div>
        )}
      </>
    ) : (
      <p className="hint">
        {file
          ? `${file.name} · ${formatBytes(file.size)}. Se sube al área temporal; de ahí saldrán las escenas.`
          : "El vídeo no se guarda en la galería: solo las escenas que apruebes lo harán."}
      </p>
    );

  const extractionPanel = (
    <>
      {extraction?.state === "downloading" ? (
        <div className="extract-run">
          <p className="hint" role="status" aria-live="polite">
            {extraction.phase}…
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-label="Avance de la extracción"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={extraction.progress}
          >
            <span style={{ width: `${Math.max(2, extraction.progress)}%` }} />
          </div>
          <p className="hint download-detail">{progressDetail}</p>
          <div className="actions">
            <button className="secondary" type="button" onClick={() => void discard()}>
              {isLocalSource ? "Cancelar la subida" : "Cancelar la descarga"}
            </button>
          </div>
        </div>
      ) : extraction?.state === "analyzing" ? (
        <div className="extract-run">
          <p className="hint" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" /> {extraction.phase}…
          </p>
          <div
            className="progress indeterminate"
            role="progressbar"
            aria-label="Avance del análisis"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={extraction.progress}
          >
            <span style={{ width: "35%" }} />
          </div>
          <p className="hint download-detail">
            Una pasada sin recodificar: solo los cambios de imagen y los negros.
          </p>
          <div className="actions">
            <button className="secondary" type="button" onClick={() => void discard()}>
              Cancelar la división
            </button>
          </div>
        </div>
      ) : extraction?.state === "done" ? (
        <>
          <div className="alert ok" role="status">
            <p>
              {isLocalSource
                ? `Vídeo completo listo · ${formatBytes(extraction.file?.bytes ?? null)}. Se queda en el área temporal para dividirlo en escenas; el original no entra en la galería.`
                : `Descarga lista · ${formatBytes(extraction.file?.bytes ?? null)}. El vídeo se queda en el área temporal y no entra en la galería.`}
            </p>
          </div>
          {extraction.candidates ? (
            reviewPanel
          ) : (
            <>
              <p className="hint">
                El vídeo ya está en el área temporal: descárgalo tal cual o divídelo en escenas
                de 1 a 30 s con una sola pasada, sin recodificar.
              </p>
              <div className="actions">
                <a
                  className="button-link primary"
                  href={`/api/extract/${extraction.id}/source?download=1`}
                  download
                >
                  Descargar vídeo
                </a>
                <button
                  className="primary"
                  type="button"
                  disabled={starting}
                  onClick={() => void analyze()}
                >
                  {starting ? "Dividiendo…" : "Dividir en escenas"}
                </button>
                <button className="secondary" type="button" onClick={() => void discard()}>
                  {isLocalSource ? "Descartar el vídeo" : "Descartar la descarga"}
                </button>
              </div>
            </>
          )}
        </>
      ) : extraction?.state === "failed" ? (
        <div className="alert error" role="alert">
          <p>{extraction.error ?? "La extracción se paró."}</p>
          <div className="actions">
            {extraction.file ? (
              <a
                className="button-link"
                href={`/api/extract/${extraction.id}/source?download=1`}
                download
              >
                Descargar vídeo
              </a>
            ) : null}
            <button
              className="secondary"
              type="button"
              disabled={starting}
              onClick={() =>
                void (extraction.file ? analyze() : mode === "file" ? startUpload() : start())
              }
            >
              {extraction.file ? "Volver a dividir" : "Reintentar"}
            </button>
            <button className="secondary" type="button" onClick={() => void discard()}>
              Descartar
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button
            className="primary"
            type="button"
            disabled={!ready}
            aria-describedby={blocker ? "extract-blocker" : undefined}
            title={blocker || undefined}
            onClick={() => void (mode === "file" ? startUpload() : start())}
          >
            {starting
              ? mode === "file"
                ? "Subiendo el vídeo…"
                : "Descargando el vídeo…"
              : mode === "file"
                ? "Subir vídeo"
                : "Descargar vídeo"}
          </button>
          {starting ? <span className="spinner" aria-hidden="true" /> : null}
          {blocker ? (
            <p className="hint extract-blocker" id="extract-blocker" role="status">
              {blocker}
            </p>
          ) : null}
        </div>
      )}

      {actionError ? (
        <div className="alert error" role="alert">
          {actionError}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="extract">
      <section className="card">
        {toolPanel}

        <div className="extract-modes" role="radiogroup" aria-label="Origen del material">
          {MODES.map((option) => (
            <label key={option.id} className="extract-mode">
              <input
                type="radio"
                name="source-mode"
                value={option.id}
                checked={mode === option.id}
                disabled={busy}
                onChange={() => setMode(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>

        {mode === "link" ? (
          <>
            <label className="field" htmlFor="source-url">
              Enlace del vídeo
            </label>
            <div className="extract-link">
              <input
                id="source-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={declaration.url}
                disabled={busy}
                aria-invalid={shownProblem("url") ? true : undefined}
                aria-describedby={shownProblem("url") ? "source-url-error" : undefined}
                onChange={(event) => update({ url: event.target.value })}
                onBlur={() => touch("url")}
              />
              {platform ? <span className="platform-pill">{platform}</span> : null}
            </div>
            {shownProblem("url") ? (
              <p className="field-error" id="source-url-error" role="alert">
                {shownProblem("url")}
              </p>
            ) : (
              <p className="hint extract-note">
                Una URL por extracción. Nada de vídeos privados ni con DRM.
              </p>
            )}
          </>
        ) : (
          <>
            <div
              className={`upload-drop ${dragActive ? "drag-over" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Subir el vídeo completo del que dividir las escenas"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInput.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                pickFile(event.dataTransfer?.files?.[0] ?? null);
              }}
            >
              <strong>{file ? file.name : "Arrastra el vídeo completo aquí"}</strong>
              <span>
                {file
                  ? `${formatBytes(file.size)} · pulsa para cambiarlo`
                  : `o pulsa para elegirlo · ${FILE_FORMATS} · hasta 2 GB`}
              </span>
            </div>
            <input
              ref={fileInput}
              className="slot-file-hidden"
              type="file"
              accept="video/*"
              aria-label="Vídeo completo del que extraer los clips"
              disabled={busy}
              onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
            />
            {fileError ? (
              <p className="field-error" role="alert">
                {fileError}
              </p>
            ) : (
              <p className="hint extract-note">
                Un vídeo completo por extracción: de ahí saldrán las escenas.
              </p>
            )}
          </>
        )}

        <label className="extract-check">
          <input
            type="checkbox"
            checked={declaration.terms}
            disabled={busy}
            aria-invalid={shownProblem("terms") ? true : undefined}
            aria-describedby={shownProblem("terms") ? "source-terms-error" : undefined}
            onChange={(event) => update({ terms: event.target.checked })}
            onBlur={() => touch("terms")}
          />
          <span>{TERMS_LABEL}</span>
        </label>
        {shownProblem("terms") ? (
          <p className="field-error" id="source-terms-error" role="alert">
            {shownProblem("terms")}
          </p>
        ) : null}

        {extractionPanel}

        {approvedMessage ? (
          <div className="alert ok" role="status">
            <p>{approvedMessage}</p>
            <div className="actions">
              <button className="primary" type="button" onClick={onOpenGallery}>
                Ir a la galería
              </button>
            </div>
          </div>
        ) : null}
      </section>

    </div>
  );
}
