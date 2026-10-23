import { NextResponse } from "next/server";

import { isSafeId, patchStatus, readStatus } from "@/lib/jobs";
import { parseTextRequest } from "@/lib/limits";
import { JobError, isRunning, startJob } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  title?: unknown;
  subtitle?: unknown;
  labels?: unknown;
  positions?: unknown;
}

/**
 * Monta el ranking: une los clips preparados si aún no hay unión y compone la edición
 * (L2) encima. Valida el texto antes de gastar trabajo (RPD §9.5, RF-7): si el título
 * o un nombre no cabe, el error es del formulario.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });
  const status = readStatus(id);
  if (!status) return NextResponse.json({ error: "Ese trabajo ya no existe." }, { status: 404 });
  if (isRunning(id)) return NextResponse.json({ error: "Ese montaje ya está en marcha." }, { status: 409 });

  let body: StartBody;
  try {
    body = (await request.json()) as StartBody;
  } catch {
    return NextResponse.json({ error: "No se entendió la petición." }, { status: 400 });
  }

  const { title, subtitle, positions, labels, problems } = parseTextRequest(body);
  if (problems.length > 0) {
    return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  }

  try {
    const started = await startJob(id, { title, subtitle, labels, positions });
    return NextResponse.json(started, { status: 202 });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    patchStatus(id, { state: "failed", phase: "Se paró", error: "No se pudo arrancar el montaje." });
    return NextResponse.json({ error: "No se pudo arrancar el montaje." }, { status: 500 });
  }
}
