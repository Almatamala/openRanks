import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HttpError } from "./http-error";
import { JOBS_DIR } from "./paths";

/**
 * Claves de API del score con LLM, guardadas desde **Configuración** (RF-22, P3-10).
 *
 * El motor (`openranks/core/llm.py`) ya sabía leer la clave del entorno; lo que faltaba
 * era poder dejarla puesta sin editar variables ni reiniciar la terminal. Este módulo
 * guarda **solo** la clave de Claude y la de Gemini en el volumen de trabajos y devuelve al panel un estado sin secretos: qué proveedor
 * está configurado, con qué modelo y si la clave es del panel o del entorno. La clave
 * completa no sale de aquí nunca.
 *
 * La regla de §10.3 cambia solo en un punto: la clave puede vivir en el volumen de
 * trabajos, nunca en el repo, ni en un manifiesto, ni en la respuesta de la API.
 */

export type LlmProvider = "claude" | "gemini";

export const LLM_PROVIDERS: readonly LlmProvider[] = ["claude", "gemini"];

/** Nombre legible del proveedor para los mensajes del panel. */
export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  claude: "Claude",
  gemini: "Gemini",
};

/**
 * Modelo por defecto de cada proveedor. Espeja `PROVIDER_DEFAULT_MODEL` de
 * `openranks/core/llm.py`; hay un test que comprueba que ambos no se separan.
 */
export const PROVIDER_MODEL: Record<LlmProvider, string> = {
  claude: "claude-haiku-5.5",
  gemini: "gemini-3.8-flash",
};

/** Nombre del proveedor en el cliente del motor (`core/llm.py`). */
const PROVIDER_ENGINE: Record<LlmProvider, string> = {
  claude: "anthropic",
  gemini: "gemini",
};

/** ¿El modelo es de este proveedor? Claude y Gemini no comparten prefijo. */
const MODEL_BELONGS: Record<LlmProvider, (model: string) => boolean> = {
  claude: (model) => model.startsWith("claude"),
  gemini: (model) => model.startsWith("gemini"),
};

/** Variables estándar de cada proveedor, para reconocer una clave del entorno. */
const PROVIDER_ENV_KEYS: Record<LlmProvider, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

const SETTINGS_FILE = path.join(JOBS_DIR, "settings.json");

/** Una clave de API no lleva espacios, comillas ni saltos de línea. */
const KEY_MIN_LENGTH = 16;
const KEY_MAX_LENGTH = 512;
const KEY_PATTERN = /^[\x21-\x7e]+$/;

/** Ajuste inválido del panel; el código HTTP lo aporta la base. */
export class SettingsError extends HttpError {}

interface StoredKey {
  key: string;
  savedAt: string;
}

interface StoredSettings {
  version: 1;
  provider: LlmProvider | null;
  keys: Partial<Record<LlmProvider, StoredKey>>;
}

/** Estado de una clave tal y como lo ve el panel: nunca incluye la clave. */
export interface KeyStatus {
  configured: boolean;
  /** De dónde sale: del panel o del entorno del proceso. */
  source: "panel" | "environment" | null;
  savedAt: string | null;
}

export interface SettingsSnapshot {
  /** Proveedor elegido en el panel. */
  provider: LlmProvider | null;
  /** Proveedor que usará el motor ahora mismo (panel u entorno). */
  activeProvider: LlmProvider | null;
  /** Modelo del score con ese proveedor. */
  model: string | null;
  keys: Record<LlmProvider, KeyStatus>;
  /** Hay al menos una clave guardada desde el panel. */
  stored: boolean;
  /** Hay una clave utilizable (del panel o del entorno): sin ella no hay score. */
  configured: boolean;
}

function emptySettings(): StoredSettings {
  return { version: 1, provider: null, keys: {} };
}

export function normalizeProvider(value: unknown): LlmProvider | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (name === "claude" || name === "anthropic") return "claude";
  if (name === "gemini" || name === "google") return "gemini";
  return null;
}

