# openRanks — plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — servicio de generación y publicación de shorts de ranking a partir de vídeo largo |
| **Estado** | **L1, L2 y el panel están construidos y verificados**; L3 (extractora) y L4 (integración y publicación) son lo pendiente |
| **Fecha** | 21-oct-2026 |
| **Alcance** | **Plan**: en qué orden se construye, qué entrega cada capa, qué está hecho, cómo se verifica y qué falta. El **qué y el por qué** están en el RPD (`docs/rpd/openRanks-rpd.md`) |
| **Documentos** | **RPD** + **plan** (este). La numeración `§` es **compartida y estable**: §1–§11 y §14–§17 viven en el RPD; §12–§13 viven aquí. Así las referencias del código no se mueven al separar los documentos |
| **Repo de referencia** | **OpenShorts** (repositorio vecino). Copia/adaptación solo con licencia **MIT**, cabecera de origen y NOTICE; `cloud/` **nunca** se copia |

Este documento no repite el producto, el formato ni las reglas de estilo: eso está en el RPD.
Aquí solo se registra **cómo se construye y cómo se comprueba**.

---

## Orden de prioridades del producto

**Decisión del operador (13-oct-2026): se construye de atrás hacia delante, empezando por el
vídeo terminado.** El orden sigue vigente: `L1 → L2 → L3 → L4` (ADR-7).

| Prio | Capa | Qué entrega | Estado |
| --- | --- | --- | --- |
| **1** | **L1 · Ensamblador** | Los clips ya listos (normalizados, 9:16, 30 fps, audio a −14 LUFS) **y su unión en un solo vídeo vertical en corte seco** | **Hecho** |
| **2** | **L2 · Editor de la plantilla** | Sobre la unión, **toda la edición del estándar**: título, escalera de rangos, rótulo por puesto, medallas del podio, atenuado de lo que no tiene el turno. **Render automático y estilo bloqueado** | **Hecho** |
| **3** | **L3 · Extractora** | Los clips obtenidos solos desde un vídeo largo: segmentación, screening, scoring y selección — *el riesgo técnico real* | Pendiente |
| **4** | **L4 · Integrador** | Orquestación de punta a punta, publicación y operación | Pendiente (el panel ya cubre L1/L2) |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `prepared/NN.mp4` + `union.mp4` +
`manifest.json` (y `assemble` sigue haciendo las tres de una vez para uso por CLI); L2 produce
`ranking.mp4` + `spec.json`; L3 producirá **los mismos `clips/*.mp4`** que el operador aporta a
mano hoy. Consecuencia: **L2 y L3 no se conocen entre sí** y L4 solo orquesta.

---

## Estado de implementación (21-oct-2026)

Lo que está construido y verificado, con la pieza donde vive:

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Configuración y contrato de entrada | `openranks/core/config.py`, `core/binding.py` | Formato de salida, bandas de duración, límites del texto, ranking de 5 a 10 puestos |
| Medición del material | `openranks/core/media.py` | `ffprobe`, contrato del clip de entrada y del archivo normalizado |
| Comandos de FFmpeg | `openranks/core/ffmpeg.py` | Normalización al marco vertical con recorte opcional, `loudnorm` en dos pasadas, unión por copia de streams |
| Encuadre del clip | `openranks/core/framing.py`, `openranks/framing.py` | Clasificación vertical/horizontal, detección del área nítida, refino a resolución completa, confianza y fallback sin recorte |
| Plan del montaje | `openranks/core/plan.py` | Orden `#5 → #1`, cold open opcional, duración real (suma exacta) |
| Overlay (spec y ASS) | `openranks/core/specs.py`, `core/overlay.py` | Ventanas de tiempo, encaje del título, escalera, rótulos y el script ASS |
| Progreso | `openranks/core/progress.py` | Porcentaje medido, fase con nombre humano y ETA honesto en el panel |
| Orquestación L1 / L2 | `openranks/assemble.py`, `openranks/overlay.py` | Montar, verificar y editar, con manifiesto en cada paso |
| Etapas de L1 | `openranks/prepare.py`, `openranks/join.py` | Preparar **un** puesto al subirlo (el tick) y unir los preparados al pulsar «Montar», antes del render |
| CLI | `openranks/cli.py` | `assemble`, `prepare`, `join`, `render`, `preview`, `preset`, `probe`, `fit` |
| Panel | `web/` (Next.js) | Flujo completo sin terminal: subir (prepara solo), escribir, montar, ver y descargar el ranking |
| Plantilla guardable | `web/lib/preset.ts`, `openranks/core/overlay.py` | Preset editable y persistente que el motor lee por `OPENRANKS_PRESET_FILE` |
| Pruebas | `tests/` | Núcleo puro sin FFmpeg + integración real con FFmpeg |

