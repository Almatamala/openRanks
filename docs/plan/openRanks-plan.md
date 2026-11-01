# openRanks — plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **Fase 1 (L1, L2 y panel) construida y verificada.** **Fase 2 (galería y navegación) construida y probada; solo queda pasar el checklist E2E de §13.3 en el navegador.** **Fase 3 (L3 · Extractora) diseñada y desglosada (P3-1 a P3-8, §12) con su verificación (§13.4); P3-1 y P3-2 construidas** |
| **Fecha** | 28-oct-2026 |
| **Alcance** | **Plan**: en qué orden se construye, qué entrega cada capa, qué está hecho, cómo se verifica y qué falta. El **qué y el por qué** están en el RPD (`docs/rpd/openRanks-rpd.md`) |
| **Documentos** | **RPD** + **plan** (este). La numeración `§` es **compartida y estable**: §1–§11 y §14–§17 viven en el RPD; §12–§13 viven aquí |

Este documento no repite el producto, el formato ni las reglas de estilo: eso está en el RPD.
Aquí solo se registra **cómo se construye y cómo se comprueba**.

---

## Orden de prioridades del producto

**Decisión del operador (13-oct-2026): se construye de atrás hacia delante, empezando por el
vídeo terminado.** El orden es `L1 → L2` y, después, la **Fase 2** del panel (galería y
navegación).

| Prio | Capa | Qué entrega | Estado |
| --- | --- | --- | --- |
| **1** | **L1 · Ensamblador** | Los clips ya listos (normalizados, 9:16, 30 fps, audio a −14 LUFS) **y su unión en un solo vídeo vertical en corte seco** | **Hecho** |
| **2** | **L2 · Editor de la plantilla** | Sobre la unión, **toda la edición del estándar**: título, subtítulo opcional, escalera de rangos, rótulo por puesto, medallas del podio y atenuado de lo que no tiene el turno. **Render automático y estilo bloqueado** | **Hecho** |
| **3** | **Fase 2 · Galería y navegación (panel)** | Menú lateral, galería persistente con categorías, selección ordenada de 5 a 10, generación manual, reordenación por arrastre y borrado de los usados | **Hecho (checklist E2E manual pendiente)** |
| **4** | **Fase 3 · Extractora (L3)** | Ingesta multi-fuente (YouTube, TikTok y archivos locales), segmentación en escenas con revisión, score de viralidad de 0 a 100, selección manual o automática y aterrizaje en la galería | **En construcción: P3-1 y P3-2 hechas (entrada con casilla de cumplimiento y descarga al área temporal); faltan análisis, score y automático** |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `prepared/NN.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `spec.json`.

La **Fase 3 (L3 · Extractora)** está **diseñada en el RPD** (§4.4, §5.5 y RF-16 a RF-20),
**desglosada** en tareas (P3-1 a P3-8, §12) con su verificación (§13.4) y **en construcción**:
P3-1 —sección «Extraer clips», casilla de cumplimiento y detección de `yt-dlp`— y P3-2 —descarga
al área temporal con progreso, límites y cancelación— ya están en el panel; lo que sigue es el
análisis en escenas (P3-3). La **publicación (L4) sigue fuera del alcance**. La
generación automática del panel (RF-15) se activa con la Fase 3 y su criterio ya está fijado en
RF-19: score 0-100 y el mejor clip al final (#1).

---

## Estado de implementación (28-oct-2026)

Lo construido y verificado, con la pieza donde vive (la Fase 2 se detalla debajo):

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Configuración y contrato de entrada | `openranks/core/config.py`, `core/binding.py` | Formato de salida, bandas de duración, límites del texto, ranking de 5 a 10 puestos |
| Medición del material | `openranks/core/media.py` | `ffprobe`, contrato del clip de entrada y del archivo normalizado |
| Comandos de FFmpeg | `openranks/core/ffmpeg.py` | Normalización al marco vertical con recorte opcional, `loudnorm` en dos pasadas, unión por copia de streams |
| Encuadre del clip | `openranks/core/framing.py`, `openranks/framing.py` | Clasificación vertical/horizontal, detección del área nítida, refino a resolución completa, confianza y fallback sin recorte |
| Plan del montaje | `openranks/core/plan.py` | Orden `#5 → #1` y duración real (suma exacta) |
| Overlay (spec y ASS) | `openranks/core/specs.py`, `core/overlay.py` | Ventanas de tiempo, encaje del título, escalera, rótulos y el script ASS |
| Progreso | `openranks/core/progress.py` | Porcentaje medido, fase con nombre humano y ETA honesto en el panel |
| Orquestación L2 | `openranks/overlay.py` | Editar y verificar, con manifiesto |
| Etapas de L1 | `openranks/prepare.py`, `openranks/join.py` | Preparar **un** puesto al subirlo (el tick) y unir los preparados al pulsar «Montar», antes del render |
| CLI | `openranks/cli.py` | `prepare`, `join`, `render`, `preview`, `preset` |
| Panel | `web/` (Next.js) | Flujo completo sin terminal: subir (prepara solo), escribir, montar, ver y descargar el ranking |
| Plantilla guardable | `web/lib/preset.ts`, `openranks/core/overlay.py` | Preset editable y persistente que el motor lee por `OPENRANKS_PRESET_FILE` |
| Texto guardable | `web/lib/text-draft.ts`, `web/app/api/text` | Botón **Guardar** junto al título y el subtítulo; respaldo en `text.json` para una sesión sin borrador local |
| Pruebas | `tests/` | Núcleo puro sin FFmpeg + integración real con FFmpeg |
| Pruebas del panel | `web/test/` | Lógica pura de galería, selección y orden, y contrato de la API de la galería, con `node --test` |

**Estado — Fase 2.** La galería (`library/` + `library.json`), el menú lateral, la selección
ordenada, la generación manual, el arrastre de puestos y el borrado de usados están
implementados en el panel, más la descarga opcional de la unión sin edición (**P2-9**).
**P2-8 está cerrada en su parte automática**: 20 pruebas `node --test` (`web/test/`) de la
lógica pura y del contrato de la API de la galería, en CI. Lo único que queda de la fase es
pasar el checklist E2E de §13.3 en un navegador, que no se puede automatizar.

