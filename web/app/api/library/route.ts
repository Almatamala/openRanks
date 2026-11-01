import { createWriteStream, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NextResponse } from "next/server";

import {
  addLibraryItem,
  categoriesOf,
  extensionOf,
  libraryListing,
  LIBRARY_MAX_BYTES,
  newLibraryFile,
  normalizeCategory,
  readLibrary,
} from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMAT_ERROR = "Ese formato no es válido. La galería acepta MP4, MOV, MKV, WEBM, M4V y AVI.";

/**
 * Galería: listado con filtro por categoría (RF-11.4).
 * `?category=` sin valor devuelve los que están «Sin categoría»; sin parámetro, todos.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const category = params.has("category") ? normalizeCategory(params.get("category")) : undefined;
  return NextResponse.json(libraryListing(category));
}

/**
 * Sube un clip **original** a la galería (RF-11.2). Llega en crudo (no multipart) y se
 * escribe por flujo directo a disco: un vídeo grande no se carga en memoria. Aquí solo
 * se comprueban formato y tamaño; el contrato del clip se valida al generar el ranking.
 */
export async function POST(request: Request) {
  const params = new URL(request.url).searchParams;
  const name = params.get("name") ?? "";
  if (!name.trim()) {
    return NextResponse.json({ error: "Falta el nombre del archivo." }, { status: 400 });
  }

  const ext = extensionOf(name);
  if (!ext) return NextResponse.json({ error: FORMAT_ERROR }, { status: 400 });
  if (!request.body) return NextResponse.json({ error: "No llegó ningún archivo." }, { status: 400 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > LIBRARY_MAX_BYTES) {
    return NextResponse.json({ error: "El archivo pasa de 2 GB." }, { status: 413 });
  }

  const { id, destination } = newLibraryFile(ext);
  try {
    await pipeline(Readable.fromWeb(request.body as never), createWriteStream(destination));
  } catch {
    // Ni archivo a medias ni entrada en el índice: la galería queda como estaba.
    rmSync(destination, { force: true });
    return NextResponse.json({ error: "No se pudo guardar el archivo en el servidor." }, { status: 500 });
  }

  // El alta va **después** de escribir el archivo: el índice nunca enseña algo que no está.
  const item = addLibraryItem({
    id,
    name,
    ext,
    bytes: statSync(destination).size,
    // La categoría puede venir con la subida; vacía es «Sin categoría» y se cambia luego.
    category: normalizeCategory(params.get("category")),
  });
  return NextResponse.json({ item, categories: categoriesOf(readLibrary()) }, { status: 201 });
}
