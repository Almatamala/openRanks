import { NextResponse } from "next/server";

import { currentExtraction, ExtractionError, startExtraction } from "@/lib/extract-job";
import { resolveDownloader } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Estado de la extracción (RF-16.2): si está la herramienta de descarga y qué descarga hay
 * en marcha, para poder engancharse a ella al recargar. El ejecutable resuelto (`binary`)
 * se queda en el servidor: la UI no enseña rutas del host (§10.3).
 */
export async function GET() {
  const { binary: _binary, ...downloader } = await resolveDownloader();
  return NextResponse.json({ downloader, current: currentExtraction() });
}

/**
 * Arranca la descarga de un enlace ya declarado (RF-16.3) en el área temporal. Devuelve
 * 201 con la extracción; a partir de ahí el panel la sigue por `GET /api/extract/{id}`.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "No llegó la declaración de la fuente." }, { status: 400 });
  }

  try {
    const extraction = await startExtraction({
      url: typeof body.url === "string" ? body.url : "",
      terms: body.terms === true,
    });
    return NextResponse.json({ extraction }, { status: 201 });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo empezar la descarga. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
