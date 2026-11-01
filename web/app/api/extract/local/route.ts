import { NextResponse } from "next/server";

import { ExtractionError, startLocalExtraction } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Subida de «Archivo local» (P3-1): el vídeo completo llega en crudo y se guarda en el
 * área temporal de la extractora. Nada entra en la galería aquí; el análisis de tramos
 * llega en P3-3. La casilla de cumplimiento viaja como `?terms=1`.
 */
export async function POST(request: Request) {
  const params = new URL(request.url).searchParams;
  const name = params.get("name") ?? "";
  if (!name.trim()) {
    return NextResponse.json({ error: "Falta el nombre del archivo." }, { status: 400 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "No llegó ningún archivo." }, { status: 400 });
  }

  try {
    const extraction = await startLocalExtraction({
      name,
      bytes: Number(request.headers.get("content-length") ?? 0),
      stream: request.body,
      terms: params.get("terms") === "1",
    });
    return NextResponse.json({ extraction }, { status: 201 });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo subir el vídeo. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
