# openRanks

Servicio de generación y publicación de shorts de ranking a partir de vídeo largo.
Este repositorio implementa, por ahora, el **ensamblador (L1)**, el **editor de la
plantilla (L2)** y el **panel de operación** que los encadena
(`docs/rpd/openRanks-plan.md`, §12).

## Qué entrega cada capa

**L1 — ensamblador.** A partir de los **clips ya listos** (los aporta el operador, sin
recortes pendientes). El formato va del **TOP 5 al TOP 10**: se montan 5, 6… hasta 10
puestos.

| Artefacto | Qué es |
| --- | --- |
| `clips/05-<nombre>.mp4` … `clips/01-<nombre>.mp4` | Un clip normalizado y descargable por puesto, numerado por **posición del ranking** |
| `union.mp4` | Todos en **un solo vídeo vertical**, en orden de reproducción `#5 → #1` |
| `manifest.json` | Fuentes, hashes, plan, formato, loudness medida y versiones |

Formato de salida: **1080x1920, 30 fps, yuv420p, audio a −14 LUFS (pico −1 dBTP)**,
y el unido dentro de la banda objetivo (30–58 s).

Encuadre por defecto: cada clip se **agranda** hasta llenar una **banda central de 1184
px (el 62 % del alto)** recortando **solo los laterales** —nunca arriba o abajo— y el
resto va en negro. Así un clip apaisado se ve grande y centrado en vez de pequeño. Un
clip vertical (más estrecho que la banda) llena el ancho y sube por encima de la banda,
hasta los 1080x1920 completos si es 9:16.

**L2 — la edición.** Sobre el `union.mp4` añade **todo el estándar del formato**:

| Artefacto | Qué es |
| --- | --- |
| `ranking.mp4` | El short terminado, con la edición encima |
| `cover.jpg` | Portada (fotograma con el título y la escalera completa) |
| `spec.json` | Las props exactas del render, reproducibles |

Lo que dibuja: **título** con el número en su propio color y a mayor tamaño, y
**palabras en otro color** a elección (`*amarillo*` / `_azul_` en el propio texto). El
título **se ajusta al hueco que tiene**: si no cabe en un renglón **se reparte en
varios** (hasta tres) y, si aun así no entra, baja de tamaño, de modo que nunca se sale
del marco ni pisa la escalera (§9.1). La **escalera de rangos** (último abajo → `1`
arriba, con **🥇🥈🥉** en el podio y oro/plata/bronce por color; **del 4 en adelante el
número va en blanco**) está **completa desde el primer fotograma**: la casilla de turno
está **nítida** y el resto **atenuadas y difuminadas**, tanto las que aún no han llegado
como las que ya pasaron. El **rótulo de cada puesto** va **al lado de su propia
casilla**, **entra con su clip y se queda hasta el final** —los textos se acumulan, no
se sustituyen—, y **en cuanto su puesto cede el turno se atenúa y se difumina igual que
su casilla**: solo el del puesto actual queda nítido. **No hay CTA de cierre.** El montaje es
**siempre de corte seco**: los clips se pegan uno tras otro, en orden, sin transiciones
ni solapes, así que el ranking dura exactamente la suma de sus tramos.

## Regla dura del producto (ADR-8)

Lo **único** editable es el **título del vídeo** y el **nombre de cada puesto**. El
estilo (layout, posiciones, colores, tipografía, animaciones, duración) vive en el
**preset bloqueado** y el **render es siempre automático**: no hay editor, ni
timeline, ni exportación a mano. Cambiar un texto re-renderiza **solo la capa de
overlay** —`openranks render`— sin volver a montar el vídeo.

## El panel

`web/` es un **panel Next.js** que cubre el flujo entero sin terminal: subir los clips
(de 5 a 10: se elige cuántos puestos tiene el ranking), escribir el título y los nombres
de los puestos, lanzar el montaje en corte seco y **ver el resultado en el panel**
(9:16 *inline*, portada y descargas). Muestra la fase en lenguaje humano («Preparando el clip #4 (2 de 5)»,
«Uniendo los cinco clips en vertical»), valida el texto antes de gastar un montaje y
no enseña rutas, ids internos ni JSON (§RF-9).

