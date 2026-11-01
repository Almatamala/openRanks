import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { candidateThumbnail, isSafeExtractionId } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Miniatura de un tramo propuesto (`candidates/NN.jpg`), por índice y sin rutas. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  const index = Number(new URL(request.url).searchParams.get("index") ?? "");
  const file = candidateThumbnail(id, index);
  if (!file) {
    return NextResponse.json({ error: "Ese tramo no tiene miniatura." }, { status: 404 });
  }

  try {
    const data = await readFile(file);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "No se pudo leer la miniatura." }, { status: 500 });
  }
}
