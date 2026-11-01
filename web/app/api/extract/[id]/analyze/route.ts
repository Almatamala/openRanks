import { NextResponse } from "next/server";

import { ExtractionError, isSafeExtractionId, startAnalysis } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Divisor de escenas (P3-3) sobre el vídeo que ya está en el área temporal. Responde
 * enseguida con el trabajo en estado «analizando»; el panel sigue el avance con su
 * sondeo y lee las escenas al terminar.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  try {
    const extraction = await startAnalysis(id);
    return NextResponse.json({ extraction }, { status: 202 });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo dividir el vídeo en escenas. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
