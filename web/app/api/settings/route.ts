import { NextResponse } from "next/server";

import { readSettings, saveSettings, SettingsError } from "@/lib/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ajustes del panel (RF-22): qué claves de IA hay configuradas y cuál se usa para el
 * score. La respuesta **nunca** incluye la clave ni un fragmento de ella: solo si existe
 * y de dónde sale.
 */
export async function GET() {
  return NextResponse.json(readSettings(), {
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Guarda las claves y el proveedor elegido. Un campo vacío conserva la clave anterior;
 * `remove` es la única forma de quitarla (`"all"` borra todo).
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "El cuerpo no es válido." }, { status: 400 });
  }

  try {
    const snapshot = saveSettings(body as Record<string, unknown>);
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SettingsError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudieron guardar los ajustes. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