**Pruebas del panel.** `npm test` (o `npm run test` desde la raíz) corre
`node --experimental-strip-types --import ./test/loader.mjs --test test/*.test.mjs` dentro de
`web/`, sin dependencias nuevas: `test/loader.mjs` resuelve el alias `@/` y las extensiones
`.ts` como lo hace Next.

**La interfaz es el punto de entrada único** (RF-9): no hay paso que exija terminal, `curl`
ni un editor externo, y el panel no enseña rutas, ids internos ni JSON crudo.

### Reglas del producto que el plan no reabre

Las decisiones de producto están cerradas y cualquier cambio de código debe respetarlas. El
detalle y el motivo de cada una están en el RPD: **solo texto editable y render automático**
(ADR-8, §6/RF-7), **corte seco** (ADR-10, §3), **encuadre automático** (ADR-11, §9) y **panel
único** (RF-9, §10.6). La Fase 2 añade el **orden de los puestos** (RF-13) como decisión de
montaje: no reabre el estilo ni convierte el panel en un editor. Si una tarea del plan parece
exigir tocar esas reglas, se cambia el RPD/ADR primero, no el código por detrás.

---

## 12. Plan de ejecución

| Capa (prioridad) | Contenido | Estado |
| --- | --- | --- |
| **L0** — Esqueleto | repo, contrato de entrada, medición, CI, legal | **Hecho** |
| **L1** — Clips listos y unión vertical | normalización 9:16 por clip, unión en corte seco, audio a −14 LUFS | **Hecho** |
| **L2** — Edición del estándar | overlay ASS, escalera, rótulos, spec, preset editable | **Hecho** |
| **F2** — Galería y navegación (panel) | menú lateral, galería persistente, categorías, selección 5-10, generación manual, arrastre y borrado de usados | **Hecho (checklist E2E manual pendiente)** |
| **F3** — Extractora (L3) | ingesta multi-fuente, segmentación en escenas, score de viralidad 0-100, selección manual o automática | **En construcción (P3-1 y P3-2 hechas, P3-3 a P3-8 pendientes)** |

### 12.1 Entorno local: Python, venv y FFmpeg

El panel resuelve el intérprete y FFmpeg por su cuenta, en este orden:

- **Python**: `OPENRANKS_PYTHON` → `.venv` del repo → `py -3` / `python` (Windows) o
  `python3` / `python` (resto).
- **FFmpeg** (se exige 5+): `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH` → npm
  (`ffmpeg-static` + `ffprobe-static`) → `static_ffmpeg` del venv.
- **yt-dlp** (opcional, solo para extraer de un enlace): `OPENRANKS_YTDLP` → `.venv` del
  repo → `PATH`. Es una herramienta externa, no una dependencia del montaje.

Por eso **el panel no necesita el venv**: `npm run dev` desde la raíz funciona con Node y un
Python 3.11+ del sistema.

**¿Para qué sirve activar el venv?** No es un requisito del repo, sino una comodidad de la
terminal en la que se trabaja: al activarlo, `python`, `pip`, `pytest` y el comando
`openranks` apuntan al entorno del repo en vez de al Python global. Eso evita mezclar
versiones e instalar dependencias de desarrollo fuera del entorno. **La activación no cambia
la resolución del panel** (que ya mira `.venv` por ruta absoluta) y **no configura FFmpeg**
por sí solo: los binarios se resuelven por las variables o por el `PATH`, y `static_ffmpeg`
del venv solo entra como último recurso. Si no lo activas, usa el intérprete explícito
(`.venv/Scripts/python -m pytest -q`), que es la forma en que el panel lanza el motor.

Recomendación: activarlo **solo en la terminal donde se van a correr el CLI o los tests**, no
como paso obligatorio al arrancar el repo.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"      # Linux/macOS: .venv/bin/python
.venv/Scripts/python -m pip install -e ".[extract]"  # opcional: yt-dlp para extraer enlaces
source .venv/Scripts/activate                        # Linux/macOS: source .venv/bin/activate
python -m pytest -q
```

### L0 — Esqueleto y terreno firme · **hecho**

| Entregable | Detalle |
| --- | --- |
| Repo + forma de correrlo | motor Python (stdlib puro) + panel Next.js; `docker-compose.yml` de un solo servicio con FFmpeg y fuentes dentro |
| Contrato de entrada | `core/config.py` + `core/binding.py`: formato, bandas, límites de texto, ranking de 5 a 10 |
| Medición y validación | `core/media.py`: contrato del clip de entrada y del normalizado |
| CI | workflow que instala FFmpeg y fuentes, corre `python -m pytest -q` y compila el panel (`npm ci` + `typecheck` + `build`) |
| Legal | checklist de fuentes (§11) |

### L1 — Entregable 1: clips listos y un solo vídeo vertical · **hecho**

| Entregable | Detalle |
| --- | --- |
| Normalización por clip | 1080x1920 / 30 fps / yuv420p; **encuadre automático** con detección del área útil y fallback sin recorte; `band`/`contain`/`cover` siguen disponibles |
| «Sin recortes pendientes» | el clip final se publica tal cual: bordes limpios, sin barras negras, sin recodificar después |
| Unión vertical | `core/plan.py`: orden `#5 → #1` y duración real (suma exacta), **corte seco por copia de streams** |
| Preparación por puesto | `prepare` normaliza **un** clip al subirlo y deja `prepared/NN.mp4`: es lo que enciende el tick del panel, sin bloquear los demás puestos |
| Salida interna | **un clip preparado por puesto** + **un solo `union.mp4`** con audio a −14 LUFS; el ranking es el entregable principal y la unión se ofrece como descarga opcional sin edición (P2-9) |
| **Salida (criterio)** | `ffprobe` valida los archivos (1080x1920, 30 fps, yuv420p, audio presente); el operador descarga el `ranking.mp4` que produce L2 y, opcionalmente, la `union.mp4` sin edición |

