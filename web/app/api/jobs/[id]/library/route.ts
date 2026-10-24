import { NextResponse } from "next/server";

import { DeleteUsedResult, UsedDeleteError, deleteUsedVideos } from "@/lib/job-library";
import { isSafeId } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RF-14: borra de la galería los clips que usó este ranking y vacía sus casillas. El
 * `ranking.mp4` ya generado sigue descargándose.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });

  try {
    const result: DeleteUsedResult = deleteUsedVideos(id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UsedDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "No se pudieron borrar los videos utilizados." }, { status: 500 });
  }
}
