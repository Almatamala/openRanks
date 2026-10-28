/**
 * Carga los módulos del panel tal y como los ve Next, sin bundler y sin dependencias:
 *
 *   - `@/lib/x` → `web/lib/x.ts` (el alias de `tsconfig.json`).
 *   - Un import relativo sin extensión (`./limits`) → `./limits.ts`.
 *   - `next/server` → `next/server.js` (Node no resuelve la entrada del paquete).
 *
 * Se registra con `--import ./test/loader.mjs`; el tipado de los `.ts` lo quita el
 * propio Node (`--experimental-strip-types` en 22, activo por defecto desde 23).
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `web/`, la raíz del proyecto del panel. */
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Primer archivo que existe: `<base>.ts`, `<base>.tsx` o su `index`. */
function firstFile(base) {
  for (const suffix of CANDIDATES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);

    if (specifier.startsWith("@/")) {
      const found = firstFile(path.join(WEB_ROOT, specifier.slice(2)));
      if (found) return nextResolve(pathToFileURL(found).href, context);
    }

    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = path.extname(specifier) !== "";
    if (relative && !hasExtension && context.parentURL?.startsWith("file:")) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      const found = firstFile(base);
      if (found) return nextResolve(pathToFileURL(found).href, context);
    }

    return nextResolve(specifier, context);
  },
});
