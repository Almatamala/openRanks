import { NextResponse } from "next/server";

import { cancelExtraction, isSafeExtractionId, readExtraction } from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Avance de una descarga: fase, porcentaje, velocidad, tiempo restante y error. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa descarga no es válida." }, { status: 400 });
  }
  const extraction = readExtraction(id);
  if (!extraction) {
    return NextResponse.json({ error: "Esa descarga ya no existe." }, { status: 404 });
  }
  return NextResponse.json({ extraction });
}

/**
 * Cancela la descarga y borra el temporal (RF-16.5). También descarta una descarga que ya
 * había terminado: en los dos casos no queda archivo, ni entrada en la galería, ni trabajo
 * a medias.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa descarga no es válida." }, { status: 400 });
  }
  if (!cancelExtraction(id)) {
    return NextResponse.json({ error: "Esa descarga ya no existe." }, { status: 404 });
  }
  return NextResponse.json({ cancelled: true });
}
