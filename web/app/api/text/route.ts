import { NextResponse } from "next/server";

import { readSavedText, writeSavedText } from "@/lib/text-draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Último texto guardado con el botón **Guardar** de la tarjeta «El título y el
 * subtítulo». No es el estado de un trabajo: es el respaldo que recupera el panel
 * cuando el navegador no tiene borrador (RF-9.7).
 */
export async function GET() {
  return NextResponse.json(readSavedText() ?? { title: "", subtitle: "", savedAt: null });
}

interface TextBody {
  title?: unknown;
  subtitle?: unknown;
}

export async function POST(request: Request) {
  let body: TextBody;
  try {
    body = (await request.json()) as TextBody;
  } catch {
    return NextResponse.json({ error: "No se entendió la petición." }, { status: 400 });
  }
  return NextResponse.json(writeSavedText(body ?? {}));
}
