# openRanks — RPD (requisitos del producto)

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **L1, L2 y el panel están construidos y verificados.** El alcance actual está cerrado a estas capas |
| **Fecha** | 23-oct-2026 |
| **Alcance** | **RPD**: qué es el producto, por qué, con qué reglas y con qué criterios de producto. El **plan de ejecución** (orden, entregables, estado y verificación) vive en `docs/plan/openRanks-plan.md` |
| **Documentos** | **RPD** (este) + **plan**. La numeración `§` es **compartida y estable**: §1–§11 y §14–§17 viven aquí; §12–§13 viven en el plan. Así las referencias del código no se mueven al separar los documentos |
| **Decisiones vigentes** | (1) **interfaz única y cómoda** (ADR-9); (2) **estilo bloqueado y render automático** (ADR-8); (3) **montaje siempre de corte seco** (ADR-10); (4) **encuadre automático** por detección del área útil (ADR-11) |

**Nomenclatura.** El servicio se llama `openRanks` (nombre anterior del borrador: *petrank*).
El nicho de mascotas es **el primer preset de estilo**, no el alcance del producto.

Este documento describe **lo que el producto hace hoy** y las reglas que lo gobiernan. Las
capacidades de extracción automática y publicación quedan **fuera del alcance actual**: se
resumen en §4.2 y no tienen módulos, tablas ni endpoints en el código.

---

## 1. Resumen ejecutivo

`openRanks` recibe **un clip por puesto** (de 5 a 10), los normaliza al marco vertical, los une
en un solo vídeo de corte seco y compone encima la edición del estándar. El operador no edita el
vídeo: sube los clips, escribe los textos y descarga el `ranking.mp4` final.

El valor está en estandarizar lo que hoy se hace a mano:

1. **Normalización por clip**: 1080x1920, 30 fps, yuv420p, audio a −14 LUFS y **encuadre
   automático** del área útil.
2. **Unión vertical** en orden de cuenta atrás `#5 → #1`, por **copia de streams** (sin
   recodificar).
3. **Edición del estándar** sobre la unión: título, subtítulo opcional, escalera de rangos,
   rótulos por puesto y atenuado del puesto que no tiene el turno, con un script ASS dibujado
   por libass.
4. **Panel único** que encadena todo el flujo sin terminal, con progreso real y errores
   accionables.

El camino crítico es **CPU-only**: el motor es Python de stdlib pura y FFmpeg/libass. No hay
ASR, ni modelos locales, ni servicios cloud.

---

## 2. Principios del producto

- **Una sola herramienta.** El panel es la superficie del producto (ADR-9): el flujo de L1/L2
  no exige terminal, `curl` ni un editor externo.
- **Estilo bloqueado, texto editable** (ADR-8): lo único que cambia por vídeo es el título, el
  subtítulo opcional y el nombre de cada puesto. El layout, los colores, la tipografía, las
  animaciones y la duración viven en el preset.
- **Render automático**: dados el preset y los textos, el MP4 sale solo; no hay timeline ni
  pasos manuales de montaje.
- **Corte seco** (ADR-10): sin transiciones, sin *swoosh* y sin zoom de entrada.
- **Encuadre automático** (ADR-11): el clip vertical no se recorta; el horizontal se recorta
  al área nítida y, si la confianza es baja, se rellena con negro sin recortar.
- **Trazabilidad sin filtrar el host**: los manifiestos guardan nombres de archivo, hashes,
  medidas y versiones, nunca rutas absolutas.

---

## 3. Formato del producto

Anatomía del short objetivo:

```
┌──────────────────────────────┐  1080 x 1920, 30 fps, 30-58 s
│ ╔══ TÍTULO (2 capas) ════════╗│  y = 96..240 — "TOP 5 GATOS 😹": el número va en
│ ║ TOP 5 GATOS 😹              ║│  su propio color y a mayor tamaño
│ ╚═════════════════════════════╝│
│ [5] ─────────────────────────│  ESCALERA DE RANGOS: x=176,
│ [4]   [ RÓTULO DEL CLIP ]    │  #5 abajo … #1 arriba (no un solo badge),
│ [3]                          │  la casilla de turno nítida y el resto atenuado
│ [2]        [ CLIP ]          │  clip 9:16 encuadrado
│ [1]                          │
└──────────────────────────────┘
```

Reglas de composición:

- **Orden**: cuenta atrás `#5 → #1`, con el mejor clip en `#1`.
- **Duración**: clips de 1–30 s y vídeo unido de **30–58 s** (techo duro de plataforma: 60 s).
- **Números de rango**: una casilla por posición, repartidas en vertical (**#5 abajo, #1
  arriba**). Colores por posición: **#3 bronce, #2 plata, #1 oro**; **del 4 en adelante el
  número va en blanco**.
- **Rótulo por clip**: un título corto por clip, entra con su clip, **se queda hasta el final**
  (los textos se acumulan, no se sustituyen) y **se atenúa y difumina cuando su puesto cede el
  turno**, igual que su casilla.