function isUsableKey(value: string): boolean {
  return (
    value.length >= KEY_MIN_LENGTH &&
    value.length <= KEY_MAX_LENGTH &&
    KEY_PATTERN.test(value) &&
    // Comillas sueltas delatan un pegado con formato: la clave no las lleva.
    !value.includes('"') &&
    !value.includes("'")
  );
}

function readStored(): StoredSettings {
  if (!existsSync(SETTINGS_FILE)) return emptySettings();
  try {
    const doc = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") return emptySettings();

    const keys: Partial<Record<LlmProvider, StoredKey>> = {};
    const rawKeys = (doc.keys ?? {}) as Record<string, unknown>;
    for (const provider of LLM_PROVIDERS) {
      const entry = rawKeys[provider];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const key = record.key;
      if (typeof key !== "string" || !isUsableKey(key)) continue;
      keys[provider] = {
        key,
        savedAt: typeof record.savedAt === "string" ? record.savedAt : "",
      };
    }

    const provider = normalizeProvider(doc.provider);
    return {
      version: 1,
      provider: provider && keys[provider] ? provider : null,
      keys,
    };
  } catch {
    return emptySettings();
  }
}

function writeStored(settings: StoredSettings): StoredSettings {
  mkdirSync(JOBS_DIR, { recursive: true });
  // Solo el dueño del panel puede leer el archivo. En Windows el modo no aplica, pero
  // el archivo sigue viviendo en el volumen de trabajos, fuera del repo.
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  return settings;
}

/** Proveedor con clave guardada: el elegido o, si no, el único que haya. */
function storedProvider(settings: StoredSettings): LlmProvider | null {
  if (settings.provider && settings.keys[settings.provider]) return settings.provider;
  const saved = LLM_PROVIDERS.filter((provider) => settings.keys[provider]);
  return saved.length > 0 ? saved[0] : null;
}

function envConfigured(env: NodeJS.ProcessEnv): Record<LlmProvider, boolean> {
  return {
    claude: PROVIDER_ENV_KEYS.claude.some((name) => Boolean((env[name] ?? "").trim())),
    gemini: PROVIDER_ENV_KEYS.gemini.some((name) => Boolean((env[name] ?? "").trim())),
  };
}

/**
 * Proveedor que usaría el motor sin clave del panel: el único que tenga clave en el
 * entorno o, si hay dos, el de por defecto del motor (Claude).
 */
function envProvider(configured: Record<LlmProvider, boolean>): LlmProvider | null {
  const present = LLM_PROVIDERS.filter((provider) => configured[provider]);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return "claude";
}

/**
 * Modelo del score: el heredado del entorno si es del mismo proveedor; si no, el de
 * por defecto del proveedor. Un modelo de Claude nunca viaja a la API de Gemini.
 */
export function modelFor(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const inherited = (env.OPENRANKS_LLM_MODEL ?? "").trim();
  return MODEL_BELONGS[provider](inherited.toLowerCase())
    ? inherited
    : PROVIDER_MODEL[provider];
}

/** Estado del panel: qué hay configurado, desde dónde y qué se usará. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): SettingsSnapshot {
  const stored = readStored();
  const fromEnv = envConfigured(env);
  const keys = {} as Record<LlmProvider, KeyStatus>;

  for (const provider of LLM_PROVIDERS) {
    const saved = stored.keys[provider];
    keys[provider] = {
      configured: Boolean(saved) || fromEnv[provider],
      source: saved ? "panel" : fromEnv[provider] ? "environment" : null,
      savedAt: saved?.savedAt ?? null,
    };
  }

  const activeProvider = storedProvider(stored) ?? envProvider(fromEnv);
  return {
    provider: stored.provider,
    activeProvider,
    model: activeProvider ? modelFor(activeProvider, env) : null,
    keys,
    stored: Object.keys(stored.keys).length > 0,
    configured: activeProvider !== null,
  };
}

export interface SettingsInput {
  provider?: unknown;
  claude?: unknown;
  gemini?: unknown;
  /** Proveedor o proveedores que se quitan; `"all"` borra todo. */
  remove?: unknown;
}