**Barra de progreso con tiempo restante.** El motor publica el avance en **porcentaje
medido** (`openranks/core/progress.py`) y el panel lo convierte en una barra y en un
**ETA** por regla de tres sobre el tiempo ya empleado. No hay temporizador inventado:
si el tramo actual está costando más de lo previsto, la estimación se estira sola.

**Plantilla de la edición.** El panel enseña, valor por valor, cómo está configurado el
texto sobre el vídeo **y en qué archivo del motor se cambia** (ver «Cómo se ajusta la
plantilla» más abajo), con un **selector de color por palabra** para el título (blanco →
amarillo → azul).

**Menú lateral de la plantilla.** «Ajustar la plantilla» (o el botón **Plantilla** de la
cabecera) abre un menú lateral con la plantilla como **pantalla de móvil** en el centro y
los controles al lado: tamaño y posición de la sección de top, tamaño del título y su
**fondo negro**, **fuente** (con la sans-serif **geométrica**) y **cursiva**. La vista
previa es el **render exacto del motor** —FFmpeg dibuja el overlay sobre fondo negro con
tu script ASS— así que **no puede mentir**; a cambio, **los cambios tardan unos segundos
en verse**: el panel vuelve a pedirlo solo cuando dejas de mover los controles. No hay
vista «en vivo» del navegador: la imitación no cuadraba con el render (fuentes, trazos,
medallas) y engañaba más que ayudaba. **Guardar plantilla** fija la última (el montaje
pasa a usarla) y **sobrevive a reinicios**: vive junto a los trabajos
(`web/.jobs/preset.json` en local, `/data/jobs/preset.json` en Docker) y el motor la lee
por `OPENRANKS_PRESET_FILE` en cada montaje.

```bash
npm run dev            # desde la raíz del repo; también vale `cd web && npm run dev`
# → http://localhost:3000
```

El panel habla con el CLI de openRanks por **proceso hijo**. **No hace falta crear el
venv**: el motor es stdlib puro (`dependencies = []`) y corre desde el propio checkout
con `cwd` en la raíz, y FFmpeg lo aporta npm (`ffmpeg-static` + `ffprobe-static`).
Basta con **Node y un Python 3.11+**. El primero que sirva de cada lista gana:

| Pieza | Orden de resolución |
| --- | --- |
| Python | `OPENRANKS_PYTHON` → `.venv` del repo → `py -3` / `python` (Windows) o `python3` / `python` (resto) |
| FFmpeg | `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH` (si es 5+) → npm (`ffmpeg-static`) → `static_ffmpeg` del venv |

`GET /api/engine` enseña lo que se ha resuelto y qué falta si falta algo, sin abrir
una terminal:

```json
{"ready":true,"python":{"interpreter":"py","version":"3.12","source":"lanzador py"},
 "ffmpeg":"ffmpeg.exe","ffprobe":"ffprobe.exe","ffmpegSource":"npm (ffmpeg-static)","problems":[]}
```

El resto se configura por entorno:

| Variable | Para qué | Defecto |
| --- | --- | --- |
| `OPENRANKS_PYTHON` | Intérprete de Python | `.venv` del repo si existe; si no, el del sistema |
| `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` | Binarios de FFmpeg | se resuelven solos (PATH o el de npm) |
| `OPENRANKS_JOBS_DIR` | Dónde viven los trabajos | `web/.jobs/` |
| `OPENRANKS_FONT` | Familia tipográfica del overlay | `Arial` (en Linux: `DejaVu Sans`) |
| `OPENRANKS_FIT` | Cómo encaja cada clip en el marco | `band` (banda central del 62 %) |
| `OPENRANKS_PRESET_FILE` | Plantilla guardada por el panel, que se aplica sobre la de fábrica | la fija el panel en el directorio de trabajos |

## Correr en Docker

La API (panel + motor + FFmpeg) se levanta en **un solo contenedor**, con los trabajos
en un volumen para que sobrevivan a un reinicio:

```bash
docker compose up --build -d      # → http://localhost:3000
docker compose logs -f panel
docker compose down               # los trabajos quedan en el volumen `jobs`
```

