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
 *
 * El cuerpo es opcional: `{ category }` se aplica a **todas** las escenas que entren, para
 * no tener que etiquetarlas una por una después.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Sin cuerpo (o sin JSON) se dan de alta como «Sin categoría».
    body = null;
  }
  const category = body && typeof body === "object" ? (body as { category?: unknown }).category : undefined;

  try {
    const result = await approveCandidates(id, category);
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
