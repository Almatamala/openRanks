"use client";

import { useCallback, useEffect, useState } from "react";

import type { KeyStatus, LlmProvider, SettingsSnapshot } from "@/lib/api-keys";

/**
 * Ajustes del panel (RF-22, P3-10): guarda la clave de Claude o la de Gemini en el
 * servidor y elige cuál se usa para el score con LLM.
 *
 * La vista explica sin rodeos dónde actúa la clave: **solo en «Puntuar galería»**, donde
 * el LLM pone score y título a los clips ya cortados. El divisor de escenas no usa la
 * clave: cortar y puntuar son procesos separados. Sin clave no hay score ni títulos.
 */

const PROVIDERS: {
  id: LlmProvider;
  title: string;
  keyLabel: string;
  placeholder: string;
}[] = [
  {
    id: "claude",
    title: "Claude (Anthropic)",
    keyLabel: "Clave de la API de Claude",
    placeholder: "sk-ant-…",
  },
  {
    id: "gemini",
    title: "Gemini (Google)",
    keyLabel: "Clave de la API de Gemini",
    placeholder: "AIza…",
  },
];

function statusText(status: KeyStatus | undefined): string {
  if (!status?.configured) return "Sin clave";
  if (status.source === "panel") {
    return "Guardada en el panel";
  }
  return "Definida en el entorno del panel";
}

export default function Settings({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("claude");
  const [draft, setDraft] = useState<Record<LlmProvider, string>>({
    claude: "",
    gemini: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const data = (await response.json()) as SettingsSnapshot & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudieron leer los ajustes.");
      setSnapshot(data);
      setProvider(data.activeProvider ?? data.provider ?? "claude");
      setError(null);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "No se pudieron leer los ajustes.",
      );
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const post = useCallback(
    async (body: Record<string, unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => null)) as
          | (SettingsSnapshot & { error?: string })
          | null;
        if (!response.ok || !payload || typeof payload !== "object") {
          throw new Error(payload?.error ?? "No se pudieron guardar los ajustes.");
        }
        setSnapshot(payload);
        setProvider(payload.activeProvider ?? payload.provider ?? "claude");
        setDraft({ claude: "", gemini: "" });
        setNotice(message);
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "No se pudieron guardar los ajustes.",
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const save = useCallback(() => {
    const body: Record<string, unknown> = {};
    for (const item of PROVIDERS) {
      if (draft[item.id].trim()) body[item.id] = draft[item.id];
    }
    // Solo se pide un proveedor cuando hay con qué puntuar: el que ya tiene clave o el
    // que se acaba de pegar. Guardar una clave no obliga a tener también la otra.
    if (snapshot?.keys[provider]?.source === "panel" || draft[provider].trim()) {
      body.provider = provider;
    }
    void post(body, "Claves guardadas. Se usarán en el próximo análisis.");
  }, [draft, post, provider, snapshot]);

  const removeKey = useCallback(
    (target: LlmProvider) => {
      const item = PROVIDERS.find((entry) => entry.id === target);
      const confirmed = window.confirm(
        `¿Quitar la clave de ${item?.title ?? target} del panel? El score con ese proveedor dejará de estar disponible.`,
      );
      if (!confirmed) return;
      void post(
        { remove: [target] },
        `Clave de ${item?.title ?? target} eliminada del panel.`,
      );
    },
    [post],
  );

  const activeLabel =
    PROVIDERS.find((entry) => entry.id === snapshot?.activeProvider)?.title ?? null;

  return (
    <div className="settings-grid">
      <section className="card">
        <h2>Claves del score con IA</h2>
        <p className="hint">
          Se guardan en el servidor del panel y no vuelven al navegador: aquí solo se ve
          que hay una clave guardada. Las claves que ya vengan en el entorno del panel se
          usan solas; guarda una aquí para poder elegir proveedor. Sin clave no hay score:
          «Puntuar galería» deja los clips sin puntuar. Dividir escenas, en cambio, sigue
          funcionando sin clave, porque solo corta y no puntúa.
        </p>

        <div className="settings-provider" role="radiogroup" aria-label="Proveedor del score">
          <p className="field">¿Con qué clave se puntúa?</p>
          {PROVIDERS.map((item) => {
            const status = snapshot?.keys[item.id];
            return (
              <label className="settings-option" key={item.id}>
                <input
                  type="radio"
                  name="llm-provider"
                  value={item.id}
                  checked={provider === item.id}
                  disabled={busy || status?.source !== "panel"}
                  onChange={() => setProvider(item.id)}
                />
                <span>{item.title}</span>
                <span className="settings-option-note">{statusText(status)}</span>
              </label>
            );
          })}
        </div>

        {PROVIDERS.map((item) => {
          const status = snapshot?.keys[item.id];
          return (
            <div className="control" key={item.id}>
              <label className="field" htmlFor={`key-${item.id}`}>
                {item.keyLabel}
              </label>
              <div className="field-row">
                <input
                  id={`key-${item.id}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  placeholder={
                    status?.configured
                      ? "Pega una clave nueva para reemplazarla"
                      : item.placeholder
                  }
                  value={draft[item.id]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                />
                {status?.source === "panel" ? (
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => removeKey(item.id)}
                  >
                    Quitar
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}

        <div className="actions">
          <button className="primary" type="button" disabled={busy} onClick={save}>
            {busy ? "Guardando…" : "Guardar claves"}
          </button>
        </div>

        <p className="settings-status">
          {snapshot?.activeProvider && activeLabel ? (
            <>
              <strong>En uso: {activeLabel}</strong> · modelo{" "}
              {snapshot.model ?? "por defecto del proveedor"} · sin tope de coste por
              trabajo.
            </>
          ) : (
            <>
              <strong>Sin clave:</strong> «Puntuar galería» no funciona y los clips se quedan sin
              score ni título hasta que guardes una.
            </>
          )}
        </p>

        {notice ? (
          <div className="alert ok" role="status">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="alert error" role="alert">
            {error}
          </div>
        ) : null}
      </section>

    </div>
  );
}