La imagen es `node:22-bookworm-slim` con `python3`, `ffmpeg` y las fuentes del overlay
(`fonts-dejavu-core`, `fonts-liberation`, `fonts-symbola` para las medallas y
`fonts-urw-base35`, que trae la sans-serif **geométrica** `URW Gothic` con su cursiva),
así que **no hace falta nada en el host**. `web/Dockerfile` hace el build
del panel y el `pip install -e .` del motor; `docker-compose.yml` define el servicio y
el volumen. Los binarios de FFmpeg de npm se borran en la misma capa: dentro del
contenedor manda el `ffmpeg` de apt (primero en el orden de resolución) y así la imagen
no crece ~110 MB. Variables que usa dentro del contenedor:

| Variable | Valor | Por qué |
| --- | --- | --- |
| `OPENRANKS_ROOT` | `/app` | Dónde está el motor |
| `OPENRANKS_PYTHON` | `python3` | El intérprete del sistema de la imagen |
| `OPENRANKS_JOBS_DIR` | `/data/jobs` | El volumen, fuera de la imagen |
| `OPENRANKS_FONT` | `DejaVu Sans` | `Arial` no existe en Linux |
| `OPENRANKS_FIT` | `band` | El encaje por defecto, el mismo que en local |
| `OPENRANKS_PRESET_FILE` | lo fija el panel en `/data/jobs/preset.json` | La **última plantilla guardada**; al vivir en el volumen, sobrevive a un reinicio |

> Los servicios `postgres`, `minio`, `worker` y `renderer` que dibuja el plan (§7.7)
> son de **L4** y todavía no existen en el código; el compose levanta lo que hoy hay.

## Cómo se ajusta la plantilla

Los ajustes del texto que va sobre el vídeo viven en el **preset** (se cambian una vez,
no por vídeo). Una parte es **editable y se guarda** desde el panel (ver abajo); el resto
sigue fijo. Viven en el código del motor, y hay dos formas de verlos sin leerlo a ciegas:

```bash
python -m openranks preset          # listado por grupos, con el archivo de cada uno
python -m openranks preset --json   # el mismo listado, legible por máquina
```

O en el panel, en la tarjeta **«Plantilla de la edición»**. Dónde vive cada cosa:

| Qué quieres tocar | Archivo | Clave |
| --- | --- | --- |
| Tipografía | `openranks/core/overlay.py` | `DEFAULT_STYLE["font"]` (o `OPENRANKS_FONT`) |
| Familias que ofrece el panel (con la **geométrica**) | `openranks/core/overlay.py` + `web/lib/preset.ts` | `FONT_FAMILIES` / `GEOMETRIC_FONT` (`URW Gothic`) |
| Cursiva (itálica) de todo el texto | `openranks/core/overlay.py` | `DEFAULT_STYLE["italic"]` |
| Título: altura, tamaño, colores, contorno | `openranks/core/overlay.py` | `DEFAULT_STYLE["title"]` |
| Cómo se reparte el título (renglones y tamaño mínimo) | `openranks/core/specs.py` | `fit_title()`, `TITLE_SIDE_MARGIN`, `SAFE_TOP` |
| Palabras en amarillo / azul | `openranks/core/overlay.py` + `openranks/core/specs.py` | `DEFAULT_STYLE["title"]["accent"]` / `["accent_blue"]`, `title_layers()` |
| Escalera: posición, alturas, tamaño, contorno | `openranks/core/overlay.py` | `DEFAULT_STYLE["rank_ladder"]` |
| Medallas del podio (🥇🥈🥉) | `openranks/core/overlay.py` | `DEFAULT_STYLE["rank_ladder"]["medals"]` |
| Casilla activa nítida / resto difuminadas | `openranks/core/overlay.py` | `DEFAULT_STYLE["rank_ladder"]["dim_alpha"]` / `["dim_blur"]` |
| Rótulo de cada puesto (va al lado de su casilla y se atenúa al acabar su turno) | `openranks/core/overlay.py` | `DEFAULT_STYLE["clip_label"]` |
| Color por puesto (oro/plata/bronce) | `openranks/core/specs.py` | `RANK_COLORS` |
| Con qué anima (fundidos, entrada de badges) | `openranks/core/overlay.py` | `build_ass()` |
| Dónde cae cada elemento en el tiempo | `openranks/core/specs.py` | `build_spec()` |

