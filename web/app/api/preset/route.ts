import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import { PROJECT_ROOT, resolveEngine } from "@/lib/paths";
import {
  clearPreset,
  engineEnv,
  FONT_CHOICES,
  PRESET_RANGES,
  readPreset,
  sanitizePreset,
  writePreset,
} from "@/lib/preset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const run = promisify(execFile);

/**
 * Listado del motor, **sin caché**: el preset efectivo cambia al guardar y al
 * restablecer. Cachearlo dejaba el «Restablecer» mostrando la versión guardada
 * anterior (el motor ya leía los valores de fábrica, pero el panel servía la copia
 * vieja del listado).
 */
async function loadPreset() {
  const engine = await resolveEngine();
  if (!engine.python) throw new Error(engine.problems[0] ?? "No hay motor con el que leer la plantilla.");
  const { stdout } = await run(
    engine.python.command,
    [...engine.python.args, "-m", "openranks", "preset", "--json"],
    {
      cwd: PROJECT_ROOT,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      // El listado tiene que reflejar el preset guardado, que es el que usa el render.
      env: engineEnv(),
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Ajustes del preset: el panel enseña —y ahora también edita y guarda— el texto que
 * va sobre el vídeo. Devuelve el listado del motor y lo que se puede cambiar.
 */
export async function GET() {
  const saved = readPreset();
  try {
    const listing = await loadPreset();
    return NextResponse.json({
      ...listing,
      saved,
      hasSaved: saved !== null,
      // Las familias y lo que es cada una salen del motor: una sola fuente de verdad.
      fonts: Array.isArray(listing.fonts) ? listing.fonts : [...FONT_CHOICES],
      fontNotes: (listing.font_notes as Record<string, string> | undefined) ?? {},
      ranges: PRESET_RANGES,
    });
  } catch (error) {
    const engine = await resolveEngine();
    return NextResponse.json(
      {
        error: "No se pudo leer la plantilla del motor.",
        problems: engine.problems,
        detail: error instanceof Error ? error.message : null,
      },
      { status: 500 },
    );
  }
}

/** Guarda la plantilla. Solo se conserva la última. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }
  const preset = writePreset(sanitizePreset(body));
  return NextResponse.json({ saved: preset, hasSaved: true });
}

/** Vuelve a los valores de fábrica. */
export async function DELETE() {
  clearPreset();
  return NextResponse.json({ saved: null, hasSaved: false });
}
