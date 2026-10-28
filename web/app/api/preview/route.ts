import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
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
 * La vista previa es el mismo render para los mismos textos y ajustes: cachearla unos
 * minutos evita relanzar Python + FFmpeg al volver a una combinación ya dibujada.
 */
const CACHE_MAX = 32;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPreview {
  png: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
  at: number;
}

const previewCache = new Map<string, CachedPreview>();

/**
 * Clave estable: todo lo que cambia el PNG, sin el `t` que el panel añade para romper
 * la caché del navegador. El preset guardado entra por su fecha y tamaño, así que
 * guardar una plantilla nueva invalida lo viejo sin borrar la caché a mano.
 */
function previewKey(url: URL, presetFile: string | undefined, hasStyle: boolean): string {
  const parts: string[] = [];
  for (const name of ["title", "subtitle", "positions", "style"]) {
    parts.push(`${name}=${url.searchParams.get(name) ?? ""}`);
  }
  for (let position = 1; position <= 10; position += 1) {
    parts.push(`label${position}=${url.searchParams.get(`label${position}`) ?? ""}`);
  }
  if (!hasStyle) {
    let stamp = "missing";
    if (presetFile) {
      try {
        const file = statSync(presetFile);
        stamp = `${file.mtimeMs}:${file.size}`;
      } catch {
        // Sin preset guardado se usa el de fábrica; basta con distinguirlo.
      }
    }
    parts.push(`preset=${stamp}`);
  }
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

/**
 * Vista previa de la plantilla: el motor dibuja el overlay sobre **fondo negro** y
 * devuelve un PNG (no monta nada). Con `style` usa el preset **sin guardar** que está
 * editando el operador; sin él, el preset guardado.
 */
export async function GET(request: Request) {
  if (request.signal.aborted) return new NextResponse(null, { status: 499 });
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
  const styleParam = url.searchParams.get("style");
  const key = previewKey(url, env.OPENRANKS_PRESET_FILE, Boolean(styleParam));
  const cached = previewCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    // LRU barato: el último usado pasa al final de la inserción.
    previewCache.delete(key);
    previewCache.set(key, cached);
    return new NextResponse(cached.png, {
      headers: { ...cached.headers, "X-OpenRanks-Cache": "hit" },
    });
  }
  if (cached) previewCache.delete(key);

  let tempPreset: string | null = null;
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
      // Si el panel cambia de texto, aborta la petición: el proceso se mata y no se
      // queda un FFmpeg compitiendo por la CPU con el siguiente.
      signal: request.signal,
    });
    const png = new Uint8Array(await readFile(outPath));
    const headers: Record<string, string> = {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-OpenRanks-Cache": "miss",
    };
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
    // Se guarda el cuerpo ya en memoria: las siguientes veces no tocan FFmpeg.
    previewCache.set(key, { png, headers, at: Date.now() });
    while (previewCache.size > CACHE_MAX) {
      const oldest = previewCache.keys().next().value;
      if (oldest) previewCache.delete(oldest);
    }
    return new NextResponse(png, { headers });
  } catch {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    return NextResponse.json({ error: "No se pudo dibujar la vista previa." }, { status: 500 });
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
    if (tempPreset) await rm(tempPreset, { force: true }).catch(() => {});
  }
}