function parseRemovals(raw: unknown): LlmProvider[] | "all" {
  if (raw === undefined || raw === null || raw === "") return [];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.some((value) => typeof value !== "string")) {
    throw new SettingsError("El proveedor que se quiere quitar no es válido.");
  }
  const tokens = values.map((value) => String(value).trim().toLowerCase()).filter(Boolean);
  if (tokens.includes("all")) return "all";
  const providers: LlmProvider[] = [];
  for (const token of tokens) {
    const provider = normalizeProvider(token);
    if (!provider) {
      throw new SettingsError("Proveedor no admitido: elige Claude o Gemini.");
    }
    if (!providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

/**
 * Guarda las claves que llegan y el proveedor elegido. Un campo vacío conserva la clave
 * anterior; `remove` es la única forma de borrarla. Devuelve el estado sin secretos.
 */
export function saveSettings(
  input: SettingsInput,
  env: NodeJS.ProcessEnv = process.env,
): SettingsSnapshot {
  const current = readStored();
  const keys: Partial<Record<LlmProvider, StoredKey>> = { ...current.keys };
  let provider = current.provider;

  const removals = parseRemovals(input.remove);
  if (removals === "all") {
    for (const name of LLM_PROVIDERS) delete keys[name];
    provider = null;
  } else {
    for (const name of removals) {
      delete keys[name];
      if (provider === name) provider = null;
    }
  }

  for (const name of LLM_PROVIDERS) {
    const raw = input[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      throw new SettingsError(`La clave de ${PROVIDER_LABEL[name]} no es válida.`);
    }
    const cleaned = raw.trim();
    // Un campo vacío no borra nada: quitar la clave es una acción explícita.
    if (!cleaned) continue;
    if (!isUsableKey(cleaned)) {
      throw new SettingsError(
        `La clave de ${PROVIDER_LABEL[name]} no parece válida: pega solo la clave, sin espacios ni comillas.`,
      );
    }
    keys[name] = { key: cleaned, savedAt: new Date().toISOString() };
    if (!provider) provider = name;
  }

  if (input.provider !== undefined) {
    if (input.provider !== null && typeof input.provider !== "string") {
      throw new SettingsError("El proveedor elegido no es válido.");
    }
    const asked = typeof input.provider === "string" ? input.provider.trim() : "";
    if (asked) {
      const parsed = normalizeProvider(asked);
      if (!parsed) {
        throw new SettingsError("Proveedor no admitido: elige Claude o Gemini.");
      }
      provider = parsed;
    } else {
      provider = null;
    }
  }

  // Con claves guardadas siempre hay un proveedor elegido: el único que haya o Claude.
  if (!provider) {
    const saved = LLM_PROVIDERS.filter((name) => keys[name]);
    if (saved.length > 0) provider = saved[0];
  }

  // El proveedor del score solo se elige entre las claves guardadas en el panel: una
  // clave que solo vive en el entorno se usa sola, sin selector, y así no hay una
  // elección que no pueda aplicarse.
  if (provider && !keys[provider]) {
    throw new SettingsError(
      `Guarda la clave de ${PROVIDER_LABEL[provider]} antes de elegirla para el score.`,
    );
  }

  writeStored({ version: 1, provider, keys });
  return readSettings(env);
}

/**
 * Variables que el panel añade al motor para que el score con LLM use la clave guardada.
 *
 * Sin clave en el panel no se añade nada: el motor usa sus claves del entorno. Sin
 * ninguna de las dos no hay score (P3-11). El modelo heredado se conserva solo si es del
 * mismo proveedor; si no, se sustituye por el de por defecto del proveedor elegido.
 */
export function llmEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const stored = readStored();
  const provider = storedProvider(stored);
  const saved = provider ? stored.keys[provider] : undefined;
  if (!provider || !saved) return {};

  return {
    OPENRANKS_LLM_API_KEY: saved.key,
    OPENRANKS_LLM_PROVIDER: PROVIDER_ENGINE[provider],
    // Un modelo heredado de otro proveedor se sustituye por el del proveedor elegido:
    // un `claude-…` nunca viaja a la API de Gemini.
    OPENRANKS_LLM_MODEL: modelFor(provider, env),
  };
}
