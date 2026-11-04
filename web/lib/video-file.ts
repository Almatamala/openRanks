import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

/**
 * Respuesta de un archivo de vídeo con `Range`, `ETag` y 304: es lo que permite buscar
 * dentro del vídeo sin descargarlo entero. La comparten los originales de la galería y las
 * vistas previas de la fusión, para que un vídeo se sirva siempre de la misma manera.
 */
export function videoFileResponse(request: Request, file: string, contentType: string): NextResponse {
  const stat = statSync(file);
  const size = stat.size;
  // ETag y fecha son lo que permite al navegador revalidar con 304: sin validador,
  // `must-revalidate` le obliga a pedir el archivo entero aunque no haya cambiado.
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
  };

  // `If-None-Match` manda sobre la fecha (RFC 9110); sin él, se compara la fecha.
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifModifiedSince = request.headers.get("if-modified-since");
  const notModified = ifNoneMatch
    ? ifNoneMatch.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")
    : ifModifiedSince !== null &&
      Number.isFinite(Date.parse(ifModifiedSince)) &&
      Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000);
  if (notModified) return new NextResponse(null, { status: 304, headers });

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
