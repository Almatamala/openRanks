import { NextResponse } from "next/server";

import { isSafeId } from "@/lib/jobs";
import { ReorderError, swapPositions } from "@/lib/reorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ReorderBody {
  from?: unknown;
  to?: unknown;
}

/**
 * RF-13: intercambia dos puestos del montaje. Responde enseguida: los preparados se
 * mueven con su clip (sin recodificar) y solo la unión/edición anteriores se invalidan;
 * se rehacen al pulsar «Montar».
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });

  let body: ReorderBody;
  try {
    body = (await request.json()) as ReorderBody;
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }

  try {
    const status = await swapPositions(id, body?.from, body?.to);
    return NextResponse.json(status, { status: 202 });
  } catch (error) {
    if (error instanceof ReorderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "No se pudo cambiar el orden de los puestos." }, { status: 500 });
  }
}
