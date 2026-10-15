import { NextResponse } from "next/server";

import {
  elapsedSeconds,
  inferPhase,
  isSafeId,
  listArtifacts,
  logTail,
  readStatus,
  remainingSeconds,
} from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado del trabajo tal y como lo ve el panel: fase en lenguaje humano, nada de ids internos. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });

  const status = readStatus(id);
  if (!status) return NextResponse.json({ error: "Ese trabajo ya no existe." }, { status: 404 });

  const { phase, progress } = inferPhase(id, status);
  return NextResponse.json({
    ...status,
    phase,
    progress,
    // El ETA se recalcula en cada consulta: es el porcentaje real sobre el tiempo real.
    etaSeconds: remainingSeconds(status),
    elapsedSeconds: elapsedSeconds(status),
    artifacts: listArtifacts(id),
    logTail: logTail(id),
  });
}
