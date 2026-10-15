/**
 * `ffprobe-static` no trae tipos propios. Solo se usa por su ruta al binario.
 */
declare module "ffprobe-static" {
  const ffprobe: { path: string; version?: string };
  export default ffprobe;
}
