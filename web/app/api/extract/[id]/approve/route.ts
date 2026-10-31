import { NextResponse } from "next/server";

import { approveCandidates, ApproveError } from "@/lib/extract-approve";
import { isSafeExtractionId } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recortar hasta diez tramos puede tardar; que la petición no se corte a los 15 s.
export const maxDuration = 300;

/**
 * Aterrizaje en la galería (P3-4): recorta los tramos aprobados, los da de alta con su
 * procedencia y borra el temporal de la revisión. Devuelve los clips resultantes (los
 * reutilizados incluidos) para que el panel pueda contar cuántos hay.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  try {
    const result = await approveCandidates(id);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ApproveError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudieron añadir las escenas a la galería. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
