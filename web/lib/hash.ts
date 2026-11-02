import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * SHA-256 de un archivo ya escrito en disco. Lo comparten el aterrizaje de las escenas
 * aprobadas y el divisor manual: si cada uno calculara la huella a su manera, el mismo
 * tramo podría entrar dos veces en la galería.
 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