### L2 — Entregable 2: la edición del estándar · **hecho**

| Entregable | Detalle |
| --- | --- |
| Plantilla = datos | `Template + Binding → spec.json`; **`Template` bloqueado** y `Binding` con **solo texto** (título + subtítulo opcional + N nombres) |
| Overlays | escalera de posición con la casilla de turno nítida, rótulo por clip, medallas del podio |
| Renderer | **ASS + FFmpeg** (`libass`), el mismo motor que hace L1 (§9.3). Sin segundo runtime |
| Verificaciones | `spec.json`, `manifest.json` y determinismo (mismo spec ⇒ mismo MP4) |
| Render automático | **sin ningún paso manual de montaje**: dados el preset y los textos, el MP4 sale solo |
| Cambio de texto | re-render de **solo la capa de overlay** sobre el `union.mp4`, recalculando el encaje de §9.5 |
| **Salida (criterio)** | sobre el `union.mp4` de L1 sale un `ranking.mp4` publicable; el overlay **dibuja de verdad** (test de píxeles) y el cambio de texto tarda segundos |
| Pendiente de L2 | **banner con la foto de referencia** (`assets/banners/`) y **música/sfx** con la cama a −14 LUFS: requieren assets propios y van desactivados por defecto |

### F2 — Galería y navegación (panel) · **hecho (P2-8 cerrado salvo el checklist E2E)**

Depende de la Fase 1: el panel y el motor ya están verdes. **El motor no se toca**: la galería
guarda originales y, al generar, los copia a `input/`; `prepare` → `join` → `render` siguen
siendo los mismos.

| Tarea | Entregable | Depende de | Verificación |
| --- | --- | --- | --- |
| **P2-1** | Galería en disco: `library.json` + `library/<id>.<ext>`, con subida, listado, filtro y edición de categoría. APIs del panel para crear, listar y actualizar. | — | El índice y los archivos sobreviven a un reinicio; la API no expone rutas del host; subir un formato no permitido falla con un error legible. |
| **P2-2** | Layout con **menú lateral persistente y retraíble**: «Montar ranking» y «Galería de videos», sección activa, foco y navegación por teclado. | — | Con el menú desplegado, ambas secciones a un clic; la activa está marcada; retraído deja una barra etiquetada para abrirlo; ir a la galería y volver no pierde el montaje. |
| **P2-3** | UI de galería: subida, tarjetas, categoría en línea con autocompletado, filtro, selección ordenada, contador y límite de 10. | P2-1, P2-2 | Subir → recargar → sigue; categoría y filtro correctos; 4 seleccionados deshabilitan «Generar manual»; el 11.º no se puede seleccionar. |
| **P2-4** | **Generar manual**: valida 5-10, confirma el reemplazo si hay montaje, reemplaza casillas y `input/`/`render/` anteriores, copia los originales, prepara por puesto y abre Montar con las casillas en orden. | P2-3 | Con 5-10, las casillas quedan #1… y encienden su tick; cancelar la confirmación no cambia nada; no quedan archivos del montaje anterior; el selector de puestos sigue activo tras generar; el motor recibe los mismos comandos de siempre. |
| **P2-5** | **Arrastrar y soltar** desde el borde izquierdo: intercambia puestos, renumera, mueve los preparados con su clip (sin recodificar) e invalida unión/edición; solo prepara lo afectado si todavía no lo estaba. Equivalente por teclado. | P2-4 | Arrastrar #5 sobre #1 intercambia ambos; el vídeo sale en el nuevo orden; los ticks siguen encendidos porque los preparados se mueven, no se recodifican; la unión anterior deja de valer; las flechas del asa hacen lo mismo. |
| **P2-6** | **Borrar videos utilizados**: aparece junto a Descargar solo con un ranking correcto; confirmación; borra los N clips de la galería y del disco; limpia casillas; conserva el ranking. | P2-4, P2-5 | Confirmar elimina exactamente los N clips y deja el `ranking.mp4` descargable; cancelar no cambia nada; no toca otros clips ni otros trabajos. |
| **P2-7** | **Generar automático** visible y deshabilitado con «Próximamente», sin endpoint ni side effects. | P2-3 | `disabled`/`aria-disabled`; un clic no hace ninguna petición; no hay ruta de generación automática. |
| **P2-8** | Pruebas y documentación de la fase: lógica pura de galería, selección, orden e intercambio de puestos con `node --test`, contrato de la API de la galería, typecheck/build y checklist E2E del flujo completo. | Todas | CI en verde (pytest, `node --test`, typecheck, build); el checklist de §13.3 se pasa entero; RPD/plan actualizados si cambia una decisión. |
| **P2-9** | **Descarga sin edición**: botón extra en Resultado que sirve `union.mp4`; las dos descargas van juntas y «Borrar videos utilizados» queda debajo, en rojo difuminado. | P2-4, P2-5 | `union.mp4` se descarga y se reproduce sin overlay; el ranking sigue siendo el entregable principal; el borrado conserva su confirmación. |

**Estado (28-oct-2026):** P2-1 a P2-9 implementados en el panel, y **P2-8 cerrada en su
parte automática**: pruebas `node --test` de la lógica pura y del contrato de la API de la
galería, en CI. Falta pasar el checklist E2E de §13.3 en el navegador.

**Orden recomendado:** P2-1 → P2-2 → P2-3 → P2-4 → P2-5 → P2-6. P2-7 puede hacerse en
cuanto exista la galería; P2-8 se cierra al final de la fase, con las pruebas de cada tarea ya
verdes.

### F3 — Extractora (L3) · **en construcción: P3-1 y P3-2 hechas, P3-3 a P3-8 pendientes**