- **Título global**: arriba, con el número destacado (dos capas: texto + número de otro color).
  El **subtítulo** es opcional y va siempre debajo, con su propio tamaño.
- **Legibilidad**: texto blanco con **stroke negro**, contorno grueso.
- **Encuadre**: un clip horizontal con un clip vertical centrado se recorta al **área nítida**
  y se rellena con negro; uno que ya es vertical no se recorta. La detección es automática y,
  si la confianza es baja, se prefiere **no recortar** (ADR-11).
- **Montaje**: **siempre corte seco** (ADR-10), sin transiciones ni solapes.
- **Audio**: normalizado a **−14 LUFS**, pico −1 dBTP, medido con dos pasadas de `loudnorm`.

---

## 4. Alcance

### 4.1 Dentro del alcance actual

| # | Capacidad | Estado |
| --- | --- | --- |
| 1 | Ingesta de **archivo subido** (los clips que aporta el operador) | **Hecho** |
| 2 | Normalización: `ffprobe`, encuadre automático (recorte del área útil o relleno), 30 fps, audio a −14 LUFS | **Hecho** |
| 3 | **Preparación por puesto al subir** (tick) y **unión en corte seco al montar**, en un solo vídeo vertical | **Hecho** |
| 4 | Edición del estándar sobre la unión (título, subtítulo, escalera y rótulos) | **Hecho** |
| 5 | **Plantilla editable y persistente** (fuente, cursiva, tamaño y posición) | **Hecho** |
| 6 | **Panel único** con progreso por fase, errores accionables y descarga del ranking final | **Hecho** |
| 7 | Re-render de solo el overlay al cambiar textos | **Hecho** |
| 8 | **Banner de referencia** y **música/sfx** con la cama a −14 LUFS | Pendiente de L2: requieren assets propios y van desactivados por defecto |

### 4.2 Fuera del alcance actual

- **L3 — Extractora**: ingesta de YouTube, segmentación de compilados, screening, scoring de
  viralidad y selección TOP N. No hay código ni requisitos activos.
- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes, analítica y trazabilidad de coste.
- **v2+**: descarga de TikTok, voz en off/TTS, autopilot por canal, reescritura de bordes de un
  clip ya cortado, generación de banners por IA, multi-idioma y A/B de estilos.

### 4.3 No objetivos

- Ser un editor manual de vídeo. La revisión existe para aprobar textos, no para editar segundo
  a segundo.
- Garantizar monetización: es una decisión de la plataforma (ver §11).

---

## 5. Usuarios y flujos

**Usuario único del MVP: el operador de la cuenta de rankings** (una persona o un equipo
pequeño que trabaja varios rankings por día). No hay multiusuario ni facturación.

Flujo actual, entero dentro del panel:

1. Elige cuántos puestos tiene el ranking (de 5 a 10) y sube los clips, uno por puesto. Al
   entrar, **cada clip se prepara solo** (encuadre, 1080x1920, 30 fps, audio a −14 LUFS) y su
   puesto muestra un **tick** cuando está listo. Mientras uno se prepara puede seguir subiendo
   los demás o escribiendo nombres: no hay que esperar.
2. Escribe el título, el subtítulo si lo quiere y el nombre de cada puesto; el panel valida los
   límites antes de gastar un render.
3. Ajusta la plantilla si hace falta (menú lateral, con el render exacto sobre negro) y la
   guarda.
4. Con todos los ticks puestos, **Montar** une los clips (corte seco, sin recodificar) y compone
   la edición sobre esa unión; si la unión ya existe, solo rehace la edición. La unión no se
   hace antes: así un cambio de orden o un clip reemplazado no deja uniones de más. El panel
   muestra la fase y el tiempo restante.
5. Ve el `ranking.mp4` en 9:16 dentro del panel y lo descarga: es el **único** archivo que se
   entrega.
6. Si cambia un texto, vuelve a montar la edición sobre el mismo vídeo (segundos).

Historias de usuario:

- **US-1** *Como operador quiero hacer todo desde un panel cómodo y no desde la terminal* → pego
  los clips, veo el avance de cada fase y descargo el resultado sin abrir otra herramienta; la
  UI nunca enseña JSON ni rutas, y cada error trae un botón para reintentar. *(RF-9, hecho)*
- **US-2** *Como operador quiero corregir un título sin volver a montar* → el cambio re-renderiza
  solo el overlay sobre el `union.mp4` y tarda segundos. *(RF-7, hecho)*
- **US-3** *Como operador quiero que el encuadre no me obligue a recortar a mano* → el clip
  horizontal se ajusta al área útil y el vertical se escala sin recortar. *(ADR-11, hecho)*

---

## 6. Requisitos funcionales

Se conservan los identificadores **RF-0, RF-6, RF-7 y RF-9** para no romper las referencias
del código; los requisitos de las capas fuera de alcance no están activos.

### RF-0 — Ensamblado de los clips ya listos (L1) · **hecho**

