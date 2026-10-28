# openRanks — plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **Fase 1 (L1, L2 y panel) construida y verificada.** **Fase 2 (galería y navegación) construida y probada; solo queda pasar el checklist E2E de §13.3 en el navegador.** **Fase 3 (L3 · Extractora) diseñada en el RPD, sin construir** |
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
| **4** | **Fase 3 · Extractora (L3)** | Ingesta multi-fuente (YouTube, TikTok y archivos locales), segmentación en escenas con revisión, score de viralidad de 0 a 100, selección manual o automática y aterrizaje en la galería | **Diseñada en el RPD (RF-16 a RF-20, ADR-17 a ADR-19), sin construir** |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `prepared/NN.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `spec.json`.

La **Fase 3 (L3 · Extractora)** está **diseñada en el RPD** (§4.4, §5.5 y RF-16 a RF-20) y **no
construida**: no hay código, tablas ni endpoints de esa capa, y sus tareas de este plan están aún
por escribir. La **publicación (L4) sigue fuera del alcance**. La generación automática del panel
(RF-15) se activa con la Fase 3 y su criterio ya está fijado en RF-19: score 0-100 y el mejor clip
al final (#1).

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
| **F3** — Extractora (L3) | ingesta multi-fuente, segmentación en escenas, score de viralidad 0-100, selección manual o automática | **Diseñada en el RPD, sin construir** |

### 12.1 Entorno local: Python, venv y FFmpeg

El panel resuelve el intérprete y FFmpeg por su cuenta, en este orden:

- **Python**: `OPENRANKS_PYTHON` → `.venv` del repo → `py -3` / `python` (Windows) o
  `python3` / `python` (resto).
- **FFmpeg** (se exige 5+): `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH` → npm
  (`ffmpeg-static` + `ffprobe-static`) → `static_ffmpeg` del venv.

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
.venv/Scripts/python -m pip install -e ".[dev]"     # Linux/macOS: .venv/bin/python
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

### 12.2 Fuera del alcance actual

- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes y analítica.
- **Algoritmo de generación automática**: el criterio ya está definido en el RPD (RF-18, RF-19 y
  ADR-19: score 0-100 y el mejor clip al final), pero **no hay implementación**: el botón sigue
  deshabilitado (P2-7) hasta que se construya la Fase 3. El roadmap de IA/LLM está en §12.3 y **no
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
  CapCut, score 0-100 y orden con el mejor al final— y **no construida**. Antes de tocarla hay que
  escribir sus tareas y su verificación en §12 y §13, como se hizo con la Fase 2.
- **L4 sigue fuera del alcance** (ADR-7): no se construye ni se documenta con más detalle hasta
  que se retome.
