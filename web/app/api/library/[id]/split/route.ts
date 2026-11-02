import { NextResponse } from "next/server";

import { categoriesOf, isSafeLibraryId, readLibrary } from "@/lib/library";
import { splitLibraryItem, SplitError } from "@/lib/library-split";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Divide un clip de la galería en dos escenas por el segundo que manda el operador
 * (`at`). Es el divisor manual: el automático no siempre separa dos escenas que van
 * pegadas en un mismo archivo.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeLibraryId(id)) {
    return NextResponse.json({ error: "Ese clip no es válido." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }
  const at = body && typeof body === "object" ? (body as { at?: unknown }).at : undefined;

  try {
    const result = await splitLibraryItem(id, at);
    return NextResponse.json({ ...result, categories: categoriesOf(readLibrary()) });
  } catch (error) {
    if (error instanceof SplitError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo dividir el clip. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
