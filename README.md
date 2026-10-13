# openRanks

Servicio de generación y publicación de shorts de ranking a partir de vídeo largo.
Este repositorio implementa, por ahora, **la capa L1** del plan
(`docs/rpd/openRanks-plan.md`, §12): el **ensamblador**.

## Qué entrega L1

A partir de **5 clips ya listos** (los aporta el operador, sin recortes pendientes):

| Artefacto | Qué es |
| --- | --- |
| `clips/05-<nombre>.mp4` … `clips/01-<nombre>.mp4` | Los 5 clips normalizados y descargables, numerados por **posición del ranking** |
| `union.mp4` | Los 5 en **un solo vídeo vertical**, en orden de reproducción `#5 → #1` |
| `manifest.json` | Fuentes, hashes, plan, formato, loudness medida y versiones |

Formato de salida (criterio de §12): **1080x1920, 30 fps, yuv420p, audio a −14 LUFS
(pico −1 dBTP)**, y el unido dentro de la banda objetivo (30–58 s).

Lo que **no** hace L1, a propósito: overlays, plantilla, música y transiciones
animadas (eso es **L2**), y extraer clips de un vídeo largo (**L3**).

## Regla dura del producto (ADR-8)

Lo **único** editable es el **título del vídeo** y el **nombre de cada puesto** (las
dos cosas que entran en el binding). El estilo se decide una vez por preset y el
**render es siempre automático**: no hay editor, ni timeline, ni exportación a mano.

## Instalación

Requiere **FFmpeg 8+** (`ffmpeg` y `ffprobe`) y Python 3.11+.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Linux/macOS: .venv/bin/python
```

Si no tienes FFmpeg en la máquina, el extra de desarrollo trae uno estático **dentro
del repo** (no toca el sistema). El producto no depende de ese paquete, así que hay que
apuntarlo por entorno:

```bash
export OPENRANKS_FFMPEG=$(.venv/Scripts/python -c "import static_ffmpeg,shutil; static_ffmpeg.add_paths(); print(shutil.which('ffmpeg'))" | tail -1)
export OPENRANKS_FFPROBE=$(.venv/Scripts/python -c "import static_ffmpeg,shutil; static_ffmpeg.add_paths(); print(shutil.which('ffprobe'))" | tail -1)
```

El código resuelve los binarios en este orden: argumento explícito (`--ffmpeg`) →
`OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH`.

## Uso

```bash
# 1) Clips de prueba (5 sintéticos de 7 s + binding) para probar sin material propio
python scripts/make_test_clips.py --out demo

# 2) Ensamblado
python -m openranks assemble --input demo/binding.json --out demo/render

# 3) Inspección de cualquier archivo (informativa; no juzga)
python -m openranks probe demo/render/union.mp4

# 3b) ...y con el contrato de clip de entrada aplicado (duración, lado corto, ...)
python -m openranks probe demo/clips/clip-1.mp4 --check
```

El binding es lo único que se escribe a mano:

```json
{
  "title": "TOP 5 GATOS",
  "items": [
    { "position": 5, "path": "clips/clip-1.mp4", "label": "GATO VOLADOR" },
    { "position": 4, "path": "clips/clip-2.mp4", "label": "PERRO CAOS" },
    { "position": 3, "path": "clips/clip-3.mp4", "label": "SORPRESA" },
    { "position": 2, "path": "clips/clip-4.mp4", "label": "ROBO" },
    { "position": 1, "path": "clips/clip-5.mp4", "label": "TERNERA" }
  ]
}
```

`position: 1` es el mejor clip: cierra el vídeo. Las rutas se resuelven **relativas al
JSON**, así que el binding es portable. Los límites de texto de §9.5 (28 caracteres
por capa de título, 24 caracteres / 4 palabras por nombre) se validan al entrar: si el
texto no cabe, falla el *input*, nunca el render.

### Opciones útiles

| Flag | Para qué |
| --- | --- |
| `--fit cover\|contain` | `cover` (defecto) rellena el marco recortando; `contain` añade barras |
| `--transition-seconds 0.35` | Solape con transición animada (recodifica). `0` = corte seco, unión **por copia de streams** |
| `--cold-open-seconds 2` | Adelanto del `#1` al principio (B1 del plan). Requiere decisión: §18 B1 |
| `--json` | Salida legible por máquina |

Códigos de salida: `0` ok · `1` fallo de ensamblado · `2` entrada inválida.

## Cómo se verifica

```bash
python -m pytest -q
```