**La interfaz es el punto de entrada único** (RF-9): no hay paso que exija terminal, `curl`
ni un editor externo. `GET /api/engine` responde «¿por qué no me monta?» sin abrir una
consola, y el panel no enseña rutas, ids internos ni JSON crudo.

### Reglas del producto que el plan no reabre

Las decisiones de producto están cerradas y cualquier cambio de código debe respetarlas. El
detalle y el motivo de cada una están en el RPD: **solo texto editable y render automático**
(ADR-8, §6/RF-7), **corte seco** (ADR-10, §3), **encuadre automático** (ADR-11, §9) y **panel
único** (RF-9, §10.6). Si una tarea del plan parece exigir tocar esas reglas, se cambia el
RPD/ADR primero, no el código por detrás.

---

## 12. Plan de ejecución

El orden es el de «Orden de prioridades del producto»: **L1 → L2 → L3 → L4** (ADR-7).

| Capa (prioridad) | Contenido | Estado |
| --- | --- | --- |
| **L0** — Esqueleto | repo, contrato de entrada, medición, CI, legal | **Hecho** (el despliegue completo con Postgres/MinIO llega con L4) |
| **L1** — Clips listos y unión vertical | normalización 9:16 por clip, unión en corte seco, audio a −14 LUFS | **Hecho** |
| **L2** — Edición del estándar | overlay ASS, escalera, rótulos, cover, spec, preset editable | **Hecho** |
| **L3** — Extractora | ingesta de YouTube, segmentación, screening, señales, scoring, selección | Pendiente |
| **L4** — Integrador | orquestación de punta a punta, publicación, trazabilidad, endurecimiento | Pendiente |

### L0 — Esqueleto y terreno firme · **hecho**

| Entregable | Detalle |
| --- | --- |
| Repo + forma de correrlo | motor Python (stdlib puro) + panel Next.js; `docker-compose.yml` de un solo servicio con FFmpeg y fuentes dentro |
| Contrato de entrada | `core/config.py` + `core/binding.py`: formato, bandas, límites de texto, ranking de 5 a 10 |
| Medición y validación | `core/media.py`: contrato del clip de entrada y del normalizado |
| CI | workflow que corre `core/` sin FFmpeg y, con FFmpeg + fuentes, la suite completa y el build del panel |
| Legal | checklist de fuentes (§11) |

### L1 — Entregable 1: clips listos y un solo vídeo vertical · **hecho**

| Entregable | Detalle |
| --- | --- |
| Normalización por clip | 1080x1920 / 30 fps / yuv420p; **encuadre automático** con detección del área útil y fallback sin recorte; `band`/`contain`/`cover` siguen disponibles |
| «Sin recortes pendientes» | el clip final se publica tal cual: bordes limpios, sin barras negras, sin recodificar después |
| Unión vertical | `core/plan.py`: orden `#5 → #1`, cold open opcional y duración real (suma exacta), **corte seco por copia de streams** |
| Preparación por puesto | `prepare` normaliza **un** clip al subirlo y deja `prepared/NN.mp4`: es lo que enciende el tick del panel, sin bloquear los demás puestos |
| Salida interna | **un clip preparado por puesto** + **un solo `union.mp4`** con audio a −14 LUFS; ninguno se descarga |
| **Salida (criterio)** | `ffprobe` valida los archivos (1080x1920, 30 fps, yuv420p, audio presente); el operador solo descarga el `ranking.mp4` que produce L2 |

### L2 — Entregable 2: la edición del estándar · **hecho**

