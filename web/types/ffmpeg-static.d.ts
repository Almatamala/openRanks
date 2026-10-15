/**
 * `ffmpeg-static` es opcional en la práctica: donde ya haya FFmpeg del sistema (la
 * imagen de Docker, por ejemplo) el paquete no se instala y el panel se apaña con el
 * del PATH o el del venv. La declaración va aquí para que el build no dependa de que
 * el paquete esté presente. Solo se usa como ruta al binario.
 */
declare module "ffmpeg-static" {
  const ffmpeg: string | null;
  export default ffmpeg;
}