Diseñada en el RPD (RF-16 a RF-20, ADR-17 a ADR-20, §5.5 y §7.8). **No toca el montaje**: los
clips aprobados aterrizan en la galería de la Fase 2 y el flujo sigue siendo seleccionar →
generar manual o automático → montar → descargar. Lo nuevo es la entrada: de dónde salen los
clips. El motor de L1/L2 (`prepare` → `join` → `render`) no gana comandos.

Las dos dependencias externas son **opcionales**: `yt-dlp` para el enlace y un **cliente LLM por
HTTP** para el score. Sin la primera queda el archivo local; sin la segunda, el score heurístico y
la selección manual. Ninguna entra en las dependencias de Python del repo: `yt-dlp` es una
herramienta externa como FFmpeg y el cliente LLM usa `urllib` de la stdlib.

| Tarea | Entregable | Depende de | Verificación |
| --- | --- | --- | --- |
| **P3-1** | **Sección «Extraer clips»** en el menú lateral, junto a «Montar ranking» y «Galería de videos», con las dos entradas (enlace o archivo local) y la **casilla de cumplimiento** obligatoria justo debajo del enlace: términos de la plataforma y política de privacidad (§11.7), con la plataforma que sale del propio enlace. Validación de plataforma admitida y de URL; detección de `yt-dlp` (`OPENRANKS_YTDLP` → `.venv` del repo → `PATH`) con error accionable. Sin endpoint de descarga todavía. | — | Sin la casilla marcada, «Extraer» está deshabilitado y no hace ninguna petición; sin `yt-dlp` el panel dice qué instalar y no crea trabajo; una URL inválida o de plataforma no admitida falla con mensaje legible y **0 archivos** (lo privado o con DRM se detecta al descargar, P3-2); la sección se alcanza con teclado, la activa está marcada y la UI no enseña rutas; `typecheck`/`build`. |
| **P3-2** | **Descarga a un área temporal** (`extract/source.*`) con progreso por fase, cancelación y los límites de la fuente: **60 min y 2 GB** (ajustables por entorno) y **una extracción a la vez**. El fallo o la cancelación no dejan restos, y nada descargado entra en la galería. | P3-1 | Un enlace propio completa y deja el archivo solo en el temporal; cancelar a mitad deja **0 archivos** y **0 entradas** en la galería; una fuente por encima de 60 min o 2 GB se rechaza con error accionable antes de llenar el disco; al lanzar una segunda extracción la primera manda y la segunda espera o se rechaza con mensaje; un enlace privado, con DRM o que pide sesión falla con mensaje legible y **0 archivos**; el estado y el log no contienen rutas del host. |
| **P3-3** | **Análisis y segmentación en escenas**: una pasada sin recodificar con `scdet` (score de **cada** fotograma), `signalstats` (luminancia) y `blackdetect`, **solo imagen** (el audio no se analiza); corte por **umbral adaptativo** al score local, sin que un **destello** parta la escena, con los bordes de un **fundido** como cortes y los tiempos normalizados con el `start_time` del contenedor; umbrales en el preset del extractor; fusión de los tramos de **<1 s** y partición de los de **>30 s**, con el corte **exacto** en el fotograma del cambio; `extract.json` determinista (cortes, umbrales, versiones y hash de la fuente) y miniaturas en `candidates/`. Aviso si no salen **≥5** tramos válidos. | P3-2 | Pruebas puras de umbral adaptativo, destellos, fundidos, fusión, partición y corte exacto: ningún candidato fuera de 1-30 s, sin solapes y mismo resultado en dos pasadas; un destello no parte la escena y un fundido no queda dentro de un clip; integración con FFmpeg sobre un compilado de cortes conocidos recupera **≥80 %** de los cortes con **≤20 %** de falsos positivos; mismo archivo y mismos umbrales ⇒ mismo `extract.json`; cambiar el umbral en el preset cambia la propuesta sin tocar código; con 4 tramos válidos se avisa de que no alcanza para un ranking y no se ofrece generar. |
| **P3-4** | **Parrilla de revisión y aterrizaje en la galería**: candidatos con miniatura, duración y score (si existe), y aprobar/descartar. Los aprobados se extraen del temporal (**copia** si el corte cae en keyframe, recodificando **solo ese tramo** si no) y entran en `library/` + `library.json` con procedencia, categoría, duración y hash; **deduplicación por hash** (se avisa y se reutiliza la entrada); el temporal se borra al cerrar la revisión. | P3-3 | Aprobar 6 deja exactamente **6 clips** con procedencia y duración en banda; descartar todos no deja nada; reextraer el mismo tramo avisa y reutiliza la entrada (**1 archivo**, no 2); al cerrar la revisión el temporal desaparece y el espacio ocupado es el de los aprobados; los clips aprobados se filtran, seleccionan, generan y montan como cualquier otro de la Fase 2; «Borrar videos utilizados» sigue borrando solo los de ese ranking. |
| **P3-5** | **Score heurístico 0-100**, local y sin red: movimiento y cambio visual, caras, energía y picos de audio, texto en pantalla, duración y fuerza del primer segundo; **2-3 razones** cortas y fuente `heurístico`; se guarda con **hash del clip, versión del modelo y fecha** y se muestra en la parrilla, en la galería y en el montaje. | P3-4 | El 100 % de los scores está en 0-100 y trae sus razones; el mismo archivo dos veces da el mismo score; **<1 s** por clip; ninguna petición de red; la correlación con el orden humano (**Spearman ≥0,6**, RF-18) se mide en P3-8 sobre el set dorado; el score nunca bloquea la selección ni el montaje. |
| **P3-6** | **Refinamiento del score con LLM, opcional**: cliente HTTP sin SDK (chat completions con la miniatura en data URL y **JSON Schema**), configurable por `OPENRANKS_LLM_*`; **una sola llamada por trabajo** con el mismo modelo y prompt; estimación de tokens antes de enviar, **tope de 0,02 USD por trabajo** y caché por hash. Sin clave, sin red, por encima del tope o con error del proveedor, el clip se queda con el heurístico y el panel lo avisa. | P3-5 | Una extracción de 10 clips hace **1** llamada y no 10; un score fuera de 0-100, sin razones o con JSON inválido se descarta y cae al heurístico; con la clave ausente, un 5xx o un *timeout* el trabajo completa con scores heurísticos marcados; el coste estimado por trabajo queda **≤0,002 USD** con Haiku y nunca se llama por encima de **0,02 USD**; dos clips con el mismo hash no se vuelven a puntuar; modelo, versión de prompt y fecha quedan en `extract.json`. Se prueba contra un servidor local de prueba, nunca contra el proveedor. |
| **P3-7** | **Selección automática y orden por score (RF-19)**: «Generar automático» deja de estar deshabilitado; elige **5-10** por score y diversidad, cabe en **30-58 s**, no repite clip y **explica la elección**; el orden es ascendente en reproducción, con **el mejor en el #1**. Aceptar deja la misma selección, casillas y ticks que el camino manual, y el operador puede ajustarla después. | P3-5 | Con 10 clips de scores conocidos, el orden de `prepared/NN.mp4` y del `spec.json` es ascendente y el #1 es el de mayor score; nunca elige <5 ni >10, no repite clip y la suma cabe en 30-58 s (o avisa como en L1); aceptar deja casillas y ticks equivalentes al camino manual; sin scores el botón sigue deshabilitado y explica el motivo, y «Generar manual» no cambia. |
| **P3-8** | **Set dorado, pruebas y documentación de la fase**: set dorado con clips de material propio o licenciado y orden humano, script de evaluación (Spearman, p95 y coste), pruebas puras del extractor (fusión/partición/corte exacto, features del score, normalización y razones, orden ascendente, deduplicación, estimación de coste y cliente LLM contra servidor local), integración real de detección y extracción, contrato de la API de la extracción, CI con `pytest` + `node --test` + `typecheck` + `build`, y RPD/plan actualizados (estado de la fase y variables nuevas en §17.1). | Todas | CI en verde; **Spearman ≥0,6** sobre el set dorado y **p95 <20 s** por trabajo con LLM; coste medido **≤0,002 USD** por trabajo; checklist de §13.4 pasado entero; `extract.json` y manifiestos sin rutas del host; ninguna prueba toca la red del proveedor ni necesita clave. |

