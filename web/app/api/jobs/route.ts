import { NextResponse } from "next/server";

import { createJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Abre un trabajo vacío. Los clips se suben después, uno a uno. */
export async function POST() {
  try {
    return NextResponse.json(createJob(), { status: 201 });
  } catch {
    return NextResponse.json({ error: "No se pudo abrir el trabajo en el servidor." }, { status: 500 });
  }
}