1. El operador aporta un clip por puesto (mp4/mov/mkv/webm) y elige el número de puestos, de
   **5 a 10**.
2. Cada clip se mide con `ffprobe` y se valida contra el contrato de entrada: duración dentro
   de la banda, lado corto mínimo, audio opcional (si falta, se **inyecta silencio**).
3. Cada clip se normaliza a **1080x1920 / 30 fps / yuv420p**, con **encuadre automático**
   (`fit=auto`): un clip vertical se escala sin recortar; uno horizontal se muestrea (12
   fotogramas a 192 px), se mide la nitidez por columnas y filas, se recorta el área útil y se
   afina el borde a resolución completa. Si la confianza es baja, **no se recorta** y se rellena
   con negro. `band`, `contain` y `cover` quedan como elección explícita. Audio a **−14 LUFS**
   con dos pasadas de `loudnorm`.
4. El trabajo se reparte por etapas: `prepare` normaliza **un** puesto cada vez (lo que enciende
   su tick) y `join` une los clips ya preparados **en corte seco** (`#5 → #1`) por **copia de
   streams**, sin recodificar, al pulsar «Montar».
5. Salidas internas: `prepared/NN.mp4` por puesto, `union.mp4` y `manifest.json` con fuentes,
   hashes, formato y loudness medida. Ninguna de las tres es un entregable del panel: lo único
   que el operador descarga es el `ranking.mp4` que produce L2.

**Criterio de aceptación** (verificado en `tests/test_staged_e2e.py`): los clips
preparados y la unión validan con `ffprobe`
(1080x1920, 30 fps, yuv420p, audio presente); con 5 clips de 2 s, la unión da
**300 fotogramas y 10,0 s exactos** (por debajo del objetivo de 30 s, que solo emite aviso,
no aborta). El flujo por etapas comprueba
además que `join` no mira los originales y que `render` deja la unión **byte a byte igual**.
El encuadre tiene su propia suite (`tests/test_framing.py`, `test_framing_args.py` y
`test_framing_e2e.py`): clasificación sin análisis, recorte de un clip sobre fondo borroso,
islas nítidas ajenas al área útil ignoradas, rotación y salida normalizada.

### RF-6 — Render del short (L2) · **hecho**

1. `openranks prepare` + `openranks join` montan L1; `openranks render` rehace **solo** el
   overlay sobre un `union.mp4` ya montado.
2. El spec de la edición lo construye `core/specs.py` (puro, testeable): ventanas de tiempo de
   cada badge, escalera, rótulos, encaje del título y duración total.
3. La capa de overlay se dibuja con un script **ASS** sobre la unión, con el mismo encuadre y
   formato (1080x1920, 30 fps, yuv420p), `-map_metadata -1` y `+faststart`.
4. Artefactos: `ranking.mp4` (final y **único entregable**), `spec.json` (props exactas,
   reproducible) y el `manifest.json` de L1 ampliado con el bloque de L2 (capa, preset, hashes,
   medidas y avisos).

**Criterio de aceptación** (verificado en `tests/test_overlay_e2e.py`): el MP4 valida con
`ffprobe` (1080x1920, 30 fps, yuv420p, audio presente) y **el overlay dibuja de verdad** (se
comparan píxeles de la región del título contra la unión: si no hay cambio, el test falla); el
audio se copia, así que la duración y la medición de loudness no cambian.

### RF-7 — Textos y revisión · **hecho**

1. `GET /jobs/{id}` devuelve el estado, la fase, el avance, el ETA, los artefactos y las últimas
   líneas del log.
2. **Superficie editable = solo texto (ADR-8)**: título, subtítulo opcional y nombre de cada
   puesto. **No** existe endpoint para recortar, reordenar, cambiar la plantilla ni tocar el
   estilo.
3. Un cambio de texto **no** obliga a recomponer el vídeo: se re-renderiza solo la capa de
   overlay sobre el `union.mp4` (segundos, no minutos).
4. Sustituir el clip de un puesto conserva los otros: el tick de ese puesto se apaga, su unión y
   su edición se invalidan y se rehacen al volver a montar.

### RF-9 — Interfaz de operación (un solo panel, cómodo y fácil de usar) · **hecho**

**El panel es la única superficie del producto.** El operador no usa terminal, ni `curl`, ni un
editor de vídeo, ni una segunda web: si una tarea del flujo de §5 no se puede cerrar desde el
panel, el entregable no está terminado. La UI es propia (`web/`, Next.js App Router).

1. **Un solo sitio.** El panel cubre el flujo de L1/L2 —clips (que se preparan solos al entrar),
   textos, plantilla, montaje, resultado y la descarga del ranking— sin cambiar de herramienta.
2. **Mínimos pasos.** Iniciar un montaje = subir los clips + un botón. Ajustar la plantilla =
   arrastrar un control. Ningún paso obligatorio pide escribir un id, una ruta ni JSON.
