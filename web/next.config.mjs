/** @type {import('next').NextConfig} */
const nextConfig = {
  // El panel orquesta el CLI de openRanks con procesos hijos: nada de edge.
  reactStrictMode: true,
  // FFmpeg/FFprobe llegan como binarios de npm: se leen del disco en runtime, no se
  // empaquetan (si el paquete no está, `lib/paths.ts` busca en el PATH o en el venv).
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
};

export default nextConfig;
