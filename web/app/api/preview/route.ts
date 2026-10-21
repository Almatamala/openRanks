import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import { clampPositions, positionsFor } from "@/lib/limits";
import { PROJECT_ROOT, resolveEngine } from "@/lib/paths";
import { engineEnv, sanitizePreset } from "@/lib/preset";

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
  const subtitle = url.searchParams.get("subtitle") ?? "";
  const outPath = path.join(os.tmpdir(), `openranks-preview-${randomUUID()}.png`);

  // El ranking de la vista previa tiene los puestos que diga el panel (de 5 a 10).
  const positions = clampPositions(url.searchParams.get("positions"));
  const argv = [
    "-m",
    "openranks",
    "preview",
    "--out",
    outPath,
    "--title",
    title,
    "--subtitle",
    subtitle,
    "--items",
    String(positions),
    "--json",
  ];
  for (const position of positionsFor(positions)) {
    const label = url.searchParams.get(`label${position}`);
    if (label) argv.push("--label", `${position}=${label}`);
  }
  const engine = await resolveEngine();
  if (!engine.python || !engine.ffmpeg) {
    return NextResponse.json({ error: engine.problems.join(" ") }, { status: 503 });
  }
  argv.push("--ffmpeg", engine.ffmpeg);

  const env = engineEnv();
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
    const { stdout } = await run(engine.python.command, [...engine.python.args, ...argv], {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
    });
    const png = await readFile(outPath);
    const headers: Record<string, string> = { "Content-Type": "image/png", "Cache-Control": "no-store" };
    // El motor calcula el recorrido **real** del ajuste de altura del título (el hueco
    // sobre la escalera depende del texto y del tamaño). Se devuelve en cabeceras para
    // que el panel no ofrezca un deslizador con tramos muertos; la imagen es la misma
    // que el render final.
    try {
      const info = JSON.parse(stdout) as { title_y?: { min?: unknown; max?: unknown } };
      const min = Number(info?.title_y?.min);
      const max = Number(info?.title_y?.max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        headers["X-OpenRanks-Title-Y-Min"] = String(min);
        headers["X-OpenRanks-Title-Y-Max"] = String(max);
      }
    } catch {
      // Sin JSON válido se sigue sirviendo la imagen con el rango del preset.
    }
    return new NextResponse(new Uint8Array(png), { headers });
  } catch {
    return NextResponse.json({ error: "No se pudo dibujar la vista previa." }, { status: 500 });
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
    if (tempPreset) await rm(tempPreset, { force: true }).catch(() => {});
  }
}