| Entregable | Detalle |
| --- | --- |
| Plantilla = datos | `Template + Binding → spec.json`; **`Template` bloqueado** y `Binding` con **solo texto** (título + subtítulo opcional + N nombres) |
| Overlays | escalera de posición con la casilla de turno nítida, rótulo por clip, medallas del podio |
| Renderer | **ASS + FFmpeg** (`libass`), el mismo motor que hace L1 (§9.3). Sin segundo runtime |
| Verificaciones | `spec.json`, `manifest.json` y determinismo (mismo spec ⇒ mismo MP4); **sin portada** |
| Render automático | **sin ningún paso manual de montaje**: dados el preset y los textos, el MP4 sale solo |
| Cambio de texto | re-render de **solo la capa de overlay** sobre el `union.mp4`, recalculando el encaje de §9.5 |
| **Salida (criterio)** | sobre el `union.mp4` de L1 sale un `ranking.mp4` publicable; el overlay **dibuja de verdad** (test de píxeles) y el cambio de texto tarda segundos |
| Pendiente de L2 | **banner con la foto de referencia** (`assets/banners/`) y **música/sfx** con la cama a −14 LUFS: requieren assets propios y van desactivados por defecto |

### L3 — Entregable 3: la extractora · *el riesgo técnico real*

| Entregable | Detalle |
| --- | --- |
| Ingesta YouTube | `download_youtube_video`, `plan_download_attempts`, `cap_source_duration`, `yt_clients.py`, proxy de análisis, `MAX_SOURCE_MINUTES` |
| `core/segmentation.py` | resets, agrupación, banda de duración, cohesión y fusiones (§7.1), con el ablation por señal de §7.1 |
| Clasificador compilado/único | §7.2, con `force_mode` |
| Screening + señales | RF-3 y §7.3 + YOLO de sujeto |
| Scoring Gemini por lotes | esquema pydantic + `prompt_version` + contadores de coste reales (RF-4) |
| Selección TOP N | RF-5, determinista y testeada |
| Set de evaluación | 40 vídeos compilados con fronteras etiquetadas, **cosechado de los recortes manuales de L1** |
| Harness | `python -m tests.eval.segmentation` → precisión, recall, F1 de fronteras, MAE de recuento |
| **Salida (criterio)** | los mismos clips que en L1 pero obtenidos solos: F1 de fronteras ≥ 0,85, accuracy ≥ 0,9, Spearman ≥ 0,6 y ≤ 0,003 USD/clip |

### L4 — Entregable 4: una sola herramienta · *el cierre del círculo*

| Entregable | Detalle |
| --- | --- |
| Orquestador | una entrada (URL o archivo) → L3 → L1 → L2 → render, encima de la cola de `jobs` |
| Panel único (RF-9) | añade a lo que ya hay: tabla de clips con score y motivo, crear el ranking, sustituir un clip y publicar |
| Publicación | Upload-Post inmediato y programado, `TIKTOK_POST_MODE`, títulos por plataforma, `publications` |
| Trazabilidad | `review_decisions`, ledger de coste y manifiesto por render |
| Endurecimiento | recalibración con los rechazos reales, dedupe entre rankings, runbook, prueba de 50 fuentes/día |
| **Salida (criterio)** | 20 shorts publicados sin intervención manual salvo la revisión, y **sin salir del panel** |

### 12.1 Backlog priorizado (v2)

