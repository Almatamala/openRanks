import { NextResponse } from "next/server";

import { isSafeId, patchStatus, readStatus } from "@/lib/jobs";
import { clampPositions, labelErrors, positionsFor, titleErrors } from "@/lib/limits";
import { JobError, isRunning, startJob } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  title?: unknown;
  labels?: unknown;
  positions?: unknown;
  transitionSeconds?: unknown;
  transition?: unknown;
  coldOpenSeconds?: unknown;
  zoom?: unknown;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Valida el texto **antes** de gastar un montaje (§9.5, RF-7.4): si el título o
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
  const positions = clampPositions(body.positions);
  const rawLabels = (body.labels ?? {}) as Record<string, unknown>;
  const labels: Record<string, string> = {};
  const problems = [...titleErrors(title)];
  for (const position of positionsFor(positions)) {
    const label = typeof rawLabels[String(position)] === "string" ? String(rawLabels[String(position)]).trim() : "";
    labels[String(position)] = label;
    problems.push(...labelErrors(position, label));
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  }

  try {
    const started = await startJob(id, {
      title,
      labels,
      positions,
      transitionSeconds: Math.max(0, Math.min(1.5, toNumber(body.transitionSeconds, 0))),
      transition: typeof body.transition === "string" ? body.transition : "slideup",
      coldOpenSeconds: Math.max(0, Math.min(5, toNumber(body.coldOpenSeconds, 0))),
      zoom: Math.max(0, Math.min(0.3, toNumber(body.zoom, 0))),
    });
    return NextResponse.json(started, { status: 202 });
  } catch (error) {
    if (error instanceof JobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    patchStatus(id, { state: "failed", phase: "Se paró", error: "No se pudo arrancar el montaje." });
    return NextResponse.json({ error: "No se pudo arrancar el montaje." }, { status: 500 });
  }
}
