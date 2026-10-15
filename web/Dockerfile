# syntax=docker/dockerfile:1

# El panel es Next.js, pero el montaje lo hace el motor en Python (§7.5). La imagen
# lleva las dos cosas — Node, Python y FFmpeg — para que no haga falta instalar nada
# en el host: se levanta y funciona.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Las fuentes van dentro de la imagen porque libass resuelve el overlay **por nombre**.
# `fonts-urw-base35` trae la sans-serif **geométrica** que ofrece el panel (`URW Gothic`,
# con su cursiva propia: `Book Oblique` / `Demi Oblique`) y Nimbus Sans.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-symbola \
      fonts-urw-base35 \
      curl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- El motor (paquete `openranks`) --------------------------------------------
# `--break-system-packages` porque Debian 12 marca el Python del sistema como
# gestionado externamente; dentro del contenedor es exactamente lo que queremos.
COPY pyproject.toml README.md ./
COPY openranks ./openranks
RUN python3 -m pip install --no-cache-dir --break-system-packages -e .

# --- El panel (API + interfaz) --------------------------------------------------
# Las dependencias primero: si no cambia el lockfile, la capa se reutiliza.
COPY web/package.json web/package-lock.json ./web/
# Los binarios de FFmpeg de npm solo hacen falta donde no haya FFmpeg del sistema, y
# esta imagen ya instala `ffmpeg` por apt (que además gana en el orden de resolución).
# Se quitan en la misma capa para no engordar la imagen ~110 MB.
RUN cd web && npm ci --no-audit --no-fund \
 && rm -rf node_modules/ffmpeg-static node_modules/ffprobe-static

COPY web ./web
RUN cd web && npm run build

ENV NODE_ENV=production \
    OPENRANKS_ROOT=/app \
    OPENRANKS_PYTHON=python3 \
    OPENRANKS_JOBS_DIR=/data/jobs \
    OPENRANKS_FONT="DejaVu Sans" \
    PORT=3000

# Los trabajos (fuentes, renders y manifiestos) viven fuera de la imagen.
VOLUME ["/data/jobs"]
EXPOSE 3000

WORKDIR /app/web

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD curl -fsS http://localhost:3000/ >/dev/null || exit 1

CMD ["npm", "run", "start"]
