import { NextResponse } from "next/server";

import { categoriesOf, readLibrary } from "@/lib/library";
import { mergeLibraryItems, MergeError } from "@/lib/library-merge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fusionar 2-4 clips recodificando puede tardar; que la petición no se corte a los 15 s.
export const maxDuration = 300;

/**
 * Fusión de la galería: pega los clips de `ids` **en ese orden** en un solo archivo, lo da
 * de alta con la categoría y la procedencia del primero y quita los originales.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }
  const ids = body && typeof body === "object" ? (body as { ids?: unknown }).ids : undefined;

  try {
    const result = await mergeLibraryItems(ids);
    return NextResponse.json({ ...result, categories: categoriesOf(readLibrary()) }, { status: 201 });
  } catch (error) {
    if (error instanceof MergeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudieron fusionar los clips. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
