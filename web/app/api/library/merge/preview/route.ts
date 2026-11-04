import { NextResponse } from "next/server";

import { MergeError } from "@/lib/library-merge";
import { createMergePreview, previewFilePath } from "@/lib/library-preview";
import { videoFileResponse } from "@/lib/video-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Montar la vista previa recodifica (reducida y rápido): puede tardar unos segundos.
export const maxDuration = 300;

/**
 * Vista previa de la fusión: monta el clip **unido** con los ids en el orden dado y
 * devuelve su URL. Es efímera: no entra en la galería ni en el índice.
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
    const preview = await createMergePreview(ids);
    return NextResponse.json(preview, { status: 201 });
  } catch (error) {
    if (error instanceof MergeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo preparar la vista previa de la fusión." },
      { status: 500 },
    );
  }
}

/** Sirve la vista previa montada (con `Range`, para poder buscar dentro del vídeo). */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const file = previewFilePath(id);
  if (!file) {
    return NextResponse.json({ error: "Esa vista previa ya no está." }, { status: 404 });
  }
  return videoFileResponse(request, file, "video/mp4");
}