1. Ingesta de TikTok y de canales completos con autopilot (portar `cloud/autopilot.py`).
2. Ajuste fino de bordes de un clip ya cortado (recorte inteligente del inicio lento).
3. Generación de banners y fotos de referencia con IA + biblioteca por temática.
4. Voz en off corta («¡mira el #1!») y subtítulos animados.
5. Recalibración automática del umbral con la analítica real de las publicaciones.
6. Multi-idioma de textos y A/B de estilos de overlay.

---

## 13. Estrategia de verificación

### 13.1 Tests automáticos (CI en cada push)

- **Núcleo puro** (sin FFmpeg, sin red): plan y duración del corte seco, contrato del binding y
  límites del texto, ranking de 5 a 10 puestos, badges y rótulos (ventana nítida y atenuada),
  colores por puesto, título en capas y su encaje, script ASS, `argv` de FFmpeg, monotonía del
  porcentaje, plan de la unión a partir de los clips preparados y listado del preset. Son
  `tests/test_{binding,plan,specs,ffmpeg_args,media,manifest,config,overlay_args,progress,
  preset,staged}.py`.
- **Integración** (FFmpeg de verdad sobre clips sintéticos, marcados `integration`):
  `test_assemble_e2e.py` comprueba el criterio de salida de L1 (300 fotogramas y 10,0 s con 5
  clips de 2 s, sin audio perdido), `test_overlay_e2e.py` que `ranking.mp4` es 1080x1920/30
  fps/yuv420p con audio **y que el overlay dibuja de verdad** (comparación de píxeles contra la
  unión); `test_staged_e2e.py` el flujo por etapas (`prepare` por puesto → `join` → `render`, con
  la unión intacta y sin portada), y `test_framing_e2e.py` el encuadre de un clip sobre fondo
  borroso y su normalización con el crop. Se saltan si no hay FFmpeg.
- **Contrato con el panel**: hay tests que leen `web/lib/limits.ts` y `web/lib/preset.ts` para
  garantizar que el panel no ofrece lo que el motor rechaza (puestos, límites de texto y
  familias tipográficas).
- **Pendiente (con L4)**: contrato de publicación con un mock y E2E de navegador.

### 13.2 Evaluación (offline, con datos reales) · *pendiente de L3*

| Set | Tamaño | Métrica de aceptación |
| --- | --- | --- |
| Segmentación | 40 vídeos etiquetados | F1 de fronteras ±0,5 s ≥ 0,85; accuracy compilado/único ≥ 0,9 |
| Screening | 200 clips (100 malos conocidos) | precisión de rechazo ≥ 0,95; recall de malos ≥ 0,8 |
| Calibración de score | 120 clips con score humano | Spearman ≥ 0,6; acuerdo de top-3 ≥ 60 % |
| End-to-end | 10 compilados reales | short publicable en ≤ 15 min y ≤ 0,30 USD; 0 clips con watermark ajeno |

Los sets, sus etiquetas y los informes viven en `tests/eval/` y `docs/eval/`, versionados, porque
cada cambio de pesos o de prompt debe poder compararse contra la medición anterior. Junto con el
set de segmentación hay que escribir la **guía de etiquetado** («qué es un clip» para el
etiquetado humano: los tutoriales cuentan un chiste como una unidad, y si se marcan fronteras de
plano se mide contra la definición equivocada).

### 13.3 Criterios de «hecho»

1. Requisitos del milestone implementados y con criterios de aceptación **medidos**, no supuestos.
2. Tests nuevos y existentes en verde, CI verde.
3. Sin secretos ni datos de terceros en el repo, commits o logs.
4. Documentación actualizada (RPD, plan, ADR si cambió una decisión, runbook si cambió la
   operación).

---

## Estado y siguientes pasos

- **L1 y L2 están hechas** (prioridades 1 y 2) y el **panel** (RF-9) cubre el flujo de esas dos
  capas.
- El panel **no necesita el venv**: `npm run dev` desde la raíz resuelve un Python 3.11+
  cualquiera y el FFmpeg estático de npm. Si algún día sobran los procesos hijos, las
  alternativas son Docker (una imagen con motor + FFmpeg) o portar el motor a TypeScript (son
  ~3.200 líneas de Python: L1, L2, plan, specs y overlay ASS).
- Pendiente de L2, ya previsto en el RPD: **banner con la foto de referencia**
  (`assets/banners/`, §9.2) y **música/sfx** con la cama a −14 LUFS (en MVP van desactivados,
  §9.2, y requieren assets propios).
- **L3** es la extractora (segmentación, screening, scoring, selección) — el riesgo técnico
  real, con spike temprano.
- **L4** cierra la orquestación de punta a punta: cola, publicación y analítica.

No se ha copiado código del repositorio de referencia en estas capas: L1 y L2 están escritas
desde cero. Cuando se reuse código MIT (escenas, reframe, `yt_clients`), cada archivo llevará su
cabecera de origen y el NOTICE correspondiente.