**Decisiones abiertas que condicionan la fase** (RPD §16): la **transcripción** (12) queda fuera de
P3-6, que puntúa imagen y metadatos hasta que se decida; los **umbrales** (13) arrancan en el preset
del extractor y se calibran en P3-3/P3-8 por tipo de contenido; la **retención del original** (14)
es la de P3-4 (se borra al cerrar la revisión) salvo que se decida lo contrario; el **presupuesto y
la titularidad de la clave** (16) bloquean solo P3-6, que sin clave sigue con el heurístico. La
ingesta es **una URL por extracción** (11), ya cerrado en RF-16.

**Orden recomendado:** P3-1 → P3-2 → P3-3 → P3-4 → P3-5 → P3-6 → P3-7 → P3-8. Cada tarea deja el
panel usable sin la siguiente: se puede montar un ranking con score heurístico y selección manual
antes de que exista el LLM, y P3-6 y P3-7 se pueden intercambiar (el automático solo necesita
scores). Las variables de P3-1 y P3-2 (`OPENRANKS_YTDLP`, `OPENRANKS_SOURCE_MAX_MINUTES` y
`OPENRANKS_SOURCE_MAX_MB`) ya están en el anexo §17.1 del RPD; las `OPENRANKS_LLM_*` se añaden
con P3-6.

**Estado (28-oct-2026): P3-1 y P3-2 construidas y probadas.**

- **P3-1**: la sección «Extraer clips» está en el menú lateral con las dos entradas (enlace o
  archivo local), valida el enlace contra las plataformas admitidas, exige la **casilla de
  cumplimiento** (términos de la plataforma y política de privacidad) y detecta `yt-dlp` por
  `OPENRANKS_YTDLP` → `.venv` del repo → `PATH` con un aviso accionable que no enseña rutas.
  Pruebas:
  `web/test/extract.test.mjs`.
- **P3-2**: «Extraer» arranca la descarga a `extract/<id>/source.*` con **una descarga a la
  vez**, avance medido (`[download] …%`), velocidad, tiempo restante y cancelación que borra el
  temporal. Los límites (`OPENRANKS_SOURCE_MAX_MINUTES` = 60 y `OPENRANKS_SOURCE_MAX_MB` = 2048)
  se aplican en tres sitios: el filtro de metadatos y `--max-filesize` de `yt-dlp` antes de
  bajar, y una vigilancia del tamaño en disco que corta la descarga cuando hace falta. Si el
  panel se reinicia a mitad, la descarga se marca interrumpida y el temporal se borra. Pruebas:
  `web/test/download.test.mjs`, `web/test/extract-job.test.mjs` (proceso simulado) y
  `web/test/extract-api.test.mjs`.

**Relación con §12.3.** P3-6 y P3-7 construyen el mínimo que ya fijan RF-18 y RF-19: score
heurístico, **una** llamada al LLM por trabajo y orden ascendente por score. No necesitan
transcripción, embeddings ni RAG, que siguen en el roadmap de §12.3 sin bloquear la fase; si algún
día entran, lo hacen **sobre** estos scores, no en su lugar.

### 12.2 Fuera del alcance actual

- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes y analítica.
- **Algoritmo de generación automática**: el criterio ya está definido en el RPD (RF-18, RF-19 y
  ADR-19: score 0-100 y el mejor clip al final), pero **no hay implementación**: el botón sigue
  deshabilitado (P2-7) hasta que se construya la Fase 3 (P3-7). El roadmap de IA/LLM está en §12.3 y **no
  está activo**.
- **v2+**: voz en off/TTS, autopilot por canal, reescritura de bordes, generación de banners por
  IA, multi-idioma y A/B de estilos.

Si se retoma alguna, primero se documenta en el RPD y se añade aquí su entregable y su
verificación; no se construye por detrás de estas reglas.

### 12.3 Plan de IA y automatización con LLM (futuro, no activo)

