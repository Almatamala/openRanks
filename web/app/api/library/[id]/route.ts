import { NextResponse } from "next/server";

import {
  categoriesOf,
  isSafeLibraryId,
  readLibrary,
  removeLibraryItem,
  setCategory,
} from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cambia la categoría de un clip de la galería (RF-11.3). `category: null` (o vacía)
 * lo deja «Sin categoría». No hay pantalla de categorías: la categoría existe mientras
 * la tenga algún clip.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  if (!body || typeof body !== "object" || !("category" in body)) {
    return NextResponse.json({ error: "Falta la categoría del clip." }, { status: 400 });
  }
  const category = (body as { category?: unknown }).category;
  if (category !== null && typeof category !== "string") {
    return NextResponse.json({ error: "La categoría no es válida." }, { status: 400 });
  }

  const item = setCategory(id, category);
  if (!item) {
    return NextResponse.json({ error: "Ese clip ya no está en la galería." }, { status: 404 });
  }

  return NextResponse.json({ item, categories: categoriesOf(readLibrary()) });
}

/**
 * Borra un clip de la galería: su entrada del índice y el original en disco. El trabajo
 * que lo haya usado conserva su copia, así que un montaje hecho no se rompe.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeLibraryId(id)) {
    return NextResponse.json({ error: "Ese clip no es válido." }, { status: 400 });
  }

  try {
    const removed = removeLibraryItem(id);
    if (!removed) {
      return NextResponse.json({ error: "Ese clip ya no está en la galería." }, { status: 404 });
    }
    return NextResponse.json({ item: removed, categories: categoriesOf(readLibrary()) });
  } catch {
    return NextResponse.json(
      { error: "No se pudo eliminar el clip de la galería." },
      { status: 500 },
    );
  }
}
