import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { isSafeLibraryId, libraryFilePath, readLibrary } from "@/lib/library";

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

  const size = statSync(file).size;
  const headers = {
    "Content-Type": CONTENT_TYPES[item.ext] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };

  const range = request.headers.get("range");
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match) {
    const rawStart = match[1];
    const rawEnd = match[2];
    let start: number;
    let end: number;
    if (!rawStart) {
      // `bytes=-N`: los últimos N bytes.
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd ? Number(rawEnd) : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    return new NextResponse(Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  return new NextResponse(Readable.toWeb(createReadStream(file)) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