### Ajustes editables y guardados

En el panel, el botón **«Ajustar la plantilla»** (o el botón **Plantilla** de la
cabecera) abre un **menú lateral** con la plantilla como **pantalla de móvil** en el
centro. Ahí se cambia:

| Qué | Clave del preset |
| --- | --- |
| Tamaño de las letras de la sección de top (todas iguales) | `rank_ladder.size` |
| Dónde aparece el top (posición horizontal) | `rank_ladder.x` |
| Altura del `#1` y del `#5` (recorrido de la escalera) | `rank_ladder.y_top` / `y_bottom` |
| Tamaño de las letras del título | `title.size` |
| Fondo negro detrás del título | `title.background` |
| Fuente de la letra (incluida la sans-serif **geométrica**) | `font` |
| Letras **cursivas** | `italic` |

El **número de puestos** no vive en la plantilla: se elige por vídeo en el panel (de 5
a 10) y la escalera se reparte sola entre las alturas guardadas.

El botón **Guardar plantilla** escribe un único preset (se conserva el último) en
`web/.jobs/preset.json`; el panel se lo pasa al motor por **`OPENRANKS_PRESET_FILE`**, así
que el montaje usa exactamente lo que enseña el render de la plantilla. **Restablecer**
vuelve a los valores de fábrica. Solo se aceptan las claves de la tabla
(`EDITABLE_SECTIONS` más `font` e `italic`): un archivo manipulado no puede colar otros
ajustes.

Coordenadas sobre un lienzo de **1080x1920** (la zona segura está en §9.1 del plan).
Después de tocar algo: `python -m pytest -q` y, para verlo, `openranks preview` (dibuja
el overlay sobre **negro** en un PNG, sin clips ni montaje) o `openranks render` sobre
cualquier `union.mp4` ya montado. El script ASS que sale de ahí queda en
`<salida>/work/overlay.ass` y se puede leer tal cual.

```bash
# Cómo se verá el texto, sin montar nada:
python -m openranks preview --out preview.png --title "TOP *5* _GATOS_" --label 1=CIERRE
```

> **Medallas.** El podio se dibuja con 🥇🥈🥉. Son un glifo de fuente: si la máquina no
tiene una fuente con emoji (la imagen de Docker instala `fonts-noto-color-emoji`), la
casilla puede salir en blanco. Para volver a los números basta con dejar
`rank_ladder.medals` vacío (`{}`) en el preset.

> **Fuentes.** libass resuelve la tipografía **por nombre**, así que la familia tiene que
existir en la máquina que renderiza. La imagen de Docker trae las cinco que ofrece el
panel, incluida la **geométrica** (`URW Gothic`); en un host sin ella (Windows no la
trae), elegirla cae en la sans-serif por defecto. Si quieres una tipografía propia
(por ejemplo Jost, Poppins o Futura), es un archivo: el plan (§9.2) ya reserva
`assets/fonts/` para eso.

## Instalación (motor)

Requiere **FFmpeg 8+** (`ffmpeg` y `ffprobe`) y Python 3.11+.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Linux/macOS: .venv/bin/python
```

El venv es **opcional para el panel** (que se apaña con el Python del sistema y el
FFmpeg de npm) y útil para el CLI y los tests. Si no tienes FFmpeg en la máquina, el
extra de desarrollo trae uno estático **dentro del repo** (no toca el sistema). El
producto no depende de ese paquete, así que hay que apuntarlo por entorno:

```bash
export OPENRANKS_FFMPEG=$(.venv/Scripts/python -c "import static_ffmpeg,shutil; static_ffmpeg.add_paths(); print(shutil.which('ffmpeg'))" | tail -1)
export OPENRANKS_FFPROBE=$(.venv/Scripts/python -c "import static_ffmpeg,shutil; static_ffmpeg.add_paths(); print(shutil.which('ffprobe'))" | tail -1)
```

El código resuelve los binarios en este orden: argumento explícito (`--ffmpeg`) →
`OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH`.

## Uso (CLI)

```bash
# 1) Clips de prueba (5 sintéticos de 7 s + binding) para probar sin material propio
python scripts/make_test_clips.py --out demo
python scripts/make_test_clips.py --out demo10 --positions 10 --seconds 5

