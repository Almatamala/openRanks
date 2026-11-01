import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { extractionSourceFile, isSafeExtractionId } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tipo del contenedor: el panel lo necesita para que el reproductor arranque bien. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

function contentTypeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[ext] ?? "video/mp4";
}

/**
 * La fuente temporal, por **rangos**. La parrilla de revisión reproduce cada tramo del
 * propio vídeo (busca al `start` y para en el `end`), así que el reproductor necesita
 * `Accept-Ranges` y respuestas 206 para poder saltar sin descargar los 2 GB enteros.
 *
 * Con `?download=1` la misma respuesta se manda como descarga (nombre propio y sin rutas
 * del host): es el botón «Descargar vídeo» del panel, que se queda con la fuente tal cual.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  const file = extractionSourceFile(id);
  if (!file) {
    return NextResponse.json({ error: "El vídeo ya no está en el área temporal." }, { status: 404 });
  }

  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return NextResponse.json({ error: "No se pudo leer el vídeo." }, { status: 500 });
  }

  const headers: Record<string, string> = {
    "Content-Type": contentTypeOf(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
  };
  if (new URL(request.url).searchParams.get("download") === "1") {
    const ext = path.extname(file).toLowerCase();
    headers["Content-Disposition"] =
      `attachment; filename="openranks-${id.slice(0, 8)}${ext}"`;
  }

  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!match || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    return new NextResponse(
      Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream,
      {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      },
    );
  }

  return new NextResponse(
    Readable.toWeb(createReadStream(file)) as unknown as ReadableStream,
    {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    },
  );
}
