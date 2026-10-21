import { NextResponse } from "next/server";

import { isSafeId, readStatus } from "@/lib/jobs";
import { POSITIONS_MAX } from "@/lib/limits";
import { JobError, prepareClip } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PrepareBody {
  positions?: unknown;
}

/**
 * Prepara el clip de un puesto **después** de subirlo: encuadre, formato y audio.
 *
 * Responde enseguida (202) y el motor trabaja en segundo plano: el operador puede
 * seguir subiendo otros puestos o escribiendo nombres mientras el tick se enciende.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; position: string }> }) {
  const { id, position } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });

  const slot = Number(position);
  if (!Number.isInteger(slot) || slot < 1 || slot > POSITIONS_MAX) {
    return NextResponse.json({ error: "Ese puesto no existe." }, { status: 400 });
  }
  const status = readStatus(id);
  if (!status) return NextResponse.json({ error: "Ese trabajo ya no existe." }, { status: 404 });

  let body: PrepareBody = {};
  try {
    body = (await request.json()) as PrepareBody;
  } catch {
    // Sin cuerpo: se usan los puestos que ya tenga el trabajo.
    body = {};
  }
  const positions = typeof body.positions === "number" ? body.positions : undefined;

  try {
    const next = await prepareClip(id, slot, positions);
    return NextResponse.json(next, { status: 202 });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "No se pudo preparar el clip." }, { status: 500 });
  }
}
