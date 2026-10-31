import { NextResponse } from "next/server";

import {
  ExtractionError,
  isSafeExtractionId,
  mergeCandidates,
  setAllVerdicts,
  setCandidateVerdict,
  splitCandidate,
} from "@/lib/extract-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Revisión de los tramos (P3-3). Cuatro acciones sobre el mismo trabajo:
 *
 * - `verdict`: aprueba, descarta o devuelve a «pendiente» un tramo.
 * - `verdict-all`: «Aprobar todos», una sola petición para toda la parrilla.
 * - `split`: parte un tramo mal cortado por el punto que manda el panel (`at`).
 * - `merge`: une un tramo con el siguiente, que en realidad era la misma escena.
 *
 * Las correcciones se guardan en el trabajo: `extract.json` sigue siendo determinista.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeExtractionId(id)) {
    return NextResponse.json({ error: "Esa extracción no es válida." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "No llegó la decisión del tramo." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "verdict";
  const target = body.id ?? body.index;

  try {
    let extraction;
    if (action === "verdict-all") {
      extraction = setAllVerdicts(id, body.verdict);
    } else if (action === "split") {
      extraction = splitCandidate(id, target, body.at);
    } else if (action === "merge") {
      extraction = mergeCandidates(id, target);
    } else if (action === "verdict") {
      extraction = setCandidateVerdict(id, target, body.verdict);
    } else {
      return NextResponse.json({ error: "Esa acción sobre el tramo no es válida." }, { status: 400 });
    }
    return NextResponse.json({ extraction });
  } catch (error) {
    if (error instanceof ExtractionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo guardar la decisión. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