- **Núcleo puro** (`tests/test_binding.py`, `test_plan.py`, `test_ffmpeg_args.py`,
  `test_media.py`, `test_manifest.py`, `test_config.py`): sin FFmpeg, sin red. Cubre el
  orden `#5 → #1`, la duración real **descontando el solape** de las transiciones
  (§18 B4), el cold open, los límites de texto y los `argv` de FFmpeg.
- **Integración** (`tests/test_assemble_e2e.py`, marcados `integration`): FFmpeg de
  verdad sobre clips sintéticos y comprobación del criterio de salida con `ffprobe`
  (1080x1920, 30 fps, yuv420p, audio presente, duración ≈ suma de las fuentes), más el
  CLI de punta a punta. Se **saltan** si no hay FFmpeg.

CI (`.github/workflows/ci.yml`) instala FFmpeg e corre la suite completa.

### Resultados medidos (clips sintéticos de 7 s, 1080x1920)

| Modo | Fotogramas | Duración medida | Plan | fps declarada / media |
| --- | --- | --- | --- | --- |
| Corte seco (copia de streams) | 1050 | 35.021 s | 35.000 s | 30/1 · 30/1 |
| Transición 0.4 s (xfade) | 1002 | 33.400 s | 33.400 s | 30/1 · 30/1 |
| Cold open 2 s | 1110 | 37.021 s | 37.000 s | 30/1 · 30/1 |

Loudness de la unión medida en **−14.08 LUFS** (objetivo −14, pico −1 dBTP). Los tres
modos cuadran con el plan al fotograma: el solape de las transiciones se descuenta.

## Estructura

```
openranks/
  core/          # stdlib puro: config, binding, media, ffmpeg, plan, runner, manifest
  assemble.py    # orquestación de L1: medir → validar → normalizar → unir → verificar → manifiesto
  cli.py         # openranks assemble | probe
scripts/         # clips sintéticos para probar a mano
tests/           # núcleo puro + integración real
```

`core/` no importa nada fuera de la stdlib: la lógica de decisión se testea sin FFmpeg
(§7.6 del plan). Los comandos de FFmpeg se **construyen** en `core/ffmpeg.py` y se
**ejecutan** en `assemble.py`.

## Detalles de implementación que importan

- **Dos pasadas de `loudnorm`** por clip: la primera mide, la segunda aplica ganancia
  lineal con los valores medidos. Así la unión cae en −14 LUFS sin bombeo.
- **Unión por copia de streams** cuando no hay transición: los segmentos se codifican
  con parámetros idénticos (`-video_track_timescale 30000`, `setsar=1`) y el `concat`
  demuxer los pega sin recodificar.
- **Silencio inyectado**: un clip sin audio no se rechaza, se le añade una pista de
  silencio del largo del vídeo, o la unión fallaría.
- **Metadatos limpios**: `-map_metadata -1` en todo lo que se escribe (equivalente a
  `METADATA_SCRUB`), y el manifiesto guarda **nombres de archivo y hashes**, nunca
  rutas del host (regla de repositorio público).
- **Acotar la salida de cada tramo** (`-t`): `loudnorm` y el AAC dejan cola de audio; sin
  acotar, el contenedor de cada clip crecía ~100 ms, se colaba un "fotograma congelado"
  en cada corte y la unión no cuadraba con la suma. Es la diferencia entre 1050
  fotogramas y una unión 0.33 s más larga que el material.
- **Aviso esperado en la unión por copia**: FFmpeg reetiqueta el DTS del audio (el grid
  de tramas AAC no encadena exacto entre segmentos) y lo deja monótono. Se reporta como
  benigno en vez de repetirlo tres veces, y queda anotado en el manifiesto.
- **La tasa declarada manda**: el contrato de formato se valida contra `r_frame_rate`
  (CFR) y una desviación >1 % de la media se **avisa** (padding de contenedor o VFR).

## Estado y siguientes pasos

- Esta entrega es **L1** (prioridad 1: 5 clips listos + un solo vídeo vertical).
- **L2** añadirá la edición del estándar sobre el `union.mp4` (badges de posición,
  rótulos, transiciones, cover) con el `spec.json` y la exportación OTIO. El re-render
  al cambiar solo textos debe costar segundos, no minutos.
- **L3** es la extractora (segmentación, screening, scoring, selección) — el riesgo
  técnico real, con spike temprano.
- **L4** es una sola herramienta que encadena L1→L2→L3, con panel, cola y publicación.

No se ha copiado código del repositorio de referencia en esta capa: L1 está escrito
desde cero. Cuando se reuse código MIT (escenas, reframe, `yt_clients`), cada archivo
llevará su cabecera de origen y el NOTICE correspondiente.
