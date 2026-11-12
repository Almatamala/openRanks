import { NextResponse } from "next/server";

import { dropBelowThreshold, ScoreError, scoreLibrary } from "@/lib/gallery-scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Puntuación masiva de la galería (RF-21, P3-9).
 *
 * - `{ action: "score" }`: puntúa los clips que no tienen score y devuelve el informe
 *   con el umbral aplicado. No borra nada.
 * - `{ action: "drop", threshold, confirm: true }`: elimina los clips puntuados por
 *   debajo del umbral. Sin `confirm` no se borra nada.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "El cuerpo no es JSON válido." }, { status: 400 });
  }

  const payload = (body ?? {}) as { action?: unknown; threshold?: unknown; confirm?: unknown };
  const action = payload.action ?? "score";

  try {
    if (action === "drop") {
      if (payload.confirm !== true) {
        return NextResponse.json(
          { error: "Confirma el borrado de los clips que no pasan el umbral." },
          { status: 400 },
        );
      }
      return NextResponse.json(dropBelowThreshold(payload.threshold));
    }

    if (action !== "score") {
      return NextResponse.json({ error: "Esa acción de puntuación no existe." }, { status: 400 });
    }

    return NextResponse.json(await scoreLibrary(payload.threshold));
  } catch (error) {
    if (error instanceof ScoreError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: "No se pudo puntuar la galería. Vuelve a intentarlo." },
      { status: 500 },
    );
  }
}
