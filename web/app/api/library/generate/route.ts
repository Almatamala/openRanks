import { NextResponse } from "next/server";

import { ImportError, importFromLibrary } from "@/lib/library-import";
import { JobError } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * «Generar manual» (RF-12.3): importa los clips elegidos al trabajo en curso y los
 * prepara por puesto, en el orden de selección. El motor no cambia.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }

  const payload = (body ?? {}) as { ids?: unknown; jobId?: unknown };
  try {
    const result = await importFromLibrary(payload.ids, payload.jobId);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof JobError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "No se pudo preparar el montaje con los clips elegidos." },
      { status: 500 },
    );
  }
}