> **No forma parte del alcance actual.** Hoy la única IA en producción es **visión artificial
> clásica** para el encuadre automático (§L1). No hay LLMs, RAG, embeddings, modelos tabulares
> ni MLOps con monitoreo. Esta sección ordena el trabajo futuro para que, si se aprueba, entre
> por el RPD y no por detrás del plan. El proveedor del score de la Fase 3 (IA-2) ya está
> decidido en el RPD §7.9 y ADR-20: Claude Haiku 5.5, ≈0,0011 USD por trabajo de 10 clips.

**Regla de entrada:** antes de implementar cualquier tarea de este bloque se define el RF/ADR
correspondiente en el RPD, se añaden sus criterios de aceptación y se actualiza §13. Ninguna
tarea se considera comprometida hasta que exista esa definición.

| Tarea | Entregable | Depende de | Verificación |
| --- | --- | --- | --- |
| **IA-0** | **Datos y evaluación**: dataset versionado con clips, metadatos, transcripciones, logs de trabajos y resultados de publicación; set dorado de consultas, títulos y rankings con rúbrica; política de privacidad, retención y coste por 1k inferencias. | — | Dataset reproducible; set dorado revisado; sin datos personales ni secretos; coste medido. |
| **IA-1** | **RAG y embeddings**: transcripción con Whisper, embeddings del catálogo, índice vectorial (pgvector/Qdrant), búsqueda semántica con citas a clip/minuto, deduplicación y diversidad. | IA-0 | Recall@k/MRR sobre el set dorado; citas correctas; latencia p95; no inventa clips. |
| **IA-2** | **Agente planificador del ranking**: herramientas de búsqueda, scoring y validación; propone un TOP 5-10 bajo restricciones (30-58 s, categorías, diversidad), explica la decisión y pide aprobación humana. | IA-1, IA-4 | Cumple 5-10 puestos y 30-58 s; no inventa clips; comparación contra baseline; coste y latencia medidos. |
| **IA-3** | **Prompt engineering y evaluación de textos**: títulos, subtítulos, rótulos y ganchos con JSON Schema; prompts versionados; evaluación offline; *guardrails* y revisión humana. | IA-0, IA-1 | Rúbrica de claridad, no *spoiler* y longitud (§9.5); tasa de rechazo; coste por generación. |
| **IA-4** | **ML tabular y operacional**: predicción de falla de render, rendimiento de clips/rankings y demanda por categoría; features operativas; *gradient boosting* y series de tiempo; validación temporal. | IA-0 | Baselines; ROC-AUC/PR-AUC, MAE/MAPE y calibración; splits temporales sin *leakage*; SHAP. |
| **IA-5** | **MLOps**: DVC/lakeFS para datos, MLflow para experimentos y registro de modelos, CI/CD, Docker, inferencia batch/online, monitoreo de drift y rollback. | IA-4 | Reproducibilidad; modelo versionado; despliegue canary; alertas; disparador de reentrenamiento. |
| **IA-6** | **Orquestación, optimización y simulación**: DAG en Airflow/Composer (ingesta → transcripción → embeddings → scoring → entrenamiento → evaluación → despliegue → monitoreo), flujos event-driven en n8n y composición con OR-Tools/CP-SAT. | IA-1, IA-4 | DAG idempotente y reintentable; SLA; plan de ranking factible; simulación con datos históricos. |
| **IA-7** | **GCP**: despliegue de referencia con Vertex AI, BigQuery, Cloud Run, Cloud Storage, Artifact Registry y Composer; tabla de equivalencias AWS→GCP. | IA-5 | Pipeline end-to-end con un dataset pequeño; coste y latencia; documentación de despliegue. |
| **IA-8** | **Integración en producto (RF-15)**: activar «Generar automático», búsqueda semántica en la galería y textos asistidos; *feature flags* y aprobación humana antes de montar. | IA-1, IA-2, IA-3, IA-6 | A/B contra el flujo manual; sin regresión; coste medido; revisión humana obligatoria. |

**Orden recomendado:** IA-0 → IA-1 → IA-3 → IA-4 → IA-5 → IA-6 → IA-2 → IA-8. IA-7 puede
hacerse en paralelo después de IA-5. El primer corte demuestra el caso GenAI de punta a punta
(datos → embeddings → RAG → textos → evaluación); el segundo incorpora los modelos tabulares y
su operación; el tercero activa la generación automática en el producto.

---

## 13. Estrategia de verificación

### 13.1 Tests automáticos (CI en cada push)

- **Núcleo puro** (sin FFmpeg, sin red): plan y duración del corte seco, contrato del binding y
  límites del texto, ranking de 5 a 10 puestos, badges y rótulos (ventana nítida y atenuada),
  colores por puesto, título en capas y su encaje, script ASS, `argv` de FFmpeg, monotonía del
  porcentaje, plan de la unión a partir de los clips preparados y listado del preset. Son
  `tests/test_{binding,staged,specs,ffmpeg_args,media,manifest,config,overlay_args,progress,
  preset}.py`.
- **Integración** (FFmpeg de verdad sobre clips sintéticos, marcados `integration`):
  `test_staged_e2e.py` comprueba el criterio de salida de L1 (300 fotogramas y 10,0 s con 5
  clips de 2 s, sin audio perdido) y el flujo por etapas (`prepare` por puesto → `join` →
  `render`, con la unión intacta); `test_overlay_e2e.py` que `ranking.mp4` es 1080x1920/30
  fps/yuv420p con audio **y que el overlay dibuja de verdad** (comparación de píxeles contra la
  unión), y `test_framing_e2e.py` el encuadre de un clip sobre fondo borroso y su
  normalización con el crop. Se saltan si no hay FFmpeg.
- **Contrato con el panel**: hay tests que leen `web/lib/limits.ts` y `web/lib/preset.ts` para
  garantizar que el panel no ofrece lo que el motor rechaza (puestos, límites de texto y
  familias tipográficas).

### 13.2 Criterios de «hecho»

