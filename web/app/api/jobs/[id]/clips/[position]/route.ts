import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NextResponse } from "next/server";

import { TOTAL_POSITIONS, inputDir, isSafeId, patchStatus, readStatus, uploadedPositions } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB por clip (§4.1)
const ALLOWED_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

/**
 * Sube el archivo de un puesto. Se envía el fichero en crudo (no multipart) y se
 * escribe por flujo directo a disco: un vídeo grande no se carga en memoria.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; position: string }> }) {
  const { id, position } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Trabajo no válido." }, { status: 400 });

  const slot = Number(position);
  if (!Number.isInteger(slot) || slot < 1 || slot > TOTAL_POSITIONS) {
    return NextResponse.json({ error: "Ese puesto no existe." }, { status: 400 });
  }
  if (!readStatus(id)) return NextResponse.json({ error: "Ese trabajo ya no existe." }, { status: 404 });
  if (!request.body) return NextResponse.json({ error: "No llegó ningún archivo." }, { status: 400 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) {
    return NextResponse.json({ error: "El archivo pasa de 2 GB." }, { status: 413 });
  }

  const raw = new URL(request.url).searchParams.get("ext") ?? ".mp4";
  const ext = ALLOWED_EXT.has(raw.toLowerCase()) ? raw.toLowerCase() : ".mp4";
  const dir = inputDir(id);
  mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, `clip-${slot}${ext}`);

  try {
    // Reemplazar un puesto deja el archivo anterior detrás: hay que quitarlo.
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`clip-${slot}.`) && name !== `clip-${slot}${ext}`) {
        rmSync(path.join(dir, name), { force: true });
      }
    }
    await pipeline(Readable.fromWeb(request.body as never), createWriteStream(destination));
  } catch {
    return NextResponse.json({ error: "No se pudo guardar el archivo en el servidor." }, { status: 500 });
  }

  const uploaded = uploadedPositions(id);
  patchStatus(id, { state: "uploading", phase: "Subiendo los clips", uploaded });
  return NextResponse.json({ ok: true, uploaded });
}