3. **Estado y progreso siempre visibles.** Cada job muestra su **fase con nombre humano**
   («Preparando el clip #4», «Añadiendo la edición»), su avance medido y un **tiempo restante
   estimado**; nunca un spinner mudo. Además, **cada puesto tiene su propio estado**, en la
   esquina de su selector de archivo: spinner mientras sube o se prepara, **tick** cuando el
   clip ya está listo, o error con reintento debajo.
   - **El trabajo pesado no bloquea.** La preparación corre en segundo plano por puesto, así que
     se pueden subir otros clips o escribir nombres mientras uno termina.
4. **Errores accionables, en lenguaje humano.** Cada fallo se muestra como *qué pasó + qué
   hacer + botón de reintentar*. Prohibido en la UI: `stack traces`, rutas de fichero, ids
   internos, JSON crudo y códigos de error sin traducir.
5. **La plantilla se ajusta con el render de verdad.** El menú lateral enseña el preset como
   pantalla de móvil y lo dibuja **el motor** sobre fondo negro; los cambios se piden al
   terminar de mover el control, no en cada tirón.
6. **Todos los textos editables se editan en su sitio**, con contador de caracteres y validación
   en vivo antes de gastar un montaje (§9.5).
7. **Nada del trabajo en curso se pierde.** El panel persiste el título, el subtítulo, los
   nombres y el número de puestos; el estado real vive en el servidor.
8. **Legibilidad y accesibilidad.** Contraste sobre fondo oscuro, controles etiquetados (no
   iconos mudos), `aria` en la barra de progreso y foco visible.
9. **Cero jerga interna.** La UI habla el idioma del operador («Nombre del puesto #3»,
   «Montando…»), nunca los nombres de las tablas ni de los enums.
10. **El panel no decide nada por su cuenta.** Toda acción pasa por la API con las mismas
    validaciones: la UI es una vista del estado, no una segunda fuente de verdad.

**Criterio de aceptación.**

- **Sesión única**: un recorrido completo (clips + textos → vídeo montado y descargado) se
  realiza dentro del panel, sin terminal ni otra aplicación.
- **Cero datos técnicos**: ante un fallo, la UI ofrece una acción de recuperación y no muestra
  rutas, ids internos ni JSON.
- **Cobertura**: toda operación de L1/L2 que el operador deba ejecutar tiene su control en el
  panel.

---

## 7. Diseño técnico

### 7.1 Alcance técnico

El código implementa **L1, L2 y el panel**. La extracción automática (L3) y la publicación (L4)
quedan fuera: no hay módulos de segmentación, scoring, cola, almacenamiento objeto ni
publicación. Si se retoman, se documentan y se diseñan antes de escribir código.

### 7.5 Arquitectura de componentes

Lo construido (L1 + L2 + panel) en un solo servicio:

```
                 ┌──────────────────┐
   operador ────►│  panel (Next.js) │  subir clips, textos, plantilla, ver, descargar
                 └────────┬─────────┘
                          │ proceso hijo (CLI), uno por etapa
                 ┌────────▼───────────────┐
                 │  motor (Python)        │  prepare (un puesto)      → prepared/NN.mp4
                 │  L1: medir→normalizar  │  join   (al montar)       → union.mp4
                 │      →unir (corte seco)│  render (solo edición)    → ranking.mp4
                 │  L2: overlay ASS       │
                 └────────┬───────────────┘
                          │ FFmpeg / libass
                 ┌────────▼─────────┐
                 │  trabajos en disco│  input/, render/prepared/, union.mp4, ranking.mp4, manifiestos
                 └──────────────────┘
```

No hay servicios adicionales. La cola, la base de datos y el almacenamiento objeto pertenecen a
L4 y no forman parte de esta arquitectura.

### 7.6 Esqueleto del repositorio (lo que existe hoy)

```
openranks/
  core/           config, binding, media, ffmpeg, framing, plan, runner, manifest, specs, overlay, progress
  prepare.py      prepara **un** clip al subirlo: deja prepared/NN.mp4 (el tick del panel)
  join.py         une los clips ya preparados en union.mp4 al montar, sin recodificar
  framing.py      análisis de encuadre con FFmpeg (muestreo, refino)
  overlay.py      orquestación de L2: union.mp4 + manifiesto → ranking.mp4 + spec
  cli.py          openranks prepare | join | render | preview | preset
web/              panel Next.js (App Router): API de trabajos, preset, vista previa y la UI
scripts/          clips sintéticos para probar a mano
tests/            núcleo puro (sin FFmpeg) + integración real
docs/rpd/         este documento (requisitos)
docs/plan/        el plan de ejecución y la verificación
```

`core/` es **stdlib puro**: toda la lógica de decisión (plan, specs, encaje del título, preset y
geometría del encuadre) se testea en CI sin FFmpeg y sin red. El análisis de píxeles vive en
`framing.py` y se ejecuta en el preparador. Los comandos de FFmpeg se **construyen** en
`core/ffmpeg.py` y `core/overlay.py`, y se **ejecutan** en `prepare.py`, `join.py` /
`overlay.py`.

### 7.7 Despliegue mínimo (el que existe)

`docker-compose.yml` levanta **un solo servicio** (`panel`) con Node, Python, FFmpeg y las
fuentes del overlay dentro de la imagen, y los trabajos en un **volumen** para que sobrevivan a
un reinicio (es lo que hace que la plantilla guardada siga ahí en la próxima sesión):

```yaml
services:
  panel:
    build: {context: ., dockerfile: web/Dockerfile}
    ports: ["3000:3000"]
    environment:
      OPENRANKS_ROOT: /app
      OPENRANKS_PYTHON: python3
      OPENRANKS_JOBS_DIR: /data/jobs
      OPENRANKS_FONT: DejaVu Sans     # `Arial` no existe en la imagen
    volumes: ["jobs:/data/jobs"]
    restart: unless-stopped
volumes: {jobs: {}}
```

Notas de operación: la imagen incluye `ffmpeg`/`ffprobe` y las familias tipográficas que libass
resuelve **por nombre**; los binarios de FFmpeg de npm se borran en la misma capa (dentro del
contenedor manda el de apt). El panel fija `OPENRANKS_PRESET_FILE` en el directorio de trabajos.

---

## 8. Modelo de datos

**No hay base de datos.** El estado de un trabajo vive en disco, dentro del directorio de
trabajos:

- `status.json`: estado, fase, avance, `clips{}` con el tick de cada puesto, `join` y resultado.
- `binding.json`: título, subtítulo opcional y puestos.
- `input/`: los clips subidos.
- `render/`: `prepared/NN.mp4` con los clips ya preparados, `union.mp4`, `ranking.mp4`,
  `spec.json` y `manifest.json`.
- `log.txt`: la traza del trabajo.

La unión y las piezas intermedias quedan solo para trazabilidad: la API únicamente sirve
`ranking.mp4`. El preset guardado vive en el mismo directorio de trabajos
(`preset.json`).

---

## 9. Especificación del overlay y del render

### 9.1 Safe areas (1080x1920)

| Zona | Reservado | Uso |
| --- | --- | --- |
| Inferior | y > 1560 | UI de la plataforma (caption/usuario) → nada permanente: se deja libre |
| Derecha | x > 960 | botonera de TikTok → nada crítico |
| Superior | y < 96 | UI de cámara/estado → el título empieza en y=96 |
| Centro | 340 < y < 1500 | contenido del clip: nada permanente más allá de la escalera |

### 9.2 Estilos (preset bloqueado)

**El estilo no es editable por vídeo (ADR-8).** Se elige una vez y el render lo aplica tal cual.
Lo único que varía entre rankings es el **texto**: el título del vídeo, su subtítulo opcional y
el nombre de cada puesto. `Template` (layout, posiciones, colores, animaciones, duración) es
**constante**; `Binding` lleva **solo texto**.

El preset de fábrica vive en `openranks/core/overlay.py` (`DEFAULT_STYLE`) y los colores por
puesto en `openranks/core/specs.py` (`RANK_COLORS`). Lo que hay hoy:

| Tema | Cómo está |
| --- | --- |
| Fuente | `font` (por defecto `Arial`; en el contenedor manda `OPENRANKS_FONT`). Familias ofrecidas: `DejaVu Sans`, `Liberation Sans`, `DejaVu Serif`, `URW Gothic` (sans-serif **geométrica**) y `Symbola` (símbolos y medallas) |
| Cursiva | `italic`: itálica en todo el texto del overlay |
| Título | Tamaño (`title.size`) y **altura** (`title.y`) ajustables; el motor publica en el spec el recorrido real (`y_min`/`y_max`) y el panel limita el deslizador a él; el tope se amplía **20 px** por debajo del hueco de la escalera (`TITLE_CAP_EXTRA`), así que el título se puede bajar un poco más sin invadir la escalera. Base blanco con contorno negro y el **número** en acento y mayor (§3). El operador marca **palabras** con `*amarillo*` y `_azul_`; las marcas no se dibujan |
| Subtítulo | Opcional (`subtitle` en el binding): va **siempre debajo del título**, con su propio tamaño (`subtitle.size`), y no se dibuja si el texto está vacío. Título y subtítulo se encajan juntos: el bloque sube y reduce el tamaño antes que invadir la escalera |
| Escalera | Una casilla por puesto (**de 5 a 10**); **🥇🥈🥉** en el podio (fuente monocroma `medal_font`) y el número en el resto; color por puesto (`RANK_COLORS`) |
| Turno | La casilla **activa** se ve nítida durante su clip; las demás **se atenúan y difuminan** (`dim_alpha`, `dim_blur`) |
| Rótulo | Va **al lado de su propia casilla** (misma altura, `clip_label.dx = 85 px`); entra con su clip, se queda acumulado y se atenúa cuando su puesto cede el turno |
| Encaje del clip | `auto` por defecto (`OPENRANKS_FIT`): detecta el área útil y rellena con negro; `band`, `contain` y `cover` son elecciones explícitas |
| Preset editable | Una **parte** se ajusta y guarda desde el panel: `font`, `italic`, `title.{size,y}`, `subtitle.size`, `rank_ladder.{size,x,y_top,y_bottom}` (`EDITABLE_SECTIONS` en `core/overlay.py`) |

**El preset guardado persiste entre sesiones.** Se escribe en el directorio de trabajos
(`web/.jobs/preset.json` en local, `/data/jobs/preset.json` dentro del contenedor, que es un
volumen), se conserva **el último**, y el panel se lo pasa al motor por
`OPENRANKS_PRESET_FILE` tanto en la vista previa como en el montaje. Solo se aceptan las
claves editables: un archivo manipulado no puede colar otros ajustes. **Restablecer** vuelve a
los valores de fábrica.

**Todo ajuste se puede consultar sin leer el código**: `openranks preset` (o
`openranks preset --json`, que es lo que consume el panel) lista cada valor con **qué es y en
qué archivo se cambia**. El panel lo enseña en la tarjeta «Plantilla de la edición».

### 9.3 Cómo se dibuja el overlay (ASS sobre FFmpeg)

La edición se compone con un **script ASS** dibujado por **libass** encima del `union.mp4` de
L1, mediante el mismo motor que hace L1:

- **Un evento por elemento**: el título (con el número en su color inline), el subtítulo
  opcional justo debajo, la casilla de cada puesto y el rótulo de cada puesto.
- **La escalera está completa desde el primer fotograma**: todas las casillas están puestas y
  lo que llega con cada clip es su **turno**; la activa se ve nítida (con un pulso al activarse)
  y el resto atenuadas y difuminadas.
- **Animaciones deterministas**: fundidos (`\fad`) y escalados (`\t`), relativos al tiempo de
  vídeo. El mismo texto + el mismo preset producen **el mismo MP4** en cada corrida.
- **El audio se copia** (`-c:a copy`): L1 ya lo dejó a −14 LUFS y no se pierde esa medición.
- **Metadatos limpios**: `-map_metadata -1` en todo lo que se escribe; el manifiesto guarda
  **nombres de archivo y hashes**, nunca rutas del host.
- **Vista previa = render real**: `openranks preview` y el panel aplican **el mismo
  `build_ass`** sobre una fuente negra generada por FFmpeg, así que lo que se ve es lo que
  saldrá en el vídeo. El script queda en `<salida>/work/overlay.ass` y se puede leer tal cual.

### 9.4 Salidas por render

| Artefacto | Especificación |
| --- | --- |
| `ranking.mp4` | 1080x1920, 30 fps, H.264 High, CRF 19, yuv420p, audio copiado, `+faststart`, ≤ 60 s. **Único archivo que se entrega** |
| `spec.json` | props exactas del render (reproducible); interno |
| `manifest.json` | capa, preset, hashes de fuentes y salidas, formato, duración, loudness y avisos; interno |
| `prepared/NN.mp4` | clip normalizado de un puesto; pieza interna de la unión (no se descarga) |

### 9.5 Encaje del texto editable (obligatorio)

Con el estilo bloqueado y el render automático, el texto es el **único** punto por donde entra
input humano: el renderer no puede depender de que el operador escriba corto. Reglas
deterministas, aplicadas también en la validación de entrada:

| Regla | Valor por defecto |
| --- | --- |
| Título del vídeo | ≤ 40 caracteres; el renderer lo reparte en hasta **3 renglones** |
| Subtítulo del vídeo | Opcional; ≤ 40 caracteres, 2 renglones como máximo, siempre debajo del título |
| Nombre de cada puesto | ≤ 24 caracteres (**sin tope de palabras**); se dibuja en **una línea** junto a su casilla. El límite de entrada mantiene el rótulo corto: si algún día se amplía, habrá que añadirle el mismo encaje que al título |
| Reducción por encaje | *shrink-to-fit*: baja el tamaño en pasos del 5 % hasta `TITLE_MIN_SIZE` (40 px) o `SUBTITLE_MIN_SIZE` (28 px); el texto no se trunca |
| Zona segura | el texto nunca invade las safe areas de §9.1 ni la banda de la escalera; el título dispone de `TITLE_CAP_EXTRA = 20 px` dentro del hueco de la escalera |
| Prohibido | que un texto largo mueva posiciones, cambie la duración de un clip o altere el timing de los badges |

El spec guarda el texto **de entrada** y el renderer calcula el encaje en cada corrida
(determinista: `fit_title()` reparte en renglones y baja el tamaño hasta que cabe), de modo que
un mismo par texto + preset produce siempre el mismo MP4.

---

## 10. Requisitos no funcionales

### 10.1 Rendimiento y coste actual

- **Sin coste por API**: todo el render es local (Python + FFmpeg). No hay servicios externos
  de pago ni APIs de terceros en el camino crítico.
- **Normalización**: el trabajo pesado ocurre al subir cada clip, en su propio proceso. El
  panel puede seguir recibiendo los demás puestos mientras uno se prepara.
- **Montaje**: `join` pega por copia de streams y `render` recodifica **una sola generación**
  para dibujar el overlay. Cambiar un texto cuesta segundos, no un montaje completo.
- **Medido** (clips sintéticos 1080x1920): 5 clips de 7 s → unión de 1050 fotogramas y
  35,021 s, con loudness de −14,08 LUFS.

### 10.2 Fiabilidad

- El estado de cada trabajo vive en disco (`status.json`), así que el panel reconstruye la
  vista desde el servidor y no desde el cliente.
- Cada etapa es idempotente: reemplazar un clip incrementa la revisión, apaga su tick e
  invalida la unión y la edición anteriores.
- Un fallo se muestra como *qué pasó + qué hacer*; el operador puede reintentar la etapa sin
  perder los demás puestos.

### 10.3 Seguridad y privacidad

- Claves y rutas sensibles solo por entorno, nunca en el repo ni en los manifiestos.
- Los jobs del panel no se sirven por ruta libre: la API solo entrega los artefactos que ella
  misma lista.
- Los manifiestos guardan nombres de archivo y hashes, nunca rutas del host.
- Los logs usan ids de trabajo, no rutas completas del contenido del operador.

### 10.6 Usabilidad de la interfaz

La interfaz es un requisito de producto (ADR-9) y su detalle funcional está en **RF-9**. Cifras
con las que se verifica:

| Medida | Objetivo |
| --- | --- |
| Tiempo hasta la primera acción | desde abrir el panel, ≤ 2 clics para subir clips o reabrir un trabajo |
| Respuesta del panel | toda acción responde en ≤ 300 ms (o muestra progreso) |
| Progreso por fase | cada job muestra fase, avance y estimación, refrescado ≤ 5 s |
| Errores | el 100 % de los estados de error tiene acción de recuperación y ningún texto crudo |
| Sesión única | el flujo de L1/L2 se cierra sin terminal ni otra aplicación |

El panel no bloquea el trabajo: si el operador cierra el navegador, el montaje sigue y al volver
el panel reconstruye el estado desde el servidor, no desde el cliente.

---

## 11. Legal y cumplimiento

1. **Solo fuentes con derechos**: canal propio, contenido con licencia explícita, CC-BY o
   permiso escrito del creador. El operador guarda la procedencia de cada clip.
2. **Nunca** se recorta ni se tapa la autoría ajena para ocultarla: si un clip trae una marca o
   un rótulo de otro canal que no se puede justificar, no se usa.
3. **Música**: solo pistas de bibliotecas con licencia comercial (o audio del propio creador con
   permiso). La música del compilado ajeno se sustituye.
4. **Crédito y divulgación**: campo de crédito al creador original en la descripción y
   declaración de contenido sintético/editado donde la plataforma lo exija.
5. **Datos de terceros**: no se almacenan datos de usuarios finales.
6. **Edición transformativa como requisito, no como estilo.** Nunca se publica un clip ajeno
   sin capa propia (título, rótulo o escalera) y no existe el modo «publicar el compilado tal
   cual».

> El **plan de ejecución (§12)** y la **estrategia de verificación (§13)** están en
> `docs/plan/openRanks-plan.md`. La numeración se conserva entre ambos documentos.

---

## 14. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
| --- | --- | --- | --- |
| R1 | **Encuadre automático equivocado** en un clip con fondo no uniforme | Medio: el clip se recorta de más o queda pequeño | Detección con confianza y *fallback* sin recorte; `fit` explícito (`band`, `contain`, `cover`) cuando el operador lo necesita |
| R2 | **Texto que no cabe** | Medio: se pisa la escalera o se sale del marco | Límites de entrada (§9.5) + `fit_title()` con renglones y reducción de tamaño; el fallo es del formulario, no del render |
| R3 | **Render lento o no determinista** | Bajo | Animaciones por tiempo de vídeo (ASS), sin reloj; unión sin recodificar; re-render solo del overlay |
| R4 | **Fuga de datos en un repo público** | Alto | Sin secretos, sin rutas del host en manifiestos y logs; la API no sirve artefactos por ruta libre |
| R5 | **Pérdida de trabajos al reiniciar** | Medio | Estado en disco y trabajos en un volumen persistente |

---

## 15. Decisiones registradas (ADR-lite)

Solo se conservan las decisiones que gobiernan el alcance actual; las de L3/L4 se retomarán
con esas capas.

| ADR | Decisión | Motivo |
| --- | --- | --- |
| ADR-3 | Overlay **ASS sobre FFmpeg (`libass`)**, no Remotion ni `drawtext` | Un solo runtime (el mismo motor que hace L1) y sin assets: `drawtext` no permite cambiar el color dentro de una línea y Remotion añadía Node, Chromium y un servicio de render a un producto que ya renderiza con FFmpeg. La pieza que importa (el spec reproducible, §9.3) es la misma |
| ADR-7 | **Construcción de atrás hacia delante: L1 → L2**, y el alcance se cierra en estas capas | Primero existe el producto terminado —formato y edición validados, algo publicable— y después se decide si se automatiza su entrada. L3/L4 no forman parte del alcance actual (23-oct-2026) |
| ADR-8 | **Render 100 % automático y superficie editable = solo texto**: título del vídeo + subtítulo opcional + nombre de cada puesto | Decisión del operador. El estándar visual lo fija el preset y no el operador por vídeo, así que el resultado es reproducible y comparable entre rankings, el trabajo humano se reduce a elegir y revisar, y el render nunca espera a nadie. Obliga a reglas de encaje automático del texto (§9.5) |
| ADR-9 | **La interfaz es un requisito de producto, no un extra**: un **panel único** cubre el flujo de punta a punta, con progreso por fase, errores accionables, plantilla y textos en el mismo sitio | Decisión del operador: el producto debe ser cómodo y fácil de usar. El valor del servicio es ahorrar trabajo humano, y eso se pierde si el operador necesita terminal, `curl` o un editor. Convierte la usabilidad en criterio de aceptación medible (RF-9, §10.6) |
| ADR-10 | **El montaje es siempre de corte seco**: sin transiciones, sin *swoosh* y sin zoom de entrada. La unión se hace por **copia de streams** | Decisión del operador (16-oct-2026). El corte limpio se ve igual de bien en este nicho, elimina una generación de recodificación en la unión, quita dos decisiones por vídeo del panel y deja la capa transformativa donde de verdad se ve: el overlay. Consecuencia en el código: fuera `xfade` y fuera el `zoompan` del primer clip |
| ADR-11 | **Encuadre automático**: el clip horizontal con un clip vertical centrado se recorta al **área nítida**; el vertical no se recorta. Si la confianza es baja, se rellena con negro sin recortar | Decisión del operador (18-oct-2026). Los clips de entrada llegan en los dos formatos y el operador no debe recortar a mano ni decidir por vídeo; el render sigue siendo automático (ADR-8). La detección usa 12 fotogramas a 192 px y un refino a resolución completa, así que no compite con la codificación. El caso de fallo se resuelve ignorando islas nítidas aisladas y, si no hay confianza, no se recorta |

---

## 16. Preguntas abiertas

1. **Banner de referencia**: ¿el operador lo sube por ranking, o hay una biblioteca fija por
   temática y el sistema solo elige? El MVP asume una biblioteca propia y el banner entra como
   parte del preset (no por vídeo).
2. **Duración objetivo** del short (30–58 s por defecto): ¿se quiere admitir un formato «TOP 10»
   más largo? Hoy el número de puestos llega a 10, pero el techo de duración sigue siendo 58 s.
3. **Idioma y tono** de los textos (`clip_label`, título y subtítulo): el preset no los fija.

---

## 17. Anexos

### 17.1 Variables de entorno

| Variable | Defecto | Uso |
| --- | --- | --- |
| `OPENRANKS_ITEMS` | `5` | Puestos del ranking (de 5 a 10); el panel lo fija por trabajo |
| `OPENRANKS_WIDTH` / `OPENRANKS_HEIGHT` | `1080` / `1920` | Lienzo de salida |
| `OPENRANKS_FPS` | `30` | Fotogramas por segundo |
| `OPENRANKS_FIT` | `auto` | Encuadre del clip (`auto` \| `band` \| `contain` \| `cover`) |
| `OPENRANKS_CRF` / `OPENRANKS_PRESET` | `19` / `medium` | Calidad y preset de x264 (no confundir con el preset visual) |
| `OPENRANKS_AUDIO_BITRATE` / `OPENRANKS_SAMPLE_RATE` | `192k` / `48000` | Audio de los tramos normalizados |
| `OPENRANKS_LOUDNESS_LUFS` | `-14.0` | Objetivo de loudness |
| `OPENRANKS_MIN_CLIP_SECONDS` / `MAX_CLIP_SECONDS` | `1.0` / `30.0` | Banda por clip |
| `OPENRANKS_MIN_TOTAL_SECONDS` / `MAX_TOTAL_SECONDS` | `30.0` / `58.0` | Banda del vídeo unido |
| `OPENRANKS_FONT` | `Arial` (`DejaVu Sans` en el contenedor) | Familia del overlay (libass la resuelve por nombre) |
| `OPENRANKS_PRESET_FILE` | — | Plantilla guardada por el panel; se aplica sobre la de fábrica |
| `OPENRANKS_JOBS_DIR` | `web/.jobs/` | Directorio de trabajos (volumen en Docker) |
| `OPENRANKS_ROOT` / `OPENRANKS_PYTHON` | — / autodetectado | Dónde está el motor y con qué intérprete |
| `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` | — | Binarios de FFmpeg (si no, PATH o el de npm) |

El arranque local, la utilidad del venv y el orden de resolución de Python/FFmpeg están en el
plan, §12.1.