# 2) Ensamblado (L1) en corte seco y, con --edit, la edición (L2) en la misma pasada
python -m openranks assemble --input demo/binding.json --out demo/render --edit

# 2b) Rehacer solo la edición (L2) cambiando textos: segundos, no minutos
python -m openranks render --dir demo/render --title "TOP 5 GATOS" --label 1=CIERRE

# 2c) Ver la plantilla sobre fondo negro, sin montar nada (un PNG)
python -m openranks preview --out preview.png --title "TOP *5* _GATOS_" --label 1=CIERRE

# 3) Inspección de cualquier archivo (informativa; no juzga)
python -m openranks probe demo/render/ranking.mp4
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
| `--edit` | Encadena L2: añade `ranking.mp4` + `cover.jpg` + `spec.json` |
| `--items 7` | Puestos del ranking, de 5 a 10 (por defecto 5; el panel lo fija por trabajo) |
| `--italic` / `--no-italic` | Letras cursivas en el overlay (`openranks render` y `openranks preview`) |
| `--fit band\|contain\|cover` | `band` (defecto) **agranda** el clip hasta llenar una banda central de 1184 px (62 % del alto) recortando **solo los laterales**: un clip apaisado se ve grande y centrado, con negro arriba y abajo. `contain` lo encaja entero sin recortar (y se ve pequeño si es panorámico); `cover` recorta para llenar los 1080x1920 |
| `--cold-open-seconds 2` | Adelanto del `#1` al principio (gancho). Solo por CLI: el panel monta sin él |
| `--progress` | Emite el avance en porcentaje real por `stderr` (lo consume el panel) |
| `--json` | Salida legible por máquina |

Códigos de salida: `0` ok · `1` fallo de ensamblado/render · `2` entrada inválida.

## Cómo se verifica

```bash
python -m pytest -q
```

- **Núcleo puro** (`test_binding.py`, `test_plan.py`, `test_ffmpeg_args.py`,
  `test_media.py`, `test_manifest.py`, `test_config.py`, `test_specs.py`,
  `test_overlay_args.py`, `test_progress.py`, `test_preset.py`): sin FFmpeg, sin red.
  Cubre el orden `#5 → #1`, la duración real del **corte seco** (la suma exacta de los
  tramos), el cold open, los límites de texto, los rankings de 5 a 10 puestos, el encaje del título
  (renglones y tamaño), las ventanas de cada badge/rótulo (nítido y atenuado), el color
  de cada puesto, la cursiva, el script ASS, los `argv` de FFmpeg, la monotonía del
  porcentaje y el listado del preset.
- **Integración** (`test_assemble_e2e.py`, `test_overlay_e2e.py`, marcados
  `integration`): FFmpeg de verdad sobre clips sintéticos. Comprueba el criterio de
  salida de L1 y, en L2, que `ranking.mp4` es 1080x1920/30 fps/yuv420p con audio, que
  la portada y el spec se escriben **y que el overlay dibuja de verdad** (comparación
  de píxeles contra la unión). Se **saltan** si no hay FFmpeg. La suite está
  comprobada con los **dos** FFmpeg que puede usar el panel: el 8.0.1 del venv y el
  6.1.1 que trae npm (20/20 en ambos).

CI (`.github/workflows/ci.yml`) instala FFmpeg y las fuentes del overlay
(`fonts-dejavu-core`, `fonts-urw-base35`), corre la suite completa y compila el panel
(`npm ci` + `typecheck` + `build`).

### Resultados medidos (clips sintéticos, 1080x1920)

| Salida | Fotogramas | Duración medida | Plan |
| --- | --- | --- | --- |
| `union.mp4`, corte seco (copia de streams) | 1050 | 35.021 s | 35.000 s |
| `ranking.mp4` (L2) | igual que la unión | igual que la unión | — |
| Avance L1+L2 (5×7 s, corte seco) | — | fases de 5 % → 100 %, monotóno | ETA visible desde el 5 % |

