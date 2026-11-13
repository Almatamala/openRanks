/**
 * Ajustes de las claves del score con IA (RF-22, P3-10).
 *
 * Se comprueba lo que importa para la seguridad y para la congruencia con el motor:
 * la API nunca devuelve una clave completa, el campo vacío no borra nada, el quitar es
 * explícito, lo que se inyecta al motor apunta al proveedor elegido y los modelos por
 * defecto son los mismos que declara `openranks/core/llm.py`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const JOBS_DIR = mkdtempSync(path.join(tmpdir(), "openranks-settings-"));
process.env.OPENRANKS_JOBS_DIR = JOBS_DIR;

// Se importan **después** de fijar el directorio: `paths.ts` lo lee al cargarse.
const keys = await import("../lib/api-keys.ts");
const { GET, POST } = await import("../app/api/settings/route.ts");

after(() => rmSync(JOBS_DIR, { recursive: true, force: true }));

const CLAUDE = "sk-ant-api03-clave-de-prueba-0001";
const GEMINI = "AIzaClaveDePruebaDeGemini0001";

async function post(body) {
  const response = await POST(
    new Request("http://panel.local/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, payload: await response.json() };
}

test("sin claves no hay proveedor ni secretos", () => {
  const snapshot = keys.readSettings();
  assert.equal(snapshot.provider, null);
  assert.equal(snapshot.activeProvider, null);
  assert.equal(snapshot.stored, false);
  assert.equal(snapshot.keys.claude.configured, false);
  assert.equal(snapshot.keys.gemini.configured, false);
});

test("guardar la clave de Claude la activa sin devolverla entera", () => {
  const snapshot = keys.saveSettings({ provider: "claude", claude: `  ${CLAUDE}  ` });

  assert.equal(snapshot.activeProvider, "claude");
  assert.equal(snapshot.model, keys.PROVIDER_MODEL.claude);
  assert.equal(snapshot.keys.claude.configured, true);
  assert.equal(snapshot.keys.claude.source, "panel");
  assert.equal("hint" in snapshot.keys.claude, false);
  assert.equal(JSON.stringify(snapshot).includes(CLAUDE), false);
});

test("lo que se inyecta al motor usa el proveedor elegido", () => {
  const env = keys.llmEnv({});
  assert.equal(env.OPENRANKS_LLM_PROVIDER, "anthropic");
  assert.equal(env.OPENRANKS_LLM_API_KEY, CLAUDE);
  assert.equal(env.OPENRANKS_LLM_MODEL, keys.PROVIDER_MODEL.claude);
});

test("Gemini se guarda con su propio modelo y proveedor", () => {
  const snapshot = keys.saveSettings({ provider: "gemini", gemini: GEMINI });

  assert.equal(snapshot.activeProvider, "gemini");
  assert.equal(snapshot.model, keys.PROVIDER_MODEL.gemini);
  assert.equal("hint" in snapshot.keys.gemini, false);
  assert.equal(snapshot.keys.claude.configured, true);

  const env = keys.llmEnv({});
  assert.equal(env.OPENRANKS_LLM_PROVIDER, "gemini");
  assert.equal(env.OPENRANKS_LLM_API_KEY, GEMINI);
  assert.equal(env.OPENRANKS_LLM_MODEL, keys.PROVIDER_MODEL.gemini);
});

test("un modelo heredado de otro proveedor se sustituye por el elegido", () => {
  const env = keys.llmEnv({ OPENRANKS_LLM_MODEL: "claude-haiku-5.5" });
  assert.equal(env.OPENRANKS_LLM_MODEL, keys.PROVIDER_MODEL.gemini);

  const same = keys.llmEnv({ OPENRANKS_LLM_MODEL: "gemini-otro-modelo" });
  assert.equal(same.OPENRANKS_LLM_MODEL, "gemini-otro-modelo");
});

test("una clave con espacios, comillas o demasiado corta se rechaza", () => {
  assert.throws(
    () => keys.saveSettings({ claude: "clave con espacios" }),
    /no parece válida/,
  );
  assert.throws(() => keys.saveSettings({ claude: '"sk-ant-1234567890"' }), /no parece válida/);
  assert.throws(() => keys.saveSettings({ claude: "corta" }), /no parece válida/);

  // La clave buena sigue guardada.
  assert.equal(keys.readSettings().keys.claude.source, "panel");
});

test("un campo vacío no borra la clave guardada", () => {
  const snapshot = keys.saveSettings({ claude: "   ", provider: "claude" });
  assert.equal(snapshot.keys.claude.configured, true);
  assert.equal(snapshot.activeProvider, "claude");
});

test("elegir un proveedor sin clave falla con un mensaje accionable", () => {
  keys.saveSettings({ remove: ["gemini"] });
  assert.throws(() => keys.saveSettings({ provider: "gemini" }), /clave de Gemini/i);
});

test("quitar una clave la borra del panel y del motor", () => {
  const snapshot = keys.saveSettings({ remove: ["claude"] });
  assert.equal(snapshot.keys.claude.configured, false);
  assert.equal(snapshot.stored, false);
  assert.deepEqual(keys.llmEnv({}), {});
});

test("la API de ajustes no devuelve nunca la clave completa", async () => {
  const saved = await post({ provider: "claude", claude: CLAUDE });
  assert.equal(saved.response.status, 200);
  assert.equal(JSON.stringify(saved.payload).includes(CLAUDE), false);

  const response = await GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.keys.claude.configured, true);
  assert.equal(JSON.stringify(body).includes(CLAUDE), false);
  assert.equal(JSON.stringify(body).includes(JOBS_DIR), false);
});

test("la API rechaza un cuerpo inválido y un proveedor no admitido", async () => {
  const broken = await POST(
    new Request("http://panel.local/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
  );
  assert.equal(broken.status, 400);

  const unknown = await post({ provider: "openai" });
  assert.equal(unknown.response.status, 400);
  assert.match(unknown.payload.error, /Claude o Gemini/);
});

test("quitar todo deja el panel sin claves", async () => {
  await post({ remove: "all" });
  const response = await GET();
  const body = await response.json();
  assert.equal(body.activeProvider, null);
  assert.equal(body.stored, false);
});

test("se puede guardar solo una clave y usarla sin la del otro proveedor", () => {
  keys.saveSettings({ remove: "all" });
  const snapshot = keys.saveSettings({ gemini: GEMINI });

  assert.equal(snapshot.keys.gemini.source, "panel");
  assert.equal(snapshot.keys.claude.configured, false);
  assert.equal(snapshot.activeProvider, "gemini");
  assert.equal(keys.llmEnv({}).OPENRANKS_LLM_PROVIDER, "gemini");

  keys.saveSettings({ remove: "all" });
});

test("los modelos por defecto coinciden con el motor de Python", () => {
  const source = readFileSync(
    new URL("../../openranks/core/llm.py", import.meta.url),
    "utf-8",
  );
  assert.match(source, /PROVIDER_DEFAULT_MODEL/);
  for (const model of [keys.PROVIDER_MODEL.claude, keys.PROVIDER_MODEL.gemini]) {
    assert.ok(source.includes(`"${model}"`), `el motor no declara ${model}`);
  }
  assert.match(source, /PROVIDER_GEMINI/);
  assert.match(source, /PROVIDER_ANTHROPIC/);
});
