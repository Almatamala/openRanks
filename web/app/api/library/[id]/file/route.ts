import { existsSync } from "node:fs";

import { NextResponse } from "next/server";

import { isSafeLibraryId, libraryFilePath, readLibrary } from "@/lib/library";
import { videoFileResponse } from "@/lib/video-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

/**
 * Sirve el original de un clip de la galería: es lo que hace posible la miniatura y
 * la reproducción de cada tarjeta. Solo se sirven archivos del índice, nunca una ruta
 * pedida por el cliente, y se atiende `Range` para que el vídeo se pueda buscar.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeLibraryId(id)) {
    return NextResponse.json({ error: "Ese clip no es válido." }, { status: 400 });
  }

  const item = readLibrary().find((entry) => entry.id === id);
  if (!item) {
    return NextResponse.json({ error: "Ese clip ya no está en la galería." }, { status: 404 });
  }
  const file = libraryFilePath(item);
  if (!existsSync(file)) {
    return NextResponse.json({ error: "Ese clip ya no está en la galería." }, { status: 404 });
  }

  return videoFileResponse(request, file, CONTENT_TYPES[item.ext] ?? "application/octet-stream");
}