Loudness de la unión medida en **−14.08 LUFS** (objetivo −14, pico −1 dBTP): sin solapes
que descontar, cada fotograma del plan llega a la unión, y el overlay **no** recodifica
el audio (se copia), así que la medición se mantiene.

## Estructura

```
openranks/
  core/          # stdlib puro: config, binding, media, ffmpeg, plan, runner, manifest, specs, overlay, progress
  assemble.py    # orquestación de L1: medir → validar → normalizar → unir → verificar → manifiesto
  overlay.py     # orquestación de L2: union.mp4 + manifiesto → ranking.mp4 + cover + spec
  cli.py         # openranks assemble | render | preview | preset | probe
web/             # panel Next.js (App Router): subir, montar, ver y descargar
scripts/         # clips sintéticos para probar a mano
tests/           # núcleo puro + integración real
```

`core/` no importa nada fuera de la stdlib: la lógica de decisión se testea sin FFmpeg
(§7.6 del plan). Los comandos de FFmpeg se **construyen** en `core/ffmpeg.py` y
`core/overlay.py`, y se **ejecutan** en `assemble.py` / `overlay.py`.

## Detalles de implementación que importan

- **Dos pasadas de `loudnorm`** por clip: la primera mide, la segunda aplica ganancia
  lineal con los valores medidos. Así la unión cae en −14 LUFS sin bombeo.
- **El overlay es ASS, no `drawtext`**: libass resuelve la fuente por nombre (sin
  escapar rutas en la cadena de filtros) y permite cambiar el color del número dentro
  de una misma línea (`{\c&H..&}5`). Es el renderer del plan (§9), sin dependencias de
  Node ni assets: el motor que ya hace L1 dibuja también L2.
- **El audio de L2 se copia** (`-c:a copy`): L1 ya lo normalizó y no queremos perder
  esa medición ni gastar una generación de AAC.
- **Unión por copia de streams**: el montaje es de corte seco y los segmentos se
  codifican con parámetros idénticos (`-video_track_timescale 30000`, `setsar=1`), así
  que el `concat` demuxer los pega sin recodificar una sola generación.
- **Silencio inyectado**: un clip sin audio no se rechaza, se le añade una pista de
  silencio del largo del vídeo, o la unión fallaría.
- **Metadatos limpios**: `-map_metadata -1` en todo lo que se escribe (equivalente a
  `METADATA_SCRUB`), y el manifiesto guarda **nombres de archivo y hashes**, nunca
  rutas del host (regla de repositorio público).
- **Los jobs del panel no se sirven por ruta**: la API solo entrega los artefactos que
  ella misma lista, así que un `?path=` manipulado no sale del directorio del trabajo.

## Estado y siguientes pasos

- **L1 y L2 están hechas** (prioridades 1 y 2: los clips listos de un ranking de 5 a 10
  + su unión, y la edición del estándar encima), y el **panel** (RF-9) cubre el flujo de
  esas dos capas.
- El panel **no necesita el venv**: `npm run dev` desde la raíz resuelve un Python
  3.11+ cualquiera y el FFmpeg estático de npm. Si algún día sobran los procesos
  hijos, las alternativas son Docker (una imagen con motor + FFmpeg) o portar el
  motor a TypeScript (son ~3.200 líneas de Python: L1, L2, plan, specs y overlay ASS).
- Pendiente de L2, ya previsto en el plan: **banner con la foto de referencia**
  (`assets/banners/`, §9.2) y **música/sfx** con la cama a −14 LUFS (en MVP van
  desactivados, §9.2, y requieren assets propios).
- **L3** es la extractora (segmentación, screening, scoring, selección) — el riesgo
  técnico real, con spike temprano.
- **L4** cierra la orquestación de punta a punta: cola, publicación y analítica.

No se ha copiado código del repositorio de referencia en estas capas: L1 y L2 están
escritas desde cero. Cuando se reuse código MIT (escenas, reframe, `yt_clients`), cada
archivo llevará su cabecera de origen y el NOTICE correspondiente.
