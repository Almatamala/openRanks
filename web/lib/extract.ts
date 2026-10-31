/**
 * Extractora (F3 · P3-1): lo **puro** de la entrada de material —plataformas admitidas,
 * lectura del enlace y la casilla de cumplimiento—.
 *
 * Sin red, sin disco y sin descargar nada: la descarga vive en `extract-job.ts`. Lo usan
 * el panel (validación en vivo) y `web/test/extract.test.mjs`, para que el criterio sea
 * uno solo y el botón no acepte lo que el motor rechazaría.
 */

/** Plataformas admitidas (RF-16.1). El host se compara por sufijo: `m.youtube.com` entra. */
export const SOURCE_PLATFORMS = [
  { id: "youtube", label: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
  { id: "tiktok", label: "TikTok", hosts: ["tiktok.com"] },
] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number]["id"];

/** Tope del enlace: por encima de esto no es una URL de vídeo, es otra cosa. */
export const LINK_MAX_CHARS = 2048;

/**
 * Lo que firma el operador antes de extraer: el enlace y **una casilla** de cumplimiento
 * (términos de la plataforma y política de privacidad). La plataforma no se pregunta:
 * sale del enlace, así que no puede contradecirlo.
 */
export interface SourceDeclaration {
  /** Enlace tal como lo pega el operador (o vacío). */
  url: string;
  /** Confirmación de que el material cumple los términos y la privacidad. */
  terms: boolean;
}

export const EMPTY_DECLARATION: SourceDeclaration = { url: "", terms: false };

export type DeclarationField = "url" | "terms";

/** Un motivo concreto, atado a su control, para pintarlo justo debajo. */
export interface DeclarationProblem {
  field: DeclarationField;
  message: string;
}

export interface ParsedLink {
  /** Enlace normalizado (con esquema) cuando se puede leer. */
  href: string | null;
  /** Plataforma deducida del host; `null` si no es de una admitida. */
  platform: SourcePlatform | null;
  /** Motivo en lenguaje de operador; `null` si el enlace sirve. */
  problem: string | null;
}

/** Nombre visible de una plataforma (`YouTube`), o `null` si no hay ninguna. */
export function platformLabel(platform: SourcePlatform | null): string | null {
  return SOURCE_PLATFORMS.find((entry) => entry.id === platform)?.label ?? null;
}

/** «YouTube y TikTok», para los mensajes de admisión. */
export function admissionLabel(): string {
  return SOURCE_PLATFORMS.map((platform) => platform.label).join(" y ");
}

/** Plataforma de un `hostname` (`www.youtube.com` → `youtube`), o `null` si no se admite. */
export function platformOf(hostname: string): SourcePlatform | null {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return null;
  for (const platform of SOURCE_PLATFORMS) {
    for (const candidate of platform.hosts) {
      if (host === candidate || host.endsWith(`.${candidate}`)) return platform.id;
    }
  }
  return null;
}

/**
 * Lee el enlace que pega el operador. Se acepta sin `https://` (pegar
 * `youtube.com/watch?v=…` es lo normal), pero solo web: nada de `file:`, `javascript:` ni
 * credenciales en la URL.
 */
export function parseLink(raw: string): ParsedLink {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { href: null, platform: null, problem: "Pega el enlace del vídeo que quieres extraer." };
  }
  if (text.length > LINK_MAX_CHARS) {
    return {
      href: null,
      platform: null,
      problem: "Ese enlace es demasiado largo: copia solo la dirección del vídeo.",
    };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return {
      href: null,
      platform: null,
      problem: "Ese enlace no es válido. Copia la dirección completa del vídeo.",
    };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { href: null, platform: null, problem: "Solo se admiten enlaces web (http o https)." };
  }
  if (url.username || url.password) {
    return {
      href: null,
      platform: null,
      problem: "El enlace lleva credenciales: quítalas y vuelve a pegarlo.",
    };
  }

  const platform = platformOf(url.hostname);
  if (!platform) {
    return {
      href: url.href,
      platform: null,
      problem: `Solo se admiten enlaces de ${admissionLabel()}.`,
    };
  }
  return { href: url.href, platform, problem: null };
}

/**
 * Todo lo que falta antes de extraer: un enlace admitido y la casilla marcada. Es el
 * criterio con el que la descarga no arranca sin cumplimiento declarado (§11.7).
 */
export function sourceProblems(declaration: SourceDeclaration): DeclarationProblem[] {
  const problems: DeclarationProblem[] = [];

  const link = parseLink(declaration.url);
  if (link.problem) problems.push({ field: "url", message: link.problem });

  if (!declaration.terms) {
    problems.push({
      field: "terms",
      message: "Marca que cumples los términos de la plataforma y la política de privacidad.",
    });
  }

  return problems;
}

/** El enlace y la casilla están listos (no dice nada del binario de descarga). */
export function declarationReady(declaration: SourceDeclaration): boolean {
  return sourceProblems(declaration).length === 0;
}

/** Bytes en lenguaje de operador: `1572864` → `1,5 MB`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded.replace(".", ",")} ${units[index]}`;
}
