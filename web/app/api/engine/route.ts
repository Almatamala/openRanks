import path from "node:path";

import { NextResponse } from "next/server";

import { resolveEngine } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnóstico del entorno (§RF-9: sin rutas del host ni ids internos). Sirve para
 * responder «¿por qué no me monta?» sin abrir una terminal: qué intérprete de Python
 * y qué FFmpeg está usando el panel, y qué falta si falta algo.
 */
export async function GET() {
  const engine = await resolveEngine();
  return NextResponse.json({
    ready: engine.python !== null && engine.ffmpeg !== null && engine.ffprobe !== null,
    python: engine.python
      ? {
          interpreter: path.basename(engine.python.command),
          version: engine.python.version,
          source: engine.python.source,
        }
      : null,
    ffmpeg: engine.ffmpeg ? path.basename(engine.ffmpeg) : null,
    ffprobe: engine.ffprobe ? path.basename(engine.ffprobe) : null,
    ffmpegSource: engine.ffmpegSource,
    problems: engine.problems,
  });
}
