import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import { PROJECT_ROOT, resolveEngine } from "@/lib/paths";
import { PRESET_PATH, sanitizePreset } from "@/lib/preset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const run = promisify(execFile);

/**
 * Vista previa de la plantilla: el motor dibuja el overlay sobre **fondo negro** y
 * devuelve un PNG (no monta nada). Con `style` usa el preset **sin guardar** que está
 * editando el operador; sin él, el preset guardado.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const title = url.searchParams.get("title") ?? "";
  const outPath = path.join(os.tmpdir(), `openranks-preview-${randomUUID()}.png`);

  const argv = ["-m", "openranks", "preview", "--out", outPath, "--title", title, "--json"];
  for (const position of [1, 2, 3, 4, 5]) {
    const label = url.searchParams.get(`label${position}`);
    if (label) argv.push("--label", `${position}=${label}`);
  }
  const engine = await resolveEngine();
  if (!engine.python || !engine.ffmpeg) {
    return NextResponse.json({ error: engine.problems.join(" ") }, { status: 503 });
  }
  argv.push("--ffmpeg", engine.ffmpeg);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    OPENRANKS_PRESET_FILE: PRESET_PATH,
  };
  let tempPreset: string | null = null;
  const styleParam = url.searchParams.get("style");
  if (styleParam) {
    try {
      tempPreset = path.join(os.tmpdir(), `openranks-preset-${randomUUID()}.json`);
      await writeFile(tempPreset, JSON.stringify(sanitizePreset(JSON.parse(styleParam))), "utf-8");
      env.OPENRANKS_PRESET_FILE = tempPreset;
    } catch {
      // Un `style` mal formado no debe impedir la vista previa del preset guardado.
      tempPreset = null;
    }
  }

  try {
    await run(engine.python.command, [...engine.python.args, ...argv], {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    const png = await readFile(outPath);
    return new NextResponse(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "No se pudo dibujar la vista previa." }, { status: 500 });
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
    if (tempPreset) await rm(tempPreset, { force: true }).catch(() => {});
  }
}
