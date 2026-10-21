import { NextResponse } from "next/server";

import { isSafeId, patchStatus, readStatus } from "@/lib/jobs";
import { clampPositions, labelErrors, positionsFor, subtitleErrors, titleErrors } from "@/lib/limits";
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
 * Valida el texto **antes** de gastar un montaje (RPD §9.5, RF-7.4): si el título o
 * un nombre no cabe, el error es del formulario, no del render.
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

  const title = typeof body.title === "string" ? body.title.trim() : "";
  // Opcional: un subtítulo vacío es válido y el vídeo sale sin él.
  const subtitle = typeof body.subtitle === "string" ? body.subtitle.trim() : "";
  const positions = clampPositions(body.positions);
  const rawLabels = (body.labels ?? {}) as Record<string, unknown>;
  const labels: Record<string, string> = {};
  const problems = [...titleErrors(title), ...subtitleErrors(subtitle)];
  for (const position of positionsFor(positions)) {
    const label = typeof rawLabels[String(position)] === "string" ? String(rawLabels[String(position)]).trim() : "";
    labels[String(position)] = label;
    problems.push(...labelErrors(position, label));
  }
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