1. Requisitos del milestone implementados y con criterios de aceptación **medidos**, no supuestos.
2. Tests nuevos y existentes en verde, CI verde.
3. Sin secretos ni datos de terceros en el repo, commits o logs.
4. Documentación actualizada (RPD, plan, ADR si cambió una decisión, runbook si cambió la
   operación).

### 13.3 Verificación de la Fase 2

**Automática.** La lógica que no depende del DOM (asignación de puestos por orden de selección,
renumeración al deseleccionar, filtro por categoría, validación 5-10 e intercambio de puestos)
vive en funciones puras (`web/lib/gallery.ts`, `web/lib/slots.ts`) y se prueba con `node --test`,
sin dependencias nuevas. El contrato de la galería se prueba llamando a los handlers de
`web/app/api/library` con `Request` normales y el índice en un directorio temporal: subir,
listar, filtrar, categoría y borrado. Son `web/test/gallery.test.mjs`, `web/test/slots.test.mjs`
y `web/test/library-api.test.mjs`, y CI corre `npm test` junto a `pytest`, `typecheck` y `build`.
El checklist de abajo es lo único que queda en manos del operador.

| RF | Cómo se verifica |
| --- | --- |
| RF-10 | Paso 1 del checklist; ir a la galería y volver durante el paso 7; navegación con teclado; `typecheck`/`build`. |
| RF-11 | Paso 2 del checklist; persistencia tras reiniciar el panel; peticiones a la API sin rutas del host. |
| RF-12 | Pasos 3-6 del checklist; `node --test` del orden, renumeración y límites 5-10. |
| RF-13 | Paso 8 del checklist; prueba pura del intercambio de posiciones; orden del `ranking.mp4`. |
| RF-14 | Pasos 10-11 del checklist; conteo exacto de archivos borrados; descarga posterior. |
| RF-15 | Paso 12 del checklist; el control está deshabilitado y no existe endpoint de generación automática. |

**Checklist E2E (navegador, una sesión):**

| # | Paso | Resultado esperado |
| --- | --- | --- |
| 1 | Abrir el panel | Menú lateral con «Montar ranking» y «Galería de videos»; la sección activa está marcada. |
| 2 | Subir 3 clips a la galería, ponerles categoría y recargar | Los 3 siguen ahí con su categoría; el filtro por categoría los muestra. |
| 3 | Seleccionar 4 clips | «Generar manual» deshabilitado y aviso de cuántos faltan. |
| 4 | Seleccionar un 5.º | Botón habilitado; las casillas se generan en el orden de selección (#1 el primero). |
| 5 | Seleccionar hasta 10 | La tarjeta 11 no se puede seleccionar y se explica el máximo. |
| 6 | Deseleccionar un puesto intermedio | Los siguientes se renumeran sin huecos; el montaje en curso no cambia. |
| 7 | Generar con un montaje en curso | Pide confirmación; cancelar deja todo igual; aceptar reemplaza las casillas. |
| 8 | Arrastrar el #5 sobre el #1 desde el borde izquierdo | Se intercambian, los números se actualizan y el vídeo sale en el nuevo orden. |
| 9 | Montar y descargar | `ranking.mp4` correcto, visible y descargable. |
| 10 | «Borrar videos utilizados» → cancelar | No se borra ningún archivo ni se limpia ninguna casilla. |
| 11 | «Borrar videos utilizados» → confirmar | Desaparecen de la galería y del disco exactamente los N clips usados; las casillas quedan vacías; el ranking sigue descargándose. |
| 12 | «Generar automático» | Visible, deshabilitado y con «Próximamente»; no hace ninguna petición. |

Los casos borde de §5.4 del RPD se comprueban en los pasos 3, 5, 6, 7 y 10-11; los que no se
puedan automatizar quedan en este checklist y se revisan antes de cerrar la fase.

---

### 13.4 Verificación de la Fase 3

**Automática.** Igual que en la Fase 2: lo que no depende del DOM ni de FFmpeg vive en funciones
puras y se prueba sin red; lo que depende de FFmpeg se prueba sobre clips sintéticos marcados
`integration`; el cliente LLM se prueba contra un servidor local que devuelve el JSON Schema,
nunca contra el proveedor.

- **Entrada de material (P3-1, ya en CI)**: `web/test/extract.test.mjs` prueba las plataformas
  admitidas, los enlaces válidos e inválidos (sin esquema, no web, con credenciales), el mínimo y
  el tope del autor, y la fecha obligatoria, real y no futura.
- **Descarga (P3-2, ya en CI)**: `web/test/download.test.mjs` cubre los límites, los argumentos
  de `yt-dlp` y la lectura del progreso; `web/test/extract-job.test.mjs` el ciclo del trabajo con
  un proceso simulado (avance, cierre con archivo, fallo que limpia, cancelación que borra el
  temporal, corte por tamaño y descarga interrumpida); `web/test/extract-api.test.mjs` el
  contrato de la API (503 sin `yt-dlp`, 400 de enlace y declaración, 404) y que el ejecutable
  resuelto no sale en la respuesta.
- **Núcleo puro del extractor**: fusión de los tramos de <1 s, partición de los de >30 s, corte
  exacto y ventanas de los candidatos, features del score heurístico, normalización a 0-100 con sus
  razones, orden ascendente con el mejor al final, deduplicación por hash, estimación de coste y
  validación del JSON del LLM. Nombres de referencia: `tests/test_extract_plan.py`,
  `tests/test_score.py` y `tests/test_extract_ai.py`.
- **Integración** (`integration`, FFmpeg de verdad): `tests/test_extract_e2e.py` sobre un compilado
  sintético con cortes conocidos —**≥80 %** de cortes recuperados, **≤20 %** de falsos positivos,
  ningún candidato fuera de 1-30 s, y extracción de un tramo en keyframe y de otro fuera de
  keyframe— más el score heurístico sobre clips reales de 2 s.
- **Contrato con el panel**: `node --test` de la parrilla (aprobar/descartar, deduplicación,
  procedencia visible) y de la API de la extracción con `Request` normales y el índice en un
  directorio temporal, como `web/test/library-api.test.mjs`. El typecheck comprueba que el panel no
  ofrece plataformas, límites ni acciones que el motor rechaza.

| RF | Cómo se verifica |
| --- | --- |
| RF-16 | Pasos 1-5 del checklist; contrato de la API con URL inválida o no admitida (**0 archivos**), casilla sin marcar y `yt-dlp` ausente; `typecheck`/`build`. |
| RF-17 | Pasos 6-7 del checklist; pruebas puras de fusión, partición y corte exacto; integración de detección (≥80 % de cortes, ningún candidato fuera de banda, determinismo). |
| RF-18 | Pasos 8 y 12 del checklist; pruebas del heurístico (0-100, razones, determinismo, <1 s); Spearman ≥0,6 sobre el set dorado; cliente LLM contra servidor local (JSON inválido → heurístico, tope de coste, caché por hash). |
| RF-19 | Pasos 10-11 del checklist; prueba pura del orden ascendente con el mejor en #1; el automático respeta 5-10, no repite clip y la suma cabe en 30-58 s. |
| RF-20 | Pasos 6-9 del checklist; 6 aprobados = 6 entradas con procedencia y score sin rutas del host; reextracción sin duplicado (1 archivo); temporal borrado; «Borrar videos utilizados» intacto. |

**Checklist E2E (navegador, una sesión):**

| # | Paso | Resultado esperado |
| --- | --- | --- |
| 1 | Abrir el panel | El menú lateral suma «Extraer clips»; la sección activa está marcada y se alcanza con teclado. |
| 2 | Pegar un enlace sin marcar la casilla | «Extraer» está deshabilitado y explica por qué; no hay ninguna petición ni descarga. |
| 3 | Marcar la casilla y pulsar «Extraer» sin `yt-dlp` | Error legible con qué instalar; **0 archivos** y ninguna entrada en la galería. |
| 4 | Con `yt-dlp`, extraer un enlace propio | Progreso por fase con nombre humano; al terminar aparece la parrilla de candidatos con miniatura, duración y score. |
| 5 | Cancelar una extracción a mitad | No queda archivo temporal, ni entrada en la galería, ni trabajo a medias. |
| 6 | Recorrer la parrilla | Ningún candidato fuera de 1-30 s; descartar uno no deja nada; aprobar 6 crea **6 clips** con procedencia, categoría y score. |
| 7 | Cerrar la revisión | El archivo descargado desaparece; solo ocupan espacio los tramos aprobados. |
| 8 | Reextraer el mismo enlace y aprobar el mismo tramo | Avisa de que ya existe y reutiliza la entrada; no hay duplicado. |
| 9 | Ir a la galería | Los clips aprobados se filtran, seleccionan y generan como los de la Fase 2; «Borrar videos utilizados» borra solo los de ese ranking. |
| 10 | Con 5-10 seleccionados, «Generar automático» | Propuesta de 5-10 con la elección explicada y la suma dentro de 30-58 s; aceptar deja casillas y ticks como el camino manual. |
| 11 | Montar y descargar | El vídeo abre con el clip de menor score y cierra con el mejor, que ocupa el #1. |
| 12 | Repetir con el LLM sin configurar o caído | Los clips llevan score heurístico marcado como tal, el panel lo avisa y el montaje no se bloquea; «Generar manual» no cambia. |

Los casos borde del extractor —fuente demasiado larga, sin cortes suficientes, tramo duplicado— se
cubren en los pasos 3, 5, 6 y 8. Lo que no se pueda automatizar (la parrilla real con material de
terceros, la calidad percibida de los cortes y la coherencia del set dorado) queda en este checklist
y se revisa antes de cerrar la fase.

## Estado y siguientes pasos

- **L1 y L2 están hechas** (prioridades 1 y 2) y el **panel** (RF-9) cubre el flujo de esas dos
  capas.
- **La Fase 2** (prioridad 3) está construida: flujo **galería → selección → generar manual →
  montaje → descarga → borrar usados**, más el botón de generación automática deshabilitado y la
  descarga opcional sin edición. **P2-8 está cerrada en su parte automática** (pruebas
  `node --test` de la lógica pura y de la API de la galería, en CI); **queda pasar el checklist
  E2E de §13.3 en el navegador**, que es lo único que no se automatiza. La fase vive solo en el
  panel: el motor no gana comandos y sus pruebas siguen siendo la red de seguridad.
- El panel **no necesita el venv**: `npm run dev` desde la raíz resuelve un Python 3.11+
  cualquiera y el FFmpeg estático de npm. El venv es una comodidad para el CLI y los tests
  (§12.1).
- Pendiente de L2, ya previsto en el RPD: **banner con la foto de referencia**
  (`assets/banners/`, §9.2) y **música/sfx** con la cama a −14 LUFS (en MVP van desactivados,
  §9.2, y requieren assets propios).
- **La generación automática** del panel sigue deshabilitada (ADR-16): su criterio ya está en el
  RPD (RF-18, RF-19, ADR-19) y el botón se activa al construir la Fase 3.
- **El plan de IA y automatización con LLM** está documentado como roadmap candidato en §12.3,
  pero **no está activo**. Antes de implementar cada tarea se define su RF/ADR en el RPD.
- **La Fase 3 (L3 · Extractora)** está **diseñada en el RPD** —fuentes, segmentación al estilo
  CapCut, score 0-100 y orden con el mejor al final—, desglosada en tareas (P3-1 a P3-8) con su
  verificación (§13.4) y **en construcción**: **P3-1 y P3-2 ya están hechas** (entrada con
  casilla de cumplimiento y descarga al área temporal con progreso, límites y cancelación) y el siguiente paso
  es P3-3 (análisis y segmentación en escenas). No toca el montaje de L1/L2.
- **L4 sigue fuera del alcance** (ADR-7): no se construye ni se documenta con más detalle hasta
  que se retome.
