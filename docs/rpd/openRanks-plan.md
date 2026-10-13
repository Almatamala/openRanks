# openRanks — RPD, plan de ejecución y revisión previa

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — servicio de generación y publicación de shorts de ranking a partir de vídeo largo |
| **Estado** | Borrador para aprobación · revisión previa integrada (pendiente de decisión) |
| **Fecha** | 10-oct-2026 (plan) · 13-oct-2026 (revisión integrada) |
| **Alcance de este documento** | RPD (qué y por qué) + Plan de ejecución (cómo, en qué orden, con qué criterios de salida) + Revisión previa (bloqueantes, herramientas existentes, edición tipo CapCut) |
| **Decisiones ya tomadas** | (1) **servicio nuevo**, reutilizando código de OpenShorts como librería/referencia; (2) MVP con entradas **YouTube + subida local** |
| **Repo de referencia** | **OpenShorts** (repositorio vecino, no este): de él se copia/adapta código con licencia **MIT**, con cabecera de origen y NOTICE. Su directorio `cloud/` es licencia comercial y **no se copia** nunca. |
| **Archivo único** | Este documento consolida y sustituye a `rankings-mascotas.md` y `rankings-revision-previa.md`, y vive aquí, junto al código que describe (`openranks/`) |

**Nomenclatura.** El servicio se llama `openRanks` (nombre anterior del borrador: *petrank*). El nicho de
mascotas pasa a ser **el primer preset**, no el alcance del producto: el núcleo debe servir para más tipos
de vídeo (ver §18 B2 y §21).

## Orden de prioridades del producto

**Decisión del operador (13-oct-2026): se construye de atrás hacia delante, empezando por el vídeo
terminado.** Este orden es el vigente y manda sobre el de los milestones M0–M5 del borrador, que ponían la
segmentación primero (§12, ADR-7). El vocabulario `M0`–`M5` se conserva en las referencias internas del
documento; su equivalencia con las capas está en la tabla de §12.

| Prio | Capa | Qué entrega | No incluye |
| --- | --- | --- | --- |
| **1** | **L1 · Ensamblador** | **5 archivos de clip ya listos** (sin recortes pendientes: recortados, 9:16, 30 fps, audio normalizado) **y su unión en un solo vídeo vertical** | Overlays, plantilla, música, publicación |
| **2** | **L2 · Editor de plantilla** | Sobre el vídeo del punto 1, **toda la edición del estándar**: badges de posición, rótulos por clip, transiciones + swoosh, zoom inicial, música/sfx, CTA y cover. Herramienta: la que cumpla el estándar — renderer propio (Remotion) o FFmpeg/ASS (§20). **Render automático y estilo bloqueado** (regla dura) | Extracción automática de clips |
| **3** | **L3 · Extractora** | **Los 5 clips del punto 1 obtenidos solos** desde un vídeo largo: segmentación, screening, scoring y selección (§RF-2…RF-5) — *el riesgo técnico real* | Montaje y publicación |
| **4** | **L4 · Integrador** | **Una sola herramienta**: una entrada (URL o archivo) → short publicado, encadenando L1→L2→L3 con revisión humana, cola, panel, publicación y operación | — |

**Contrato entre capas (lo que hace posible el orden).** Cada capa consume la salida de la anterior como
**archivos + manifiesto**, nunca como llamadas acopladas. L1 produce `clips/*.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `spec.json`; L3 produce **los mismos `clips/*.mp4`** que el
operador cortó a mano en L1. Consecuencia: **L2 y L3 no se conocen entre sí** y L4 solo orquesta. Es también
lo que permite cambiar de herramienta de edición sin tocar nada más.

**Supuesto a confirmar (define el alcance de L1).** Se asume que en L1 los 5 clips **los aporta el
operador** (subida manual): si L1 tuviera que fabricarlos, no podría construirse antes que L3. Si lo
esperado es que L1 ya genere los clips, decirlo antes de L0: cambia el orden.

**Lo que este orden asume, y cómo se protege.** Empezar por el render y dejar la extracción en la prio 3
invierte la lógica de «el riesgo primero» (§12 del borrador). Se acepta, con tres salvaguardas:

1. **La prio 3 se alimenta de la prio 1**: cada compilado que el operador corte a mano para L1 es un
ejemplo etiquetado para el set de segmentación de RF-2 (§13.2). El trabajo manual se convierte en dataset,
no en trabajo perdido (resuelve además B7).
2. **Spike de 2–3 días de L3 en la primera semana** (sin integrarlo): medir el `reset_score` de §7.1 sobre
5 compilados reales y confirmar que las fronteras son detectables (§19.2). Se sabe antes de construir L1/L2
sobre un formato inviable.
3. **Riesgo de negocio**: el riesgo mayor no es la segmentación, es publicar contenido ajeno sin capa
propia (§11); L1/L2 son justo las capas que lo mitigan.

**Regla dura: qué es editable y qué no (13-oct-2026).** Del short terminado, el operador **solo puede editar
texto**: el **título del vídeo** y el **nombre de cada puesto del ranking**. Todo lo demás —layout, posiciones,
tipografía, colores, animaciones, transiciones, música, sfx, duración y encuadre— vive en el **preset
bloqueado** y no se toca por vídeo. Y el **render es siempre automático**: no hay edición manual del montaje
(no se abre el proyecto en un editor, no se recorta a mano, no se re-ordena). Consecuencias:

1. La **ruta B de §20** (generar un borrador de CapCut/Jianying para retocar a mano) **sale del producto**:
   si no hay nada que retocar, el borrador no aporta y añade riesgo (cifrado, Windows-only, ≤ 6.8).
2. La revisión (§RF-7) se limita a **aprobar / rechazar / sustituir un clip / editar los dos textos**; la
   foto de referencia y la variante de badge son **configuración del preset**, no algo por ranking (§16).
3. El texto es **input libre de una persona**, así que el renderer debe encajarlo solo, sin romper el
   montaje: reglas deterministas de §9.5, validadas también al entrar.
4. Cambiar un texto **no** puede obligar a recomponer el vídeo entero: se re-renderiza **solo la capa de
   overlay** sobre el `union.mp4` que ya produjo L1 (segundos, no minutos).

**Cómo está organizado este documento**

- **Parte I — RPD y plan de ejecución** (§1–§17): requisitos, diseño, modelo de datos, render, legal,
  capas L0–L4 (§12) y su equivalencia con los milestones M0–M5, verificación, riesgos, decisiones
  registradas, preguntas abiertas y anexos.
- **Parte II — Revisión previa y anexos de integración** (§18–§22): bloqueantes a cerrar antes de L0,
  panorama de herramientas existentes por etapa del proceso, edición automática tipo CapCut, checklist de
  enmiendas al RPD y fuentes.

Las referencias `§n` apuntan siempre a este documento. Las enmiendas propuestas en la Parte II están
señaladas en el texto de la Parte I con el marcador `(→ Bn, §18)`.

---

# Parte I — RPD y plan de ejecución

## 1. Resumen ejecutivo

Construimos un servicio que, a partir de un **compilado de clips de mascotas** (YouTube o archivo local),
produce un **short vertical 9:16 de tipo "TOP 5"**: cinco momentos graciosos/locos/adorables de gatos y perros,
ordenados en ranking, con el número de posición y un banner con imagen de referencia superpuestos, música,
revisión humana y publicación directa a TikTok / Instagram Reels / YouTube Shorts.

El valor no está en "cortar vídeo" — eso ya existe en el repo de referencia — sino en las cuatro capacidades
que el nicho exige y que hoy **no** existen en OpenShorts:

1. **Segmentación de compilados**: descubrir cuántos clips hay dentro de un vídeo largo y cortarlos
   individualmente (y reconocer cuándo la entrada *ya* es un clip único).
2. **Scoring de viralidad por clip, sin transcripción**. El pipeline de OpenShorts es *transcript-first*
   (`get_viral_clips`) con un fallback visual (`get_visual_clips`) que manda **el vídeo entero** a Gemini y,
   según la documentación del propio repo, *"nada guarda su longitud"*. Un compilado de mascotas no tiene
   diálogo útil: hay que puntuar por imagen, y el servicio nuevo lo hace **a base de frames muestreados**,
   lo que además elimina el techo de longitud y el coste del vídeo completo.
3. **Selección de grupo**: elegir los 5 clips que maximizan el ranking bajo restricciones de diversidad
   (no dos clips del mismo vídeo fuente, no dos del mismo tipo de chiste, mezcla gato/perro).
4. **Render con overlay de ranking** (número de posición, banner con foto de referencia, contador de
   progreso, CTA) y **puerta de revisión** antes de publicar.

Consecuencia arquitectónica importante: al no necesitar ASR, el servicio es **CPU-only en el camino crítico**
(no hay Whisper/faster-whisper, no hay `release_models()`, no hay contención de VRAM). Eso reduce coste y
complejidad de despliegue de forma sustancial frente al repo de referencia.

---

## 2. Hallazgos del repo de referencia (base del diseño)

Verificado leyendo el código, no de memoria:

| Necesidad del producto | Qué hay hoy | Decisión |
| --- | --- | --- |
| Descarga YouTube (robusta: probe, cookies, clientes, proxies) | `main.download_youtube_video`, `main.plan_download_attempts`, `main.cap_source_duration`, `yt_clients.py` | **Copiar** (MIT) y simplificar: sin ledger de proxy de pago en MVP |
| Detección de cortes | `scene_detection.py` (PySceneDetect 0.7 + TransNetV2 1.0.5, `_merge_short_scenes`) | **Copiar** y envolver con la lógica de agrupación propia |
| Detección de persona/objeto | `main.detect_person_yolo`, `yolov8n.pt`, `ultralytics==8.4.46` | **Copiar** y extender a clases `cat`/`dog` |
| Reencuadre vertical (TRACK/SPLIT/WIDE/INSCREEN) | `reframe_v2.py`, `layout_picker.py`, `split_layout.py`, `screencast_layout.py`, `camera_inset.py` | **Copiar** el modo TRACK como camino por defecto |
| Overlay de texto sobre vídeo | `hooks.py` (`create_hook_image`, `add_hook_to_video`, posiciones top/center/bottom) | **Solo como referencia**: el badge de ranking animado se hace en Remotion |
| Render declarativo con React | `remotion/src/compositions/{ShortVideo,HookOverlay,Subtitles,VideoEffects}.tsx` + `render-service/` (bundle, worker, server) | **Patrón reutilizado**: nueva composición `RankingTop5` |
| Codificación y metadatos | `ffmpeg_utils.py` (`video_encode_args`, `audio_encode_args`, `METADATA_SCRUB`, `QUALITY_FAST`) | **Copiar** |
| Cliente Gemini + validación de esquemas | `gemini_worker.py` (pydantic: `ScoredWindowModel`, `DetailClipModel`, …), `clip_selection.MODEL_PRICES` | **Copiar** el patrón: *schema-enforced JSON* + cálculo de coste |
| Umbral y agrupación | **No existe** | **Nuevo** (`core/scoring.py`, `core/selection.py`) |
| Cola de trabajos | `app.py`: `process_queue`, `asyncio.Semaphore(MAX_CONCURRENT_JOBS)`, subproceso por job, `output/<job_id>/` | **Reimplementar** sobre Postgres (`FOR UPDATE SKIP LOCKED`) |
| Publicación social | `app.py` `/api/social/post`, `TIKTOK_POST_MODE`, `/api/social/analytics*` (MIT) y `cloud/social_profiles.py` (licencia **comercial**, solo lectura de referencia) | **Adaptar** el patrón; reimplementar `social_profiles` sin copiar código de `cloud/` |
| Marca de agua | `watermarked.py`, `assets/make_watermark.py` | **Adaptar** a logo de la marca del operador |

### 2.1 Reglas duras del repo que el servicio nuevo hereda (o evita a propósito)

- **`get_visual_clips` no tiene guarda de longitud** (~300 tok/s; 1 h ≈ 1,08 M tokens > ventana de 1 M).
  En `openRanks` **no se manda vídeo a Gemini**: se mandan frames. Se acabó el problema.
- **La selección se hace donde las puntuaciones son comparables** (`clip_selection.score_batches`: el pase de
  scoring *puntúa todo* y el shortlist es el top-N global; por lotes se pierde el ranking). Nuestro scoring
  replica la regla: **el LLM puntúa, el código decide**.
- **La cuota/floor se aplica en código, no en el prompt** (`clip_count_targets`, `trim_to_best`,
  `dedupe_overlapping`). Nuestra selección de "exactamente 5" es código puro, testeable sin FFmpeg.
- **Errores de política de contenido se propagan** (`GeminiBlockedError`), no se convierten en "no hay clips".
- **Sin secretos de cupones, hosts, métricas ni datos de cliente en el repo** (regla de repo público).
  Aplica igual al repo nuevo.

---

## 3. Formato del producto

Anatomía del short objetivo, según lo que **dicen** los dos vídeos de referencia
["How To Make VIRAL Ranking Videos"](https://www.youtube.com/watch?v=kOBED9yKees) y
["How to Make Monetizable Ranking Videos"](https://www.youtube.com/watch?v=hhTjwKwq8xs)
(sus transcripciones se obtuvieron y se leyeron: ver §17.4):

```
┌──────────────────────────────┐  1080 x 1920, 30 fps, 32-56 s
│ ╔══ TÍTULO (2 capas) ════════╗│  y = 96..240 — "TOP 5 GATOS": dos capas para
│ ║ TOP 5 GATOS 😹              ║│  dar color propio al número ("5") más grande
│ ╚═════════════════════════════╝│
│ [5] ─────────────────────────│  ESCALERA DE RANGOS: x=48..280,
│ [4]   [ RÓTULO DEL CLIP ]    │  #5 abajo … #1 arriba (no un solo badge),
│ [3]                          │  cada rótulo entra con SU clip
│ [2]        [ CLIP ]          │  clip 9:16 encuadrado (TRACK)
│ [1]                          │
│                      ⓘ  CTA  │  y = 1560..1760, dentro de la safe area
└──────────────────────────────┘
```

Reglas de composición (cada regla, respaldada por lo que indican los tutoriales):

- **Orden**: cuenta atrás `#5 → #1`; el clip **más fuerte va primero** (el "hook" de los primeros
  3 segundos) y el `#1` cierra como payoff. *(→ B1, §18: con un solo eje temporal no puede ser las dos cosas:
  hace falta un `cold_open`.)* Los tutoriales insisten en las dos cosas a la vez:
  arranque fuerte y mejor clip al final.
- **Duración**: 5 clips de **5–10 s** + rótulos + cierre ⇒ **32–56 s**. Se recortan los tramos aburridos
  para que "cada segundo sea entretenido".
- **Números de rango**: cinco capas de texto, una por posición, repartidas en vertical
  (**#5 abajo, #1 arriba**) y cada uno visible durante su clip. Colores por posición:
  **#3 bronce, #2 plata, #1 oro**; para los puestos bajos, rojo/verde/azul de acento.
- **Rótulo por clip**: un título corto por clip, diseñado para **provocar comentarios** (los tutoriales
  lo dicen explícitamente, incluso admitiendo títulos ragebait). Entra exactamente cuando empieza su clip.
- **Título global**: arriba, con el número destacado (dos capas: texto + número de otro color).
- **Legibilidad**: texto blanco con **stroke negro** (o colores vivos), fuente condensada y gruesa.
- **Transiciones**: una transición animada entre **todos** los clips ("pull in" en CapCut), con un
  **swoosh** debajo de cada una, y **zoom-in en el primer clip** también con swoosh.
- **Audio**: música **opcional** en este nicho (los tutoriales la omiten o la dejan al final).
  Si se usa la cama del compilado y no es propia, se sustituye por una pista con licencia (ver §11).
  Normalización a **−14 LUFS**, pico −1 dBTP.
- **Voz en off**: una línea corta por clip (la primera puede omitirse si es demasiado corta).
  En los tutoriales no es decorativa: es parte de cómo el vídeo "se transforma" para no caer en
  contenido reutilizado. Ver §11 y la decisión pendiente en §16.
- **Eliminación de rótulos ajenos**: el tutorial los **tapa** (duplicar el clip + desenfoque + máscara
  sobre la zona de texto), no descarta el clip. Cambia el comportamiento de la puerta de texto en RF-3.

---

## 4. Alcance

### 4.1 Dentro del MVP

| # | Capacidad |
| --- | --- |
| 1 | Ingesta: URL de YouTube (un vídeo o los **N últimos de un canal**), archivo subido (mp4/mov/mkv/webm ≤ 2 GB) |
| 2 | Normalización: ffprobe (fps, resolución, duración, canales de audio), extracción de proxy 240p para análisis |
| 3 | **Detección de compilado vs. clip único** con confianza, y **segmentación** en clips individuales |
| 4 | Screening determinista: mascota presente, sin watermark ajeno, sin rótulos ajenos, sin split-screen, nitidez y duración válidas → **rechazo con motivo** |
| 5 | Scoring de viralidad 0–100 por clip (Gemini sobre frames + señales) con **umbral configurable**; los que no pasan se archivan, no se borran |
| 6 | Agrupación en TOP 5 con restricciones de diversidad y orden de cuenta atrás |
| 7 | Render 9:16 con badge de posición, banner con foto de referencia, contador y CTA, vía Remotion |
| 8 | Revisión humana: aprobar / rechazar / sustituir un clip y editar **solo los textos del vídeo** (título y nombres de los puestos; el copy de publicación es un campo aparte) |
| 9 | Publicación vía Upload-Post a TikTok, IG Reels, YouTube Shorts (inmediata o programada) |
| 10 | Metro de coste por fuente, por clip y por render; trazabilidad completa de prompts y versiones de modelo |

### 4.2 Fuera del MVP (v2+)

- Descarga de TikTok (la allowlist de URLs del repo rechaza todo lo que no sea YouTube; extenderla es trabajo propio).
- Voz en off / TTS, dubbing, traducción.
- Autopilot por canal con calendario y analítica cerrada (existe en `cloud/autopilot.py`, se portará después).
- Detección automática de "momento exacto" dentro de un clip ya cortado (reescritura de bordes).
- Generación de las fotos de referencia por IA (en MVP son assets subidos por el operador).
- Multi-idioma de textos de overlay (MVP: un idioma configurable por proyecto).

### 4.3 No objetivos

- Ser un editor manual de vídeo. La revisión existe para aprobar, no para editar segundo a segundo.
- Garantizar monetización: es una decisión de la plataforma (ver §11).

---

## 5. Usuarios y flujos

**Usuario único del MVP: el operador de la cuenta de rankings** (una persona o un equipo pequeño que
trabaja varios compilados por día). No hay multiusuario ni facturación en el MVP.

Flujo principal:

1. Pega una URL de YouTube (o sube un compilado) → el sistema ingesta y detecta si es compilado o clip único.
2. El sistema segmenta, filtra y puntúa; el operador ve una tabla de clips con score, motivo y miniaturas.
3. El operador crea el ranking (`auto top-5` o eligiendo clips a mano) y lanza el render.
4. Revisa el render en el navegador; aprueba o sustituye un clip.
5. Publica (ahora o programado) y consulta el resultado en la lista de publicaciones.

Historias de usuario (con criterio de aceptación resumido):

- **US-1** *Como operador quiero pegar una URL y recibir clips separados* → dado un compilado de 12 min con 24
  clips, el sistema produce 20–28 segmentos, con fronteras a ±0,5 s de las reales, en ≤ 4 min.
- **US-2** *Como operador quiero que un clip ya cortado no se trocee* → dado un mp4 de 9 s de un solo gato,
  el sistema devuelve `kind=single_clip` con confianza ≥ 0,8 y **un** segmento que cubre el 100 % de la duración.
- **US-3** *Como operador quiero descartar automáticamente lo que no vale* → un clip con marca de agua de otro
  canal, o sin ninguna mascota, se marca `rejected` con motivo y no entra en ningún ranking.
- **US-4** *Como operador quiero un TOP 5 coherente* → los 5 clips vienen de 5 fuentes distintas (o de 5
  segmentos distintos del mismo compilado solo si el operador lo permite), sin repetir el mismo tipo de chiste.
- **US-5** *Como operador quiero publicar sin salir del panel* → el render aprobado se publica en las 3 redes
  con título y descripción, y queda registrado con su id remoto.

---

## 6. Requisitos funcionales

### RF-1 — Ingesta y detección de "ya está cortado"

1. `POST /sources` acepta `{kind: youtube_url | upload, url?, file?}`. Para `youtube_url` se admite
   `?list=` de canal → se ingesta el vídeo pedido; `channel` → se listan los últimos `N` (por defecto 5).
2. Descarga con `yt-dlp` con el plan de intentos del repo (directo → estáticos si están configurados),
   `noplaylist` siempre, allowlist de URL, techo de duración `MAX_SOURCE_MINUTES` (defecto 45).
3. Se genera un **proxy de análisis**: 240p, 8 fps, audio 16 kHz mono (`analysis.mp4` + `analysis.wav`).
   Todo el análisis (escenas, señales, frames) trabaja sobre el proxy; el corte final siempre sobre el original.
4. Clasificación `compilation | single_clip` según §7.2, con `confidence` y `reasons[]` persistidos.
5. Se guarda la **metadata de engagement de la fuente** que yt-dlp ya devuelve (`view_count`, `like_count`,
   `comment_count`, `upload_date`, `channel`) y, por segmento, la del vídeo del que sale. Los dos tutoriales
   eligen los clips por sus **views y comentarios** ("clips con muchas views", "que tengan muchos comentarios,
   eso muestra que la gente interactúa"): es un prior barato que no requiere analizar un solo frame y sirve de
   desempate entre candidatos de score parecido. No sustituye al scoring visual: un vídeo viral de 2 h de
   compilado no dice qué clip de dentro es bueno.

**Criterio de aceptación**: sobre el set de evaluación (§13.2) de 40 vídeos etiquetados, precisión ≥ 0,9 y
recall ≥ 0,9 en la clase `compilation`; ninguna entrada de ≤ 15 s se clasifica como compilado.

### RF-2 — Segmentación en clips individuales

1. Cortes de plano con `scene_detection.detect_scenes` (motor seleccionable con `SCENE_ENGINE`: TransNetV2
   por defecto en el repo original — más preciso pero necesita `torch` y es mucho más lento en CPU — o
   PySceneDetect). El servicio nuevo **arranca con `SCENE_ENGINE=pyscenedetect`** por ser CPU-only y deja
   TransNetV2 como opt-in; M1 mide ambos sobre el set etiquetado (F1 de fronteras vs. tiempo) y fija el defecto
   con datos, no por corazonada.
2. Agrupación de planos en **clips candidatos** con las señales de §7.1 (`core/segmentation.py`, stdlib-only).
3. Fronteras ajustadas al **primer frame válido** con margen de 120 ms antes / 200 ms después; nunca en negro.
4. Banda de duración: `MIN_SEGMENT_SECONDS=1.5` (por debajo se absorbe en el vecino),
   `MAX_SEGMENT_SECONDS=45` (por encima se parte en la frontera de menor cohesión).
5. Cada segmento guarda `separator` (`hard_cut | audio_reset | frame_change | watermark_change | duration_split`),
   `cohesion` 0–1 y `segmentation_confidence`.
6. Deduplicación interna: dos segmentos que solapan > 60 % del más corto se fusionan.

**Criterio de aceptación**: en el set etiquetado, **F1 de fronteras a ±0,5 s ≥ 0,85**, y el recuento de
segmentos dentro de ±20 % del recuento humano en ≥ 80 % de los vídeos.

### RF-3 — Screening determinista (puertas de calidad/derechos)

Antes de gastar una llamada a Gemini, cada segmento pasa por puertas baratas y **binarias**:

| Puerta | Cómo | Resultado |
| --- | --- | --- |
| Mascota presente | YOLO (`cat`/`dog`/`bird`/`small animals`) en ≥ 3 frames clave | sin mascota → `rejected:no_pet` |
| Marca de agua ajena | plantilla de logo cuasi-estática en esquina/centro detectada en ≥ 70 % de los frames | `rejected:foreign_watermark` |
| Rótulo ajeno quemado | densidad de bordes/texto en banda superior/inferior en ≥ 60 % de frames | **reparar** si la banda ocupa ≤ 18 % del alto: `repair:mask_text` (duplicar + desenfoque + máscara sobre la zona, el método de los tutoriales); rechazar si es mayor o si tapa la acción. *(→ B5, §18: leer el texto con OCR antes de decidir: un `@handle` es autoría ajena → rechazo)* |
| Split-screen | detección de línea negra vertical central persistente | `rejected:split_screen` |
| Barras negras / pillarbox | borde negro persistente > 8 % del frame | `reframed` (recorte) o rechazo si supera 25 % |
| Nitidez y luz | varianza del Laplaciano y media de luma | `rejected:blurry` / `rejected:too_dark` |
| Estático | ≥ 80 % de los frames casi idénticos | `rejected:static` |
| Duración | fuera de banda | `rejected:duration` |
| Duplicado global | pHash de 3 keyframes contra la librería | `rejected:duplicate` |

**Criterio de aceptación**: precisión ≥ 0,95 en los rechazos por `foreign_watermark`, `burned_text`, `no_pet`
(no se puede tumbar un clip bueno por una puerta agresiva); coste de la fase < 8 s por minuto de fuente en CPU.

### RF-4 — Scoring de viralidad por clip (paso 2 del brief)

1. Por cada candidato que pasó el screening, se extraen **8–12 frames** repartidos por el clip
   (120–1024 px, con el primero como frame de portada) + un resumen numérico de señales (§7.3).
2. **Una llamada a Gemini por lote de 6 clips** (patrón `_run_stage_split` del repo: la puntuación por lotes
   es comparable porque el prompt puntúa *todos* los elementos del lote contra la misma rúbrica).
3. Salida validada con pydantic: `score` (0–10), `verdict` (`keep|reject`), `humor_type` (lista cerrada),
   `species` (`cat|dog|other`), `payoff_second` (segundo del remate), `why` (una frase), `hook` (≤ 10 palabras)
   y **`clip_label`** (≤ 4 palabras en pantalla, pensado para provocar comentarios, no para describir) y
   **`vo_line`** (una frase corta de voz en off, tono humorístico) — ambos existen en el formato de referencia.
   El rótulo y la línea de VO son *copy*, no hechos: el prompt no puede inventar sucesos que no estén en los frames.
4. Score final = `0.7 * llm + 0.3 * señales`, redondeado a 0–100. Umbral por defecto **70**, configurable
   por proyecto (`RANKING_SCORE_CUTOFF`) y almacenado por score.
5. Los clips por debajo del umbral pasan a `verdict=below_threshold` (recuperables, **no borrados**).
6. Se guarda `model`, `prompt_version`, `frames_sampled`, `tokens_in/out` y `cost_usd` por llamada.

**Criterio de aceptación**: correlación (Spearman) ≥ 0,6 entre score y el ranking humano en el set de
calibración de 120 clips; **coste medio ≤ 0,003 USD por clip puntuado** (ver §10.1, medir en M2, no asumir).

### RF-5 — Agrupación en TOP 5 (paso 3 del brief)

1. Entradas: clips `keep` con score ≥ umbral, más, si faltan, los `below_threshold` **en orden descendente**
   hasta completar 5 (nunca se rellena con clips rechazados por las puertas de §RF-3).
2. Restricciones duras:
   - como máximo 1 clip por vídeo fuente (`RANKING_MAX_PER_SOURCE=1`; configurable a 2 solo si el
     compilado es la única fuente);
   - como máximo 1 clip por `humor_type`;
   - si el tema declara mezcla (`gatos y perros`), al menos 1 de cada especie cuando existan candidatos.
3. Objetivo: maximizar `Σ score` con penalización de duplicidad visual (`− 0.5 * similitud_pHash` máxima del grupo).
   Búsqueda voraz + mejora por intercambio; determinista con semilla; se persiste el objetivo alcanzado.
4. Orden `#5 → #1` por score ascendente, con el mejor en `#1`.
5. Salida: `ranking_items` (posición, clip, score, `why`) + `total_duration`.

**Criterio de aceptación**: nunca se generan dos items con el mismo `source_clip_id` o la misma fuente
(test unitario obligatorio); duración total dentro de 30–58 s en el 95 % de los rankings.

### RF-6 — Render del short

1. `POST /rankings/{id}/render` genera el spec JSON de la composición y llama al renderer (Remotion, §9).
2. Composición `RankingTop5` con props: `segments[]`, `badges[]`, `banner`, `progressBar`, `cta`, `music`, `style`.
3. Cada clip se normaliza antes a 1080x1920 (TRACK) y se recodifica con `ffmpeg_utils` (CRF, `yuv420p`,
   `+faststart`, metadatos limpiados con `METADATA_SCRUB`).
4. Audio: mezcla −14 LUFS, música con `loop` si es más corta, fade in/out de 300 ms.
5. Artefactos: `ranking.mp4` (final), `cover.jpg` (frame con banner + badge de los 5 y miniatura del `#1`),
   `spec.json`, `manifest.json` (trazabilidad: ids de segmentos, prompts, modelo, coste).
6. **Watermark de marca** del operador (patrón `watermarked.py`) aplicado como último paso, para que el
   archivo canónico quede limpio y solo la copia servida lo lleve.

**Criterio de aceptación**: render < 6 min para un short de 45 s en 4 vCPU; el MP4 valida con ffprobe
(1080x1920, 30 fps, yuv420p, ≤ 60 s, audio presente) y **no** contiene ninguna ruta ni metadato interno.

### RF-7 — Revisión

1. `GET /renders/{id}` devuelve el vídeo, los 5 clips con su score y el manifest.
2. `POST /renders/{id}/review` con `{decision: approve|reject, notes?}`.
3. `POST /renders/{id}/items/{position}/replace` elige un clip sustituto y relanza el render, **conservando
   los otros 4** (reutiliza los segmentos ya normalizados para no recodificar todo).
4. Un render no aprobado **no puede** publicarse (validación en servidor, no solo en la UI).
5. Los rechazos con motivo alimentan el set de calibración.
6. **Superficie editable = solo texto (ADR-8)**: `PATCH /renders/{id}/texts` con `{title, labels[5]}`. **No**
   existe endpoint para recortar, reordenar, cambiar la plantilla ni tocar el estilo, y el render **nunca
   espera** una intervención manual. Un cambio de texto re-renderiza **solo la capa de overlay** sobre el
   `union.mp4` ya compuesto — segundos, no minutos, porque los segmentos normalizados vienen en caché de L1.
7. La aprobación sigue siendo puerta de publicación (RF-8.2), pero lo revisable se limita a: aprobar,
   rechazar, sustituir un clip y editar los dos textos.

### RF-8 — Publicación y resultado

1. `POST /renders/{id}/publish` con `{platforms: [tiktok, instagram, youtube], title, description,
   schedule_at?, timezone?}` — modelo y flujo calcados de `/api/social/post` (multipart, `TIKTOK_POST_MODE`,
   descripción por plataforma).
2. Tick de confirmación explícito con las plataformas conectadas; nunca publicar por defecto.
3. Se guarda `publications` (id remoto, estado, payload, error) y `GET /publications` lista con estado.
4. `GET /analytics?render_id=` devuelve las métricas disponibles por Upload-Post (lectura, sin promesas de
   retención que la API no dé).

---

## 7. Diseño técnico

### 7.1 Señales de segmentación (`core/segmentation.py`, stdlib + numpy)

Fronteras candidatas = cortes de plano de `scene_detection.py`. Entre dos planos consecutivos se calculan
continuidades y **solo se abre un clip nuevo cuando hay un "reset"**, porque un compilado de mascotas suele
tener varios planos por clip (plano del perro + reacción del dueño = *un* clip):

```
reset_score =
    0.35 * cambio_de_aspecto_o_barras      (letterbox/pillarbox distinto)
  + 0.25 * cambio_de_marca_agua            (aparece/desaparece logo)
  + 0.20 * discontinuidad_audio            (salto de loudness/spectral flux > k·σ sobre el fondo musical)
  + 0.15 * distancia_de_paleta             (histograma HSV, distancia χ²)
  + 0.05 * salto_de_resolución_o_ruido     (cambio de calidad/compresión)
  + 0.10 * silencio_o_negro_entre_planos   (≥ 250 ms de negro/silencio)
reset_score >= 0.45  → frontera de clip
```

Cohesión interna del candidato = media de `1 - reset_score` en sus fronteras interiores; se usa para partir
los candidatos demasiado largos por su frontera **más débil** (no por el medio). Todos los pesos son
constantes con nombre, configurables por entorno, y se ajustan con el set etiquetado en M1.
*(→ §19.2: son una hipótesis sin medir; el ablation por señal es obligatorio antes de tocarlos, y falta una
señal que sobreviva a un compilado re-codificado homogéneo.)*

### 7.2 Clasificador compilado vs. clip único

```
score_compilado =
    0.30 * min(1, planos_distintos / 6)
  + 0.25 * min(1, duración / 240 s)
  + 0.20 * nº_de_resets_detectados_normalizado
  + 0.15 * diversidad_visual_global   (pHash de keyframes: 1 - similitud media)
  + 0.10 * heterogeneidad_de_formato  (¿hay más de un aspecto/bitrate/letterbox?)
```

`compilation` si `score ≥ 0.55`, `single_clip` si `≤ 0.35`, y entre ambos `ambiguous` → se trata como
compilado **pero** con `confidence` baja registrada (y el operador puede forzar el modo con
`force_mode=single|compilation`). Un clip de ≤ 15 s con un solo plano nunca es compilado.

### 7.3 Señales de viralidad deterministas (`core/signals.py`)

- `motion_energy`: media y varianza del diff entre frames consecutivos del proxy (0–1).
- `payoff`: pico de `motion_energy` seguido de ≥ 0,5 s de cámara estable (proxies de "acción → reacción").
- `animal_ratio`: fracción de frames clave con detección `cat`/`dog` y área media de la caja.
- `face_ratio`: fracción con cara humana dominante (señal **negativa** cuando > 0,7 y no hay mascota grande).
- `audio_peak`: nº de picos de loudness > 2σ sobre el fondo (ladrido, golpe, carcajada).
- `music_bed`: probabilidad de que el audio sea una cama musical continua (espectral, banda 60–250 Hz estable).
- `text_bands`: densidad de bordes en las bandas de rótulos (alimenta también el screening).
- `static_ratio`, `sharpness`, `luma_mean`, `pHash[]`.

`llm_score` y estas señales se combinan en `core/scoring.py` (función pura, testeable, con los pesos y el
umbral como parámetros). El desglose se guarda para poder recalibrar sin volver a llamar a Gemini.

### 7.4 Rubrica del prompt visual (una sola rúbrica, cerrada)

El prompt pide, por clip: `score` entero 0–10, `verdict`, `humor_type` de lista cerrada
(`caida | susto | robo_de_comida | travesura | reaccion | baile | rescate | ternura | caos_multiple | otro`),
`species`, `payoff_second`, `why` (una frase) y `hook` (≤ 10 palabras, en el idioma del proyecto).
La rúbrica se pondera en el prompt (remate cómico 40 %, sorpresa 20 %, ternura 20 %, energía 10 %,
legibilidad en el primer segundo 10 %) y **no** se pide ninguna medida ("¿cuánto mide el clip?") ni una
decisión abierta: el modelo puntúa, el código decide (regla heredada del repo).

### 7.5 Arquitectura de componentes

```
                 ┌─────────────┐
   operador ────►│  web (UI)   │  React + Vite (patrón dashboard/)
                 └──────┬──────┘
                        │ REST
                 ┌──────▼───────────────┐        ┌──────────────┐
                 │  api (FastAPI)       │◄──────►│  postgres    │
                 │  /sources /clips     │        │  cola + datos│
                 │  /rankings /renders  │        └──────▲───────┘
                 │  /publish            │               │ SKIP LOCKED
                 └──────┬───────────────┘        ┌──────┴───────┐
                        │ encola jobs            │  worker      │  (Python, CPU)
                        └───────────────────────►│  ingest→seg  │
                                                 │  →screen     │
                                                 │  →score      │──► Gemini (frames)
                                                 │  →rank       │──► MinIO (fuentes/renders)
                                                 └──────┬───────┘
                                                        │ render spec
                                                 ┌──────▼───────┐
                                                 │ renderer     │  Node + Remotion
                                                 │ RankingTop5  │
                                                 └──────┬───────┘
                                                        │ mp4
                                                 ┌──────▼───────┐
                                                 │ publish      │──► Upload-Post
                                                 └──────────────┘
```

- **Cola en Postgres** (`jobs` con `SELECT … FOR UPDATE SKIP LOCKED`), no Redis: menos piezas, transaccional
  con los datos, suficiente para ~50 fuentes/día. Si el volumen sube, se cambia el adaptador sin tocar las fases.
- **Sin GPU en el camino crítico**: YOLOv8n en CPU (~40–80 ms/frame), PySceneDetect en CPU, Gemini remoto.
- **Almacenamiento**: MinIO (S3-compatible) en compose para fuente original, proxy, segmentos y renders;
  retención configurable (por defecto: fuentes 30 días, renders y manifest indefinido, proxies 7 días).

### 7.6 Esqueleto del repositorio

```
openRanks/
  api/            app.py, routes/, schemas.py, deps.py
  worker/         runner.py, stages/{ingest,segment,screen,score,rank,render,publish}.py
  core/           segmentation.py, signals.py, scoring.py, selection.py, specs.py, config.py
  reused/         (copias MIT de OpenShorts con cabecera de origen: scene_detection,
                   reframe_v2, layout_picker, ffmpeg_utils, watermark, yt_clients, gemini_worker)
  renderer/       src/RankingTop5.tsx, src/lib/{types,badge,banner}.ts, server.ts, worker.ts
  web/            React + Vite (panel de revisión)
  db/             models.py, alembic/versions/
  assets/         fonts/, music/, banners/ (fotos de referencia), logos/
  tests/          unit/, integration/, eval/, fixtures/
  docker-compose.yml
  docs/           este RPD, ADRs, runbook
```

`core/` es **stdlib + numpy**: toda la lógica de decisión (segmentación, señales, scoring, selección,
generación de especificaciones) se testea en CI sin FFmpeg, sin torch y sin red — igual que hace
`clip_selection.py` en el repo de referencia.

### 7.7 `docker-compose.yml` (MVP)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment: [POSTGRES_PASSWORD=${POSTGRES_PASSWORD}, POSTGRES_DB=openRanks]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck: {test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 10}

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: [MINIO_ROOT_USER, MINIO_ROOT_PASSWORD]
    volumes: ["miniodata:/data"]

  api:
    build: .
    command: uvicorn api.app:app --host 0.0.0.0 --port 8000
    ports: ["8000:8000"]
    depends_on: {postgres: {condition: service_healthy}}
    healthcheck: {test: ["CMD", "curl", "-fsS", "http://localhost:8000/health"], interval: 10s}
    environment: [DATABASE_URL, S3_ENDPOINT, GEMINI_API_KEY, UPLOAD_POST_API_KEY]

  worker:
    build: .
    command: python -m worker.runner
    depends_on: {postgres: {condition: service_healthy}}
    environment: [DATABASE_URL, S3_ENDPOINT, GEMINI_API_KEY, WORKER_CONCURRENCY=2]
    volumes: ["./cache:/app/cache"]

  renderer:
    build: ./renderer
    ports: ["3100:3100"]
    environment: [REMOTION_BUNDLE_PATH=/app/bundle, OUTPUT_DIR=/tmp/out]

volumes: {pgdata: {}, miniodata: {}}
```

Notas de operación: la imagen debe incluir `curl` (healthcheck) y `ffmpeg`/`ffprobe`; el renderer se
construye con `npm ci` y bundle previo; `WORKER_CONCURRENCY` se dimensiona por CPU y por rate limit de Gemini,
no por VRAM.

---

## 8. Modelo de datos (Postgres, esquema mínimo)

```sql
sources(id, kind, url, file_key, duration_s, fps, width, height,
        status, fail_reason, content_hash, created_at, completed_at)

source_clips(id, source_id, idx, start_s, end_s, duration_s,
             kind, segmentation_confidence, separator, cohesion, signals jsonb, created_at)

clip_screens(id, source_clip_id, verdict, reasons text[], metrics jsonb, created_at)

clip_scores(id, source_clip_id, model, prompt_version, llm_score, signal_score, virality,
            verdict, humor_type, species, payoff_second, why, hook, tokens_in, tokens_out,
            cost_usd, created_at, is_current bool)

rankings(id, theme, species_mix, title, subtitle, style jsonb, cutoff,
         target_duration_s, status, objective, created_at)

ranking_items(id, ranking_id, position, source_clip_id, score, why, unique(ranking_id, position))

renders(id, ranking_id, status, spec jsonb, video_key, cover_key, duration_s,
        render_ms, manifest jsonb, created_at)

review_decisions(id, render_id, decision, notes, actor, created_at)

publications(id, render_id, platform, remote_id, status, title, description,
             scheduled_at, payload jsonb, error, created_at)

jobs(id, type, payload jsonb, state, attempts, max_attempts, lease_until,
     last_error, created_at, started_at, finished_at)
  -- índice: (state, created_at) WHERE state IN ('queued','retry')

assets(id, kind, name, key, tags text[], spec jsonb, created_at)  -- banners/fotos de referencia, música, fuentes

score_ledger(id, source_clip_id, kind, prompt_version, model, cost_usd, created_at)  -- metro de coste
```

Índices obligatorios: `source_clips(source_id, idx)`, `clip_scores(source_clip_id) WHERE is_current`,
`ranking_items(ranking_id, position)`, `jobs(state, created_at)`, `publications(render_id)`.

---

## 9. Especificación del overlay y del render

### 9.1 Safe areas (1080x1920)

| Zona | Reservado | Uso |
| --- | --- | --- |
| Inferior | y > 1560 | UI de la plataforma (caption/usuario) → solo CTA discreto y texto corto |
| Derecha | x > 960 | botonera de TikTok → nada crítico |
| Superior | y < 96 | UI de cámara/estado → el banner empieza en y=112 |
| Centro | 340 < y < 1500 | contenido del clip sin overlays permanentes |

### 9.2 Estilos (preset bloqueado, almacenado en `rankings.style`)

**El estilo no es editable por vídeo (ADR-8).** Se elige una vez por preset y el render lo aplica tal cual.
Lo único que varía entre rankings es el **texto**: el título del vídeo (`title.layers[].text`) y el nombre de
cada puesto (`clip_label`). Dicho en los términos de §20.0: `Template` (layout, posiciones, colores,
animaciones, sfx, duración) es **constante**; `Binding` lleva **solo texto**.

```json
{
  "theme": "top5-gatos",
  "font": "assets/fonts/Anton-Regular.ttf",
  "palette": {"badge_bg": "#FF3B30", "badge_text": "#FFFFFF", "banner_bg": "#111111",
              "accent": "#FFD60A", "stroke": "#000000"},
  "title": {"y": 96, "layers": [{"text": "TOP", "color": "#E63946"},
                            {"text": "5", "color": "#FFD60A", "scale": 1.35},
                            {"text": "GATOS 😹", "color": "#E63946"}],
            "font": "Anton-Regular.ttf", "stroke_px": 10},
  "banner": {"y": 260, "height": 208, "photo": "assets/banners/gatos_ref_01.png", "radius": 36},
  "rank_ladder": {"x": 48, "x_w": 232, "y_top": 300, "y_bottom": 1500, "orientation": "5_bottom",
                 "slot_h": 240, "entrance": "spring", "hold_s": 0.8, "show_progress": true,
                 "colors_by_rank": {"1": "#D4AF37", "2": "#C0C0C0", "3": "#CD7F32",
                                    "4": "#3B82F6", "5": "#3B82F6"},
                 "variant": "ladder"},
  "clip_label": {"y": 1180, "max_words": 4, "stroke_px": 8, "hold_s": 0.9,
                 "purpose": "engagement_bait", "font_size_px": 76},
  "cta": {"text": "sígueme para el TOP 4", "y": 1610, "hold_s": 1.5},
  "music": {"enabled": false, "asset": "assets/music/funny_bed_01.mp3", "gain_db": -18, "fade_ms": 300},
  "voiceover": {"enabled": true, "one_line_per_clip": true, "skip_first": "auto", "gain_db": -3},
  "transition": {"type": "pull_in", "duration_s": 0.35, "sfx": "assets/sfx/whoosh_01.wav",
                 "sfx_gain_db": -14, "first_clip_zoom": 1.08},
  "sfx": [{"trigger": "action_peak", "asset": "assets/sfx/slip_01.wav", "gain_db": -12}]
}
```

`rank_ladder.variant` admite `ladder` (el estilo de los tutoriales: cinco números fijos en vertical) y
`single_badge` (un solo badge que cambia de número). Cuál se usa lo decide la **foto de referencia** del
operador; la implementación soporta los dos y el spec queda registrado por render (§16, preguntas 8 y 9).
*(→ B4, §18: `hold_s` necesita semántica explícita y la duración total debe descontar el solape de las
transiciones.)*

### 9.3 Composición Remotion `RankingTop5`

- Props tipadas (`src/lib/types.ts`) y validadas; el renderer rechaza props que no cumplen el esquema
  (mismo principio que los esquemas pydantic del repo).
- `OffthreadVideo` por segmento, `Sequence` por posición, `<Banner>`, `<RankBadge>`, `<ProgressBar>`, `<Cta>`.
- Animaciones deterministas (spring/frames) para que el mismo spec produzca **el mismo MP4** en cada corrida.
- Generación del spec en `core/specs.py` (puro, testeable): ensamblado de pistas, cálculo de `from/to`,
  overlaps, duración total y `durationInFrames`.
- Fallback FFmpeg (sin animación): si el renderer no está disponible, se compone con `overlay` + `drawtext`
  como en `hooks.py`. Es un **modo degradado** documentado, no el camino principal.

### 9.4 Salidas por render

| Artefacto | Especificación |
| --- | --- |
| `ranking.mp4` | 1080x1920, 30 fps, H.264 High, CRF 19, yuv420p, AAC 192 kbps 48 kHz, `+faststart`, ≤ 60 s |
| `cover.jpg` | frame con banner + los 5 badges y miniatura del `#1`, 1080x1920 |
| `spec.json` | props exactas del render (reproducible) |
| `manifest.json` | ids de segmentos y fuentes, scores, `prompt_version`, modelo, tokens, coste, duración, versión del renderer |

### 9.5 Encaje del texto editable (obligatorio)

Con el estilo bloqueado y el render automático, el texto es el **único** punto por donde entra input humano:
el renderer no puede depender de que el operador escriba corto. Reglas deterministas, aplicadas también en la
validación de entrada:

| Regla | Valor por defecto |
| --- | --- |
| Título del vídeo | ≤ 28 caracteres por capa, 3 capas; envoltura a 2 líneas como máximo |
| Nombre de cada puesto | ≤ 4 palabras / 24 caracteres; 2 líneas como máximo |
| Reducción por encaje | *shrink-to-fit* acotado (hasta 0,8× del tamaño nominal); después, envoltura; después, truncado con elipsis |
| Zona segura | el texto nunca invade las safe areas de §9.1 ni la banda del banner |
| Prohibido | que un texto largo mueva posiciones, cambie la duración de un clip o altere el timing de los badges |

El spec guarda el texto **de entrada** y el renderer calcula el encaje en cada corrida (determinista), de modo
que un mismo par texto + preset produce siempre el mismo MP4.

---

## 10. Requisitos no funcionales

### 10.1 Coste (estimación a medir en M2)

Referencia de precios del repo (`clip_selection.MODEL_PRICES`), `gemini-3.1-flash-lite`:
**0,25 USD / 1M input**, **1,50 USD / 1M output**.

Supuestos por clip puntuado: 8 frames a ~600 tok + ~600 tok de prompt ≈ 5.400 tok input; ~250 tok output.

```
coste/clip ≈ 5.400 × 0,25/1e6 + 250 × 1,50/1e6 ≈ 0,0017 USD
```

Compilado de 20 min → ~40 candidatos → **≈ 0,07 USD por fuente**, más ~0,02 USD de generación de títulos y
razonamientos ⇒ **≤ 0,10 USD por short**. Presupuesto de aceptación: **≤ 0,30 USD por short publicado**, medido
con los contadores reales del SDK (tarea obligatoria en M2: la cifra de arriba es estimación, no medición).
*(→ B6, §18: medir tokens por frame en M0; 600 tok/frame puede quedarse corto.)*

### 10.2 Latencia y throughput

| Fase | Objetivo (compilado de 20 min, 4 vCPU) |
| --- | --- |
| Descarga + proxy | ≤ 3 min |
| Segmentación + señales | ≤ 3 min |
| Screening | ≤ 1 min |
| Scoring (6 clips/llamada) | ≤ 1 min |
| Render 45 s | ≤ 6 min |
| **Total** | **≤ 15 min por short, en cola de 2 workers** |

Objetivo de capacidad: **50 fuentes/día** con un worker de 4 vCPU; el límite real será el rate limit de Gemini,
no la CPU (ver §10.5 para la parte de GPU y convivencia con OpenShorts).

### 10.3 Fiabilidad

- Jobs reintentables con backoff exponencial y techo de intentos (`jobs.max_attempts = 3`); el estado de cada
  fase es idempotente (reanudar no re-descarga ni re-puntúa lo ya hecho: `content_hash` + `is_current`).
- Errores de política de contenido de Gemini se propagan con su motivo (heredado del repo), no se silencian.
- Rate limit de Gemini: cola con backoff y degradación a "menos candidatos por corrida" documentada.
- Backups: `pg_dump` diario; MinIO con versión de objeto si el despliegue lo permite.

### 10.4 Seguridad y privacidad

- API key propia (header `X-API-Key`) para el panel; sin multiusuario en MVP.
- Claves de Gemini/Upload-Post solo por entorno, nunca en BD ni en logs; `.env` fuera del repo.
- Los secretos no aparecen en `spec.json` ni en `manifest.json`.
- Logs con ids, nunca con URLs completas de contenido privado ni rutas del host.

### 10.5 Huella de cómputo y convivencia con OpenShorts

Hechos comprobados leyendo el repo de referencia — `docker-compose.yml`, `docker-compose.cloud.yml`,
`Dockerfile`, `dashboard/Dockerfile`, `render-service/Dockerfile`, los imports de `app.py` y el uso de
`torch` en `main.py` — no supuestos:

- En OpenShorts **no hay un servicio "api" y otro "back"**: `docker-compose.yml` levanta `backend`
  (FastAPI + cola de jobs, es api y back a la vez), `frontend` y `renderer`. "Correr solo api y back"
  equivale a correr solo el `backend`.
- **La GPU no la consume ningún contenedor por existir.** La consume el subproceso de job
  (`main.py`, el único `import torch` a nivel de módulo del repo) y solo mientras hay trabajo.
  `app.py` no importa nada pesado a nivel de módulo: con la cola vacía el API está en CPU y sin VRAM tomada.
- `GPU_MIN_FREE_MB=4500` por defecto. En una GPU de **6 GB** (el caso medido: GTX 1660, 6144 MiB) esa puerta
  deja **un job a la vez** en la práctica, por mucho que `MAX_CONCURRENT_JOBS=5`. La capacidad real la fija la
  VRAM, no el número de contenedores.
- El mayor consumidor de VRAM es el ASR (`faster-whisper`), y el ASR es justo lo que este nicho **no**
  necesita (ADR-4).
- `frontend`: en el stage `prod` de `dashboard/Dockerfile` es **nginx sirviendo estáticos** (CPU ~0 en reposo).
  El `docker-compose.yml` local usa `target: dev`, un **Vite dev server** con HMR: ese es el único
  consumidor prescindible de verdad y solo en local.
- `renderer`: Chromium headless + Remotion. CPU-intensivo **durante un render**, ~0 en reposo.

Consecuencias para `openRanks`:

1. **No reutilizar el frontend de OpenShorts.** El panel de revisión es propio (`web/`): el de OpenShorts no
   aporta nada aquí y su modo dev es el único trozo prescindible del stack.
2. **No reutilizar su imagen de GPU.** Sin ASR no hace falta `--build-arg GPU=1` (~2 GB de librerías CUDA),
   ni la puerta de 4,5 GB de VRAM, ni `torch` en el camino crítico. Imagen propia: ffmpeg + opencv + YOLOv8n.
3. **Puede convivir** con OpenShorts en la misma GPU de 6 GB: lo que ocupa es YOLOv8n + PySceneDetect,
   no un modelo de voz. Aun así, el default del RPD sigue siendo **CPU-only** (ADR-4): en CPU no compite
   ni por VRAM ni por el lock de inferencia que serializan los detectores de OpenShorts.
4. **Apagar el frontend ahorra RAM y disco, no GPU.** Si el objetivo es bajar CPU/GPU, las palancas son:
   no transcribir, acotar duración de fuente y no renderizar en paralelo — no quitar contenedores.

**Medición pendiente (no medida todavía).** El daemon de Docker no estaba corriendo, así que no hay cifras
reales de esta máquina. Cuando se levante el stack:

```bash
docker compose up -d && sleep 60
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'   # en reposo
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'   # con 1 job activo
nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv -l 1                 # por fase del pipeline
```

El objetivo de la capa L4 es comparar tres configuraciones (solo `backend`; `backend`+`frontend`; los tres) y decidir
la del despliegue con la tabla de medidas delante, no con la intuición.

---

## 11. Legal y cumplimiento (bloqueante, no opcional)

Este producto republica fragmentos de vídeo de terceros; ese es su riesgo principal.

1. **Solo fuentes con derechos**: canal propio, contenido con licencia explícita, CC-BY, o permiso escrito del
   creador. El sistema guarda `source.url` + autor para poder retirar contenido (proceso DMCA interno).
   Se desaconseja el scraping masivo de compilados ajenos: además del copyright, choca con las políticas de
   contenido reutilizado de las plataformas ("reused content" de YouTube y las reglas de TikTok/IG).
2. **Nunca** se recorta ni se tapa la marca de agua ajena para ocultar la autoría: las puertas de RF-3
   **rechazan** el clip y el motivo queda registrado.
3. **Música**: solo pistas de bibliotecas con licencia comercial (o audio del propio creador con permiso).
   El compilado ajeno trae música con derechos: por defecto se **sustituye** por la pista del preset.
4. **Crédito y divulgación**: campo de crédito al creador original en la descripción (plantilla) y
   declaración de contenido sintético/editado donde la plataforma lo exija.
5. **Descarga**: se respetan los términos de YouTube y los mecanismos del repo (cookies, clientes de yt-dlp,
   `noplaylist`, allowlist). Sin proxies de pago salvo que el operador los configure.
6. **Datos de terceros**: no se almacenan datos de usuarios finales; no se usa `cloud/` (licencia comercial).
7. **Edición transformativa como requisito, no como estilo.** Los tutoriales abordan el problema de
   monetización de frente: el motivo declarado de añadir voz en off, efectos, rótulos propios y transiciones es
   que el vídeo deje de ser una recopilación y pase a ser un producto editado. En el diseño eso se traduce en:
   **nunca publicar un clip ajeno sin capa propia** (título, rótulo, VO o transición) y no permitir el modo
   "publicar el compilado tal cual". Es también la razón de que la VO, hoy fuera del MVP (§16), sea candidata a
   entrar en L2: es la capa transformativa más fuerte y la más barata de producir (una frase por clip).

**Puerta de salida L0**: checklist legal firmado por el operador sobre qué fuentes puede usar. Sin esto no se
publica nada, aunque el pipeline funcione.

---

## 12. Plan de ejecución

**El orden es el de «Orden de prioridades del producto»: L1 → L2 → L3 → L4** (ADR-7). Los milestones
M0–M5 del borrador se conservan **íntegros**, repartidos por capas; la tabla siguiente es el diccionario
entre ambos vocabularios. Estimación para **1 desarrollador full-time**; los rangos asumen que el código de
OpenShorts se copia/adapta (no se reescribe).

| Capa (prioridad) | Contenido | Origen (milestones) |
| --- | --- | --- |
| **L0** — Esqueleto | repo, compose, BD, cola, upload de archivos, CI, legal | **M0** (menos la ingesta de YouTube) |
| **L1** — 5 clips + vídeo vertical | normalización 9:16 por clip, unión, audio | parte de **M3** (normalización, unión) + ingesta de archivos de **M0** |
| **L2** — Edición del estándar | `RankingTop5`, badges, rótulos, transiciones, cover, OTIO | resto de **M3** (`core/specs.py`, composición) |
| **L3** — Extractora | ingesta YouTube, segmentación, screening, señales, scoring, selección | **M1** + **M2** |
| **L4** — Integrador | orquestación, panel, publicación, trazabilidad, endurecimiento | **M4** + **M5** |

### L0 — Esqueleto y terreno firme (semana 1)

| Entregable | Detalle |
| --- | --- |
| Repo + compose | api, worker, renderer, postgres, minio en Docker, `curl` y ffmpeg en imagen |
| BD + migraciones | Alembic con el esquema de §8 |
| Cola | `jobs` con `SKIP LOCKED`, reintentos, reanudación idempotente |
| Ingesta de archivos | upload de los 5 clips + `ffprobe` + proxy de análisis; **aún sin YouTube** |
| Reuso | copiar `ffmpeg_utils` (`video_encode_args`, `METADATA_SCRUB`) con cabecera de origen y NOTICE |
| CI | workflow que corre `core/` (stdlib + numpy), sin FFmpeg, sin torch y sin red (§13.1) |
| Legal | checklist de fuentes firmado (§11) |
| **Salida** | Los 5 clips entran por API y quedan en BD y MinIO con duración, resolución y fps |

### L1 — Entregable 1: 5 clips listos y un solo vídeo vertical (semana 2)

| Entregable | Detalle |
| --- | --- |
| Normalización por clip | 1080x1920 / 30 fps / yuv420p con `ffmpeg_utils`; TRACK como modo por defecto (§RF-6.3) |
| «Sin recortes pendientes» | criterio explícito: el clip final se publica tal cual (bordes limpios, sin barras negras, sin recodificar después) |
| Unión vertical | `core/specs.py`: orden `#5 → #1` (+ `cold_open` si se aprueba B1) y duración total real |
| Salida doble | **5 archivos individuales descargables** + **un solo `union.mp4` vertical** con audio a −14 LUFS |
| **Salida (criterio)** | `ffprobe` valida los 6 archivos (1080x1920, 30 fps, yuv420p, audio presente, 30–58 s el unido) y el operador los descarga del panel |

### L2 — Entregable 2: la edición del estándar (semana 3)

| Entregable | Detalle |
| --- | --- |
| Plantilla = datos | `Template + Binding → spec.json` (§20.0); **`Template` bloqueado por preset** (`presets/<nicho>/`) y `Binding` con **solo texto** (título + 5 nombres) |
| Overlays | badges de posición con ventana = su clip, rótulo por clip, banner con foto de referencia, contador, CTA |
| Edición tipo CapCut | transición *pull in* con solape 0,35 s + **swoosh** en cada frontera, zoom + swoosh en el primero (§20.1) |
| Herramienta | la que cumpla el estándar: renderer propio (Remotion) como camino crítico, FFmpeg/ASS como fallback (§20.4). La ruta CapCut queda fuera del producto (ADR-8) |
| Intercambio | exportación **OTIO** en el `manifest.json` (§20.3) |
| Cover + verificaciones | `cover.jpg`, `spec.json`, `manifest.json` y determinismo (mismo spec ⇒ mismo MP4) |
| Render automático | **sin ningún paso manual de montaje**: dados el preset y los textos, el MP4 sale solo; no hay editor, ni timeline, ni exportación a mano |
| Cambio de texto | re-render de **solo la capa de overlay** sobre el `union.mp4`, recalculando el encaje de §9.5 |
| **Salida (criterio)** | sobre el `union.mp4` de L1 sale un `ranking.mp4` publicable y comparable con la foto de referencia del preset; render < 6 min y < 30 s cuando solo cambian textos |

### L3 — Entregable 3: la extractora (semanas 4–5) · *el riesgo técnico real*

| Entregable | Detalle |
| --- | --- |
| Ingesta YouTube | `download_youtube_video`, `plan_download_attempts`, `cap_source_duration`, `yt_clients.py`, proxy de análisis, `MAX_SOURCE_MINUTES` |
| `core/segmentation.py` | resets, agrupación, banda de duración, cohesión, fusiones (§7.1) — con el ablation por señal de §19.2 |
| Clasificador compilado/único | §7.2, con `force_mode` |
| Screening + señales | §RF-3 y §7.3 + YOLO de sujeto |
| Scoring Gemini por lotes | esquema pydantic + `prompt_version` + contadores de coste reales (§RF-4) |
| Selección TOP 5 | §RF-5, determinista y testeada |
| Set de evaluación | 40 vídeos compilados con fronteras etiquetadas, **cosechado de los recortes manuales de L1** (§13.2, B7) |
| Harness | `python -m tests.eval.segmentation` → precisión, recall, F1 de fronteras, MAE de recuento |
| **Salida (criterio)** | los mismos 5 archivos que en L1 pero obtenidos solos: F1 de fronteras ≥ 0,85, accuracy ≥ 0,9, Spearman ≥ 0,6 y ≤ 0,003 USD/clip (§21) |

### L4 — Entregable 4: una sola herramienta (semana 6)

| Entregable | Detalle |
| --- | --- |
| Orquestador | una entrada (URL o archivo) → L3 → L1 → L2 → render, encima de la cola de `jobs` |
| Panel único | subir clips a mano (L1), revisar el ranking, aprobar / rechazar / sustituir |
| Publicación | Upload-Post inmediato y programado, `TIKTOK_POST_MODE`, títulos por plataforma, `publications` |
| Trazabilidad | `review_decisions`, ledger de coste y manifiesto por render |
| Endurecimiento | recalibración con los rechazos reales, dedupe entre rankings, runbook, prueba de 50 fuentes/día |
| Huella de cómputo | la tabla de medidas de §10.5 (solo `backend` vs. con `frontend` vs. los tres, y convivencia con OpenShorts) |
| **Salida (criterio)** | 20 shorts publicados sin intervención manual salvo la revisión, con una sola herramienta de punta a punta |

### 12.1 Backlog priorizado (v2)

1. Ingesta de TikTok y de canales completos con autopilot (portar `cloud/autopilot.py`).
2. Ajuste fino de bordes de clip ya cortado (recorte inteligente del inicio lento).
3. Generación de banners y fotos de referencia con IA + biblioteca por temática.
4. Voz en off corta ("¡mira el #1!") y subtítulos animados.
5. Recalibración automática del umbral con la analítica real de las publicaciones.
6. Multi-idioma de textos y A/B de estilos de overlay.

---

## 13. Estrategia de verificación

### 13.1 Tests automáticos (CI en cada push)

- **Unitarios de `core/`** (sin FFmpeg, sin red, sin torch): pesos de reset, banda de duración, cohesión,
  partición por frontera débil, `reset_score` en fixtures sintéticos, puertas de screening con métricas
  inyectadas, combinación score/señales, restricciones de selección (mismo clip dos veces ⇒ falla),
  generación de specs y cálculo de duración total. Es el equivalente de `tests/test_clip_selection.py`.
- **Integración**: ingesta de un mp4 fixture de 3 min (compilado sintético con clips de 5 s y bandas
  negras/marca de agua falsas), segmentación + screening + (Gemini mockeado) ranking, y render con spec fijo.
- **Esquemas**: el esquema pydantic del scoring rechaza salidas malformadas (`severity`/`score` fuera de rango);
  el renderer rechaza props inválidas (test en TS, patrón `composition-metadata.test.ts` del repo).
- **Contrato de publicación**: el payload multipart a Upload-Post se valida con un mock (nunca una publicación real
  en CI).

### 13.2 Evaluación (offline, con datos reales)

| Set | Tamaño | Métrica de aceptación |
| --- | --- | --- |
| Segmentación | 40 vídeos etiquetados | F1 de fronteras ±0,5 s ≥ 0,85; accuracy compilado/único ≥ 0,9 |
| Screening | 200 clips (100 malos conocidos) | precisión de rechazo ≥ 0,95; recall de malos ≥ 0,8 |
| Calibración de score | 120 clips con score humano | Spearman ≥ 0,6; acuerdo de top-3 ≥ 60 % |
| End-to-end | 10 compilados reales | short publicable en ≤ 15 min y ≤ 0,30 USD; 0 clips con watermark ajeno |

Los sets, sus etiquetas y los informes de resultado viven en `tests/eval/` y `docs/eval/`, versionados, porque
cada cambio de pesos o de prompt debe poder compararse contra la medición anterior.
*(→ B7, §18: escribir la guía de etiquetado —qué es «un clip»— junto con el set; y recordar que, con el
orden por capas, el set se cosecha de los recortes manuales de L1 en vez de etiquetarse desde cero.)*

### 13.3 Criterios de "hecho" (definición de terminado)

1. Requisitos del milestone implementados y con criterios de aceptación **medidos**, no supuestos.
2. Tests nuevos y existentes en verde, CI verde.
3. Sin secretos ni datos de terceros en el repo, commits o logs.
4. Documentación actualizada (este RPD, ADR si cambió una decisión, runbook si cambió la operación).

---

## 14. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
| --- | --- | --- | --- |
| R1 | **Segmentación mala en compilados con transiciones o zoom** (fronteras mal puestas) | Alto: el short corta a mitad de chiste | Spike temprano de L3 (§12, ADR-7); set etiquetado **cosechado de los recortes manuales de L1**; banda de tolerancia ±0,5 s; revisión humana como red |
| R2 | **Derechos de autor / contenido reutilizado** | Muy alto: strikes, desmonetización, retirada | §11 completo; puertas que rechazan watermark ajeno; registro de fuente y autor; checklist legal en L0 |
| R3 | Gemini puntúa de forma inconsistente entre corridas | Medio: ranking inestable | Rúbrica cerrada, `prompt_version` persistida, temperatura baja, lote homogéneo, umbral calibrado con datos |
| R4 | Falsos rechazos del screening (se pierden buenos clips) | Medio | Precisión ≥ 0,95 como criterio, umbrales conservadores, todo rechazo recuperable por el operador |
| R5 | Rate limit / coste de Gemini | Medio | Lotes de 6, caché por `content_hash` del segmento (no re-puntuar), presupuesto por fuente |
| R6 | Música con derechos arrastrada del compilado | Medio | Sustitución por defecto por pista del preset; `music_bed` detectado y registrado |
| R7 | Licencia: copiar código de OpenShorts | Bajo | Núcleo MIT, se copia con NOTICE y cabecera de origen; **nunca** `cloud/` |
| R8 | Render lento o no determinista | Bajo | Remotion con animaciones por frames, caché de segmentos normalizados, medición de render_ms |
| R9 | La analítica de la plataforma no da retención | Bajo | No se promete; solo se leen las métricas que Upload-Post exponga |
| R10 | Dependencia de la API de terceros para publicar | Medio | Adaptador aislado (`publish.py`) con contrato propio; el render queda publicado manualmente si falla |

---

## 15. Decisiones registradas (ADR-lite)

| ADR | Decisión | Motivo |
| --- | --- | --- |
| ADR-1 | **Servicio nuevo**, no un modo dentro de OpenShorts. Código reutilizado en `reused/` con cabecera de origen y commit upstream anotado | El flujo es *visual-first* y *ranking-first*; forzarlo dentro del pipeline transcript-first mezclaría dos productos y ensuciaría las reglas duras del repo original (watermark de free plan, cupos, autopilot). Además: perfiles de ejecución incompatibles (GPU/ASR vs. CPU-only), regla de redespliegue en cada push a main, y riesgo legal distinto (republicación de terceros) |
| ADR-1b | **No copiar y pegar a ciegas**: `reused/` es un paso intermedio; el paquete compartido se extrae **después de L2**, cuando se sabe qué helpers se usan de verdad | Copia pura = fork con divergencia silenciosa (yt-dlp y los detectores cambian); extraer el paquete antes de tiempo = abstraer código que quizá no se usa (p. ej. `split_layout`, `layout_picker`: para mascotas probablemente baste TRACK). Candidatos a paquete: escenas, señales, matemática EDL/ffmpeg, esquemas Gemini, precios — todos ya *stdlib-light* a propósito |
| ADR-2 | Cola en **Postgres** (`SKIP LOCKED`), sin Redis | Un solo motor de datos; suficiente para ~50 fuentes/día; transaccional con el estado de las fases |
| ADR-3 | Overlay animado en **Remotion**, no `drawtext` | Badges animados, banner con foto, reproducibilidad por frames; `hooks.py` queda como fallback |
| ADR-4 | **Sin ASR**: servicio CPU-only | El nicho no tiene diálogo útil; elimina Whisper, VRAM y `release_models()` del camino crítico. `torch` entra solo si se elige TransNetV2 para escenas (ver RF-2). *(→ B3, §18: reenunciar como visual-first con ASR opcional por preset)* |
| ADR-5 | **Frames, nunca vídeo completo a Gemini** | El repo documenta que `get_visual_clips` no tiene guarda de longitud (~1 M tok/hora); con frames el coste y el límite desaparecen |
| ADR-6 | El **LLM puntúa, el código decide** | Heredado de `clip_selection.score_batches`: la comparación y las cuotas se hacen donde son medibles |
| ADR-7 | **Construcción de atrás hacia delante por capas**: L1 (5 clips + vídeo vertical) → L2 (edición del estándar) → L3 (extractora) → L4 (una sola herramienta) | Decisión del operador: primero existe el producto terminado —formato y edición validados, algo publicable desde la semana 2— y después se automatiza su entrada. Contrato entre capas = **archivos + manifiesto**, así L2 y L3 no se conocen. Invierte «el riesgo primero»: la extracción es la prio 3, con spike temprano de 2–3 días y con el set de evaluación cosechado de los recortes manuales de L1. El riesgo mayor (contenido ajeno sin capa propia, §11) lo cubren justamente L1/L2 |
| ADR-8 | **Render 100 % automático y superficie editable = solo texto**: título del vídeo + nombre de cada puesto. Nada del montaje se edita a mano | Decisión del operador. El estándar visual lo fija el preset y no el operador por vídeo, así que el resultado es reproducible y comparable entre rankings, el trabajo humano se reduce a elegir y revisar, y el render nunca espera a nadie. Deja fuera la ruta B de §20 (borrador para retocar a mano) y obliga a reglas de encaje automático del texto (§9.5) |

---

## 16. Preguntas abiertas (necesarias antes de L2)

*(→ qué preguntas son «gate» de cada capa: B7 en §18.)*

1. **Preset de estilo**: ¿un solo look (fuente, paleta, badge, música) o varios presets por temática
   (`gatos`, `perros`, `mixto`)? El spec de §9.2 está preparado para ambos; hay que elegir el del lanzamiento.
2. **Foto de referencia**: ¿el operador la sube por ranking, o hay una biblioteca fija por temática y el
   sistema solo elige? El MVP asume subida manual + biblioteca opcional.
3. **Idioma de los textos** (`hook`, banner, CTA) y **tono**: el set de calibración debe etiquetarse en ese idioma.
4. **Volumen objetivo** (shorts/día) para dimensionar `WORKER_CONCURRENCY` y el presupuesto de Gemini.
5. **¿Se publica en la cuenta del propio operador únicamente?** (afecta a `TIKTOK_POST_MODE` y al flujo de
   perfiles de Upload-Post).
6. **Revisión**: ¿siempre humana antes de publicar, o modo "auto-publicar si score ≥ X"? El MVP exige revisión.
7. **Duración objetivo** del short (35–58 s por defecto): ¿se admite un formato "TOP 10" en v2 con la misma
   maquinaria? (Sí, cambiando solo `n` en la selección y el layout del contador.)
8. **Variante del indicador de rango**: escalera de cinco números fijos en vertical (el estilo de los dos
   tutoriales) o un solo badge que cambia de número. La implementación soporta ambos; hay que elegir por
   defecto y lo decide la foto de referencia. Afecta a cuánto espacio lateral come el overlay.
9. **Voz en off en el MVP o en L2**: una frase por clip con ElevenLabs. Es copy barato y la capa
   transformativa más fuerte frente al riesgo de contenido reutilizado (§11), pero añade una dependencia
   (ElevenLabs) y una decisión de idioma/voz. Recomendación: entrar en L2 como opción por preset, con
   `voiceover.enabled=false` por defecto.
10. **¿Se publica el mismo short en las tres redes con el mismo texto, o con copy por plataforma?** El repo ya
    guarda `video_description_for_tiktok` / `_instagram` / `video_title_for_youtube_short`; decidir si el
    ranking hace lo mismo o un solo texto.

**ADR-8 reduce esta lista**: 1, 2 y 8 dejan de ser decisiones por ranking y pasan a ser **configuración del
preset** (se deciden una vez, no por vídeo): el operador no elige look ni sube foto de referencia por ranking.

---

## 17. Anexos

### 17.1 Variables de entorno

| Variable | Defecto | Uso |
| --- | --- | --- |
| `DATABASE_URL` | — | Postgres |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | — | MinIO/S3 |
| `GEMINI_API_KEY` | — | Scoring visual |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Modelo de scoring |
| `UPLOAD_POST_API_KEY` | — | Publicación |
| `WORKER_CONCURRENCY` | `2` | Jobs en paralelo |
| `MAX_SOURCE_MINUTES` | `45` | Techo de duración de fuente |
| `MIN_SEGMENT_SECONDS` / `MAX_SEGMENT_SECONDS` | `1.5` / `45` | Banda de segmentos |
| `SCENE_ENGINE` | `pyscenedetect` | Motor de cortes (`pyscenedetect` \| `transnetv2`; `TRANSNETV2_THRESHOLD` si se usa el segundo) |
| `SEGMENT_RESET_THRESHOLD` | `0.45` | Umbral de frontera |
| `RANKING_SCORE_CUTOFF` | `70` | Umbral de viralidad |
| `RANKING_MAX_PER_SOURCE` | `1` | Diversidad de fuentes |
| `RANKING_TARGET_SECONDS` | `45` | Duración objetivo |
| `SCORE_BATCH_CLIPS` | `6` | Clips por llamada a Gemini |
| `RENDER_TIMEOUT_SECONDS` | `600` | Techo de render |
| `RETENTION_SOURCE_DAYS` / `RETENTION_PROXY_DAYS` | `30` / `7` | Retención |

### 17.2 Prompt de scoring visual (esquema)

```
Eres un editor senior de short-form especializado en mascotas. Recibirás N clips
candidatos; cada uno trae 8-12 frames en orden y un resumen numérico de señales.

Para CADA clip, devuelve:
  score (0-10) rúbrica: remate cómico 40%, sorpresa 20%, ternura 20%,
                        energía 10%, legibilidad del primer segundo 10%
  verdict: keep | reject
  humor_type: caida | susto | robo_de_comida | travesura | reaccion | baile |
              rescate | ternura | caos_multiple | otro
  species: cat | dog | other
  payoff_second: segundo en que ocurre el remate (relativo al clip)
  why: una frase
  hook: <= 10 palabras, en {idioma}, sin inventar hechos

Reglas: puntúa TODOS los clips del lote contra la misma rúbrica (no elijas
"los mejores"); no describas el vídeo en general; penaliza clips donde no se
distingue la mascota o donde no hay remate visible; no devuelvas medidas.
```

### 17.3 Mapa de reuso (resumen ejecutable)

*(→ panorama ampliado de herramientas externas por etapa en §19.)*

| Paso | Módulo nuevo | Copiado de OpenShorts |
| --- | --- | --- |
| Ingesta | `worker/stages/ingest.py` | `main.download_youtube_video`, `main.plan_download_attempts`, `yt_clients.py` |
| Segmentación | `core/segmentation.py` (nuevo) | `scene_detection.py` |
| Screening | `core/signals.py`, `worker/stages/screen.py` | `main.detect_person_yolo` (extendido a cat/dog), `yolov8n.pt` |
| Scoring | `core/scoring.py`, `worker/stages/score.py` (nuevo) | `gemini_worker.py` (esquemas, coste), `clip_selection.MODEL_PRICES` |
| Selección | `core/selection.py` (nuevo) | `clip_selection.{trim_to_best, dedupe_overlapping}` como inspiración |
| Reframing | `worker/stages/rank.py` | `reframe_v2.py`, `layout_picker.py` |
| Render | `renderer/src/RankingTop5.tsx` (nuevo) | `remotion/src/*`, `render-service/*` |
| Codificación | — | `ffmpeg_utils.py` |
| Marca | — | `watermarked.py`, `assets/make_watermark.py` |
| Publicación | `worker/stages/publish.py` | `app.py:/api/social/post`, `TIKTOK_POST_MODE` (patrón de `cloud/social_profiles.py`, reimplementado sin copiar) |
| Panel | `web/` (nuevo) | patrones de `dashboard/src` |

### 17.4 Evidencia del formato: transcripciones de los vídeos de referencia

El formato de §3 y los tokens de §9.2 **no** se derivaron del título de los vídeos: se sacaron leyendo sus
transcripciones. No puedo ver vídeo, pero sí su audio transcrito, que en dos tutoriales es literalmente el
procedimiento completo. Receta reproducible (temporal, fuera del repo):

```bash
python -m venv /tmp/refvids/venv && /tmp/refvids/venv/bin/pip install yt-dlp
/tmp/refvids/venv/bin/yt-dlp --skip-download --write-auto-subs --sub-langs "en.*" \
  --sub-format vtt -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=<ID>"
# limpiar el VTT (quitar timestamps y el rolling duplicado) -> texto plano
```

Qué confirmó y qué corrigió respecto al diseño inicial:

| Punto | Antes (diseño inicial) | Según los tutoriales |
| --- | --- | --- |
| Números de rango | Un badge que cambia de número | **Cinco capas fijas en vertical**, `#5` abajo → `#1` arriba |
| Colores | Un solo color de acento | **Oro `#1`, plata `#2`, bronce `#3`**; acento para los bajos |
| Título por clip | No contemplado | **Sí, uno por clip**, diseñado para provocar comentarios |
| Rótulo ajeno quemado | Rechazar el clip | **Taparlo** con desenfoque + máscara (pasó a ser reparación) |
| Transiciones | Corte seco | Transición animada entre todos + **swoosh**; **zoom-in + swoosh** en el primero |
| Música | Parte del preset | **Opcional**: los tutoriales ni la mencionan o la dejan al final |
| Selección de fuentes | Solo por contenido | También por **views y comentarios** del clip original |
| Voz en off | v2 | Central en el tutorial "monetizable": es la capa transformativa |
| Riesgo de monetización | Riesgo legal en general | Motivo declarado de cada adorno: no parecer contenido reutilizado |

Lo que estas transcripciones **no** pueden dar (y sigue pendiente): proporciones exactas, tipografías reales,
timing de las animaciones y el aspecto final del montaje. Eso lo fija la foto de referencia + un frame real
(§16), no una descripción hablada.

---

# Parte II — Revisión previa y anexos de integración

| Campo | Valor |
| --- | --- |
| **Objeto** | Qué cerrar **antes** de arrancar L0 y L1, con qué herramienta existente se cubre cada etapa, y cómo se implementa una edición automática tipo CapCut |
| **Estado** | Hallazgos y enmiendas **propuestas**: no cambian el plan hasta que el operador decida |
| **Fecha** | 13-oct-2026 |

Tres encargos del operador, en orden:

1. El núcleo debe servir para **más tipos de vídeo**, no solo mascotas.
2. Antes de construir, **comprobar qué herramientas ya existen** para cada etapa del proceso.
3. Cómo se implementa una **edición automática tipo CapCut** (plantilla + nombres de los puestos
   apareciendo a medida que se reproducen los clips).

## 18. Bloqueantes y enmiendas (antes de L0)

### B1 · Contradicción en el orden: el mejor clip no puede ser el primero *y* el último

La Parte I (§3) dice: *"cuenta atrás #5 → #1; el clip más fuerte va primero (el hook de los primeros
3 segundos) y el #1 cierra como payoff"*. Y en RF-5: *"Orden #5 → #1 por score ascendente, con el
mejor en #1"*.

Con un solo eje temporal, las dos cosas no pueden ser ciertas: si el mejor es `#1`, va **al final**.
Lo que hacen los canales del nicho es un **cold open**: 1,5–2,5 s del `#1` (el remate, sin rótulo de
posición) como gancho, corte, y después el countdown `#5 → #1` que termina con ese mismo clip **completo**.

- **Cambio propuesto**: añadir `cold_open` al spec §9.2 y un `segment` sintético de posición `0` en
  `ranking_items` (o un campo `teaser` en `renders.spec`). El cálculo de duración de §RF-6 y el
  criterio de 30–58 s deben incluir esos ~2 s.
- **Efecto en el código**: `core/specs.py` gana un tramo; la composición Remotion un `<Sequence>` previo.
  Barato, pero si no se decide ahora, L2 se rediseña.

### B2 · Generalización: el RPD está cableado a mascotas en 7 puntos

El objetivo declarado es que "funcione para más tipos de vídeo, como OpenShorts". Hoy el nicho está
incrustado en el esquema, el prompt y las puertas. Sitios exactos y cambio:

| # | Dónde | Hoy | Cambio |
| --- | --- | --- | --- |
| 1 | RF-4.3, §7.4, §17.2 (`humor_type`) | Enum cerrado de chistes de mascotas (`caida`, `robo_de_comida`, …) | **`moment_type`** con enum **por preset** (cargado de un archivo, validado por pydantic). Deporte → `gol, parada, fallo, celebración`; cocina → `emplatado, corte, desastre` |
| 2 | RF-4.3 (`species`) y §8 `clip_scores.species` | `cat \| dog \| other` | **`entities: string[]`** (lista abierta por preset) + `entity_ratio` por entidad |
| 3 | RF-3 (puerta "mascota presente") | Clases `cat`/`dog` de YOLOv8n | **Detección de vocabulario abierto** (YOLO-World / GroundingDINO / OWL-ViT) con la lista de sujetos del preset. Sin reentrenar por nicho |
| 4 | §17.2 (prompt) | "editor senior especializado en mascotas" | **Plantilla de prompt con variables**: `{sujeto}`, `{rúbrica}`, `{taxonomía}`, `{idioma}` |
| 5 | §9.2 (`theme: "top5-gatos"`) y `style` | Tema único de gatos | Directorio **`presets/<nicho>/`**: taxonomía + prompt + style + assets + umbrales. `rankings.preset_id` en §8 |
| 6 | §7.2 clasificador compilado/único | Ya es agnóstico | Nada. Es la pieza que **sí** generaliza gratis (mide estructura de montaje, no contenido) |
| 7 | ADR-4 ("sin ASR") | Válido solo para nichos visuales | Ver B3 |

**Puerta de calidad propuesta para el core**: un segundo preset (p. ej. *fails deportivos* o *cocina*)
debe pasar los criterios de L3 (segmentación + screening + scoring) **sin tocar código**, solo añadiendo `presets/<nicho>/`. Si hay que
tocar `core/`, el core no está generalizado. Es la única forma de que "sirve para más vídeos" sea un
criterio medible y no una promesa.

Ojo con lo que **no** generaliza: las puertas deterministas de RF-3 son fáciles en mascotas (un perro se
detecta), y mucho más débiles en otros nichos. Propuesta: que cada preset declare sus umbrales y que un
preset pueda **degradar** una puerta a "advisory" (no rechaza, solo informa al score), con el rechazo
final en manos del score LLM. El RPD ya tiene el principio correcto ("el LLM puntúa, el código decide");
RF-3 es la excepción y conviene hacerla explícita por preset.

### B3 · ADR-4 es una decisión de nicho, no de producto

"Sin ASR" es correcto para compilados de mascotas y **falso** para casi cualquier nicho con habla
(talking heads, gameplays comentados, react). Si el core promete "más tipos de vídeo", ADR-4 debe
reenunciarse: *"el camino crítico es visual-first; el ASR es opcional y se activa por preset
(`preset.needs_transcript: true`)"*. El repo de referencia ya tiene ese camino (`get_viral_clips`)
y está MIT: es la puerta de escape, no un rediseño.

### B4 · Timing del overlay: `hold_s` contradice "visible durante su clip"

En §9.2, `rank_ladder.hold_s: 0.8` y `clip_label.hold_s: 0.9` conviven con la regla de §3 *"cada uno
visible durante su clip"* (5–10 s). No se sabe si `hold_s` es "tiempo visible" o "duración de la
animación de entrada". Igual con `cta.hold_s: 1.5`.

- **Cambio propuesto**: renombrar a `enter_at` / `hold_s` / `exit_at` explícitos, o definir `hold_s`
  como "segundos que permanece **totalmente** visible tras la entrada". El rótulo de clip necesita
  ≥ 1,5 s para ser legible en un clip de 6 s; 0,9 s se pierde.
- **Y el detalle que rompe el render**: si hay transición de 0,35 s entre **todos** los clips, la
  duración total es `Σ clips − 4 × 0,35`, no `Σ clips`. `core/specs.py` debe calcular el total con los
  solapes y el criterio "30–58 s" medirse sobre el total **real**. Si no, el último badge y el CTA se
  desincronizan del vídeo por ~1,4 s.

### B5 · Legal: "reparar" y "tapar" no pueden convivir sin regla

RF-3 permite `repair:mask_text` (duplicar + desenfoque + máscara sobre rótulos ajenos quemados) y §11.2
prohíbe tapar marcas de agua ajenas. Un rótulo quemado en un compilado suele ser **el handle del canal
de origen**, que es exactamente una marca de autoría.

- **Cambio propuesto**: la puerta debe **leer** el texto, no solo medir bordes: si el texto detectado es
  un `@handle`, un nombre de canal o una URL → `rejected:foreign_credits`; si es un subtítulo genérico o
  una etiqueta de contexto → `repair:mask_text`. Se resuelve con el OCR de §19.
- **Hueco no cubierto**: la música. Se dice "se sustituye por la pista del preset", pero si se muta la
  pista del compilado se pierde el audio del chiste (ladrido, golpe, carcajada), que es media gracia y
  parte de las señales de §7.3 (`audio_peak`). Alternativa real: separación de fuentes (Demucs /
  `htdemucs`, CPU, ~1–2× tiempo real) para quedarse con la pista "other" y tirar la música. Es un
  coste de ~1 min por fuente: cabe en el presupuesto de §10.2, pero hay que decidirlo y presupuestarlo.

### B6 · El presupuesto de coste está por debajo de lo probable

§10.1 estima ~600 tokens por frame a 1024 px. La tokenización por mosaicos de Gemini no es lineal con
el lado mayor: un frame grande puede costar ~2–4× eso. Con 8–12 frames por clip, el techo de
0,003 USD/clip puede quedar corto.

- **Acción L0 (30 min, no es diseño)**: una sola llamada real con 8 y con 12 frames a 512 y a 1024 px,
  y se fija el tamaño de frame del pipeline con el número medido. Para *puntuar* no hace falta 1024 px:
  512 px basta para semántica y reduce coste y latencia. Reservar 1024 px para el frame de portada.
- Añadir **context caching** del prompt del sistema por proyecto (rúbrica + taxonomía), que es la parte
  fija de cada llamada.

### B7 · Lo que la revisión de §16 añade: qué preguntas son *gate* y cuáles no

Las 10 preguntas de §16 están bien planteadas, pero bloquean milestones distintos. Orden propuesto:

| Gate | Preguntas | Por qué |
| --- | --- | --- |
| **Antes de L0** (= M0) | 5 (cuentas), 7 (duración/n), 10 (copy por plataforma) | Afectan al esquema de datos y al contrato de publicación |
| **Antes de L2** (la edición) | 1, 2, 8 (preset, foto de referencia, variante de badge) y 3 (idioma de los textos) | Es el estándar visual: sin foto de referencia no hay nada que replicar ni contra qué comparar (§12, L2) |
| **Antes de L3** (la extractora) | La de B2 (segundo preset) | El set de segmentación y el de calibración se etiquetan **en ese idioma** y con esa definición de "clip" |
| **Antes de L4** (el integrador) | 9 (VO) | Decide si entra ElevenLabs en la imagen |

Falta una pregunta que sí es de diseño: **¿qué es "un clip" para el etiquetado humano?** Los tutoriales
cuentan un chiste como una unidad (plano del perro + reacción del dueño = *un* clip). Si los
etiquetadores marcan fronteras de plano, el F1 de RF-2 se mide contra la definición equivocada y L3 se
declara bueno o malo por error. Hay que escribir la guía de etiquetado junto con el set.

### B8 · Coherencia con las reglas del repo público

`docs/rpd/` vive en un repositorio público. Dos cosas a confirmar antes de publicar el RPD:
§10.5 cita especificaciones de una máquina concreta y §10.1 un presupuesto de coste por short. No son
secretos, pero la regla del repo excluye "métricas de producción y cifras de negocio": conviene
decidir si se generalizan (p. ej. "GPU de 6 GB") o se mueven fuera del repo.

---

## 19. Panorama de herramientas: qué existe ya para cada etapa

Cada etapa del pipeline del RPD, con su veredicto: **ADOPTAR** (usar tal cual), **COPIAR** (código MIT
al `reused/`, como ya propone el RPD) o **CONSTRUIR** (no hay nada que sirva).

| Etapa | Qué existe | Veredicto |
| --- | --- | --- |
| Descarga | `yt-dlp` (+ `yt_clients.py` del repo) | **COPIAR** — ya está en el plan |
| Cortes de plano | **PySceneDetect 0.7** (`ContentDetector`, `HashDetector`), **TransNetV2**, AUTOCaT / `video-scene-splitter` (herramientas de escritorio que cortan por escena) | **COPIAR/ADOPTAR** — ya está en el plan; las de escritorio no aportan nada (no agrupan) |
| Agrupar planos en clips | No hay herramienta *drop-in*. Es un problema clásico con literatura: *shot grouping* / *scene segmentation* (Microsoft Research, VSMBD, surveys 2024–2026) | **CONSTRUIR** `core/segmentation.py` — pero **con las features conocidas**, no con pesos inventados |
| Señales deterministas | **ffmpeg** ya trae `blackdetect`, `freezedetect`, `silencedetect`, `signalstats`, `astats` | **ADOPTAR** en lugar de reimplementar "negro/silencio/estático" en numpy |
| Texto quemado | **PaddleOCR PP-OCRv5** (Apache-2.0): detector de texto + reconocedor | **ADOPTAR** — sustituye el heurístico de "densidad de bordes" y además **lee** el texto (B5) |
| Marca de agua / logo | No hay herramienta fiable. `matchTemplate` + pHash del plan es razonable | **CONSTRUIR** (simple) |
| Calidad de imagen | Varianza del Laplaciano (plan) es el estándar; alternativas pesadas: `pyiqa`, DOVER, Q-Align, *aesthetic predictor* | **CONSTRUIR** con Laplaciano; las pesadas quedan para v2 |
| Detección de sujeto | Ultralytics YOLO (ya en el repo) / **vocabulario abierto**: YOLO-World, GroundingDINO, OWL-ViT | **ADOPTAR** — YOLOv8n para mascotas, open-vocab para el resto (B2) |
| Scoring de viralidad | Gemini por frames (plan, ADR-5). Alternativa de pago: **Twelve Labs** (Marengo/Pegasus 1.5, que hace *schema-driven segmentation* y devuelve metadatos con timestamps sobre el vídeo completo) | **CONSTRUIR** como plan; Twelve Labs es el plan B si el scoring propio no llega a Spearman 0,6 |
| Selección TOP-N | No hay nada; es optimización combinatoria | **CONSTRUIR** — correcto |
| Render | **Remotion** (plan) + **ffmpeg** como fallback; **OpenTimelineIO** (Academy Software Foundation) como formato de intercambio | **ADOPTAR** — ver §4 |
| Overlay de texto | `hooks.py` (fallback), ASS `{\an5}` (ya usado por `subtitles.py`), `drawtext enable=` | **ADOPTAR** |
| Publicación | **Upload-Post** (plan) | **COPIAR** patrón de `/api/social/post` |
| Cola / datos | Postgres `SKIP LOCKED` (plan) | **CONSTRUIR** — correcto para el volumen |

### 19.1 El hueco real: nadie vende "compilado → clips"

La búsqueda confirma lo que el RPD intuye: existe detección de **planos** (PySceneDetect, TransNetV2,
herramientas de escritorio) y existen APIs de **comprensión de vídeo** (Twelve Labs), pero no una
herramienta que responda "este compilado de 12 min contiene 24 clips y aquí están sus fronteras".
Es exactamente donde el plan pone el riesgo. Con el orden por capas (§12, ADR-7) esa capa es **L3 y ya no
va primera**: de ahí el spike temprano de 2–3 días y el set de evaluación cosechado de los recortes
manuales de L1.

### 19.2 La crítica al `reset_score` de §7.1

Los pesos (0,35 aspecto + 0,25 marca de agua + 0,20 audio + 0,15 paleta + 0,05 resolución + 0,10 negro)
son una **hipótesis sin medir**, y tienen un modo de fallo conocido: cuando el compilado está
**re-codificado en un solo formato** (mismo aspecto, sin marca de agua, un solo bitrate) — que es el caso
típico de los compilados de YouTube — las dos señales de más peso valen **0 en todo el vídeo** y quedan
0,20 + 0,15 + 0,10 = 0,45 de señal útil, justo por debajo del umbral 0,45. En ese escenario el detector
no corta nada.

- **Acción antes de tocar los pesos**: en L3, hacer un **ablation** por señal sobre el set etiquetado
  (F1 con una señal sola) y fijar pesos con datos. Y añadir la señal que sí sobrevive a un compilado
  homogéneo: **cambio de locutor/ambiente de audio** (huella espectral) y **cambio de música** — pero ver
  B5 (con música sustituida, la huella de audio también se va).
- Alternativa barata y potente que no está en el plan: **embeddings de frame** (CLIP/SigLIP) y cortar
  donde la *similitud semántica* entre planos cae, en vez de depender solo de formato y audio. Es la
  señal que la literatura de *scene boundary detection* usa, y en CPU es viable a 8 fps sobre el proxy.

---

## 20. Edición automática tipo CapCut: cómo se implementa

La pregunta del operador, respondida en tres rutas. La recomendación está al final.

### 20.0 La idea central: una plantilla es **datos**, no un editor

"Estilo CapCut" no es *automatizar CapCut*: es reproducir su gramática visual (transición *pull in*,
badges que entran, whoosh en cada corte, zoom en el primero) de forma **paramétrica y determinista**.
Formalizado:

```
Template  = { layout, slots[], style, sfx_map }        // fijo por preset, versionado
Binding   = { slot_id -> { text, in_frame, out_frame } }   // cambia por ranking
Timeline  = bake(Template, Binding)                    // = spec.json de §9.3
```

El RPD ya tiene esta forma en §9.2/§9.3 (`style`, `spec.json`, props tipadas). Lo que falta para que
"sirva para más tipos de vídeo" (encargo 1) es que la plantilla sea **cargable por preset**, no un tema
hardcodeado. Entonces añadir un nicho = añadir una carpeta, no tocar el renderer.

### 20.1 Ruta A — Renderer propio (recomendada)

Es la del RPD (Remotion) y es la única que da MP4 publicable sin intervención. Los badges por posición
son **overlays con ventana temporal igual a la de su clip**:

```tsx
// Renderer propio (Remotion): un slot por posición, visible solo durante su clip
{segments.map((s, i) => (
  <Sequence key={i} from={s.fromFrame} durationInFrames={s.durationInFrames}>
    <RankSlot n={5 - i} slotY={LADDER[5 - i]} enter="spring" />
    <ClipLabel text={s.label} />
    <OffthreadVideo src={s.src} />
  </Sequence>
))}
```

La escalera (`rank_ladder`) se dibuja como **cinco posiciones fijas**: cada número aparece cuando
empieza *su* clip y se queda en su sitio. En la variante `single_badge`, en cambio, hay un solo badge
que cambia de número en cada frontera.

Fallback nativo del repo, sin Remotion — con FFmpeg es literalmente una condición temporal, y con ASS
(lo que ya usa `subtitles.py` con `{\an5}`) sale sin dependencias nuevas:

```bash
# FFmpeg: cada badge existe solo en la ventana de su clip
drawtext=text='#5':x=48:y=1400:enable='between(t,0,7.2)':fontfile=Anton-Regular.ttf:borderw=8
# transición de 0,35 s entre clips (offset acumulado)
[0][1]xfade=transition=squeezev:duration=0.35:offset=6.85
# whoosh en cada frontera, desplazado en ms
[sfx]adelay=6850|6850[s]; [mix][s]amix=inputs=2
```

```
; ASS: igual, un evento por badge ({\an5} + fade + entrada)
Dialogue: 0,0:00:00.00,0:00:07.20,Rank5,,0,0,0,,{\an5\fad(200,200)\t(0,250,\fscx115\fscy115)}#5
```

Detalles que hay que resolver sí o sí en esta ruta:
- **Solape**: las transiciones consumen tiempo de los clips (B4). El `offset` acumulado tiene que ser
  una única función en `core/specs.py`, no una suma hecha a mano por etapa.
- **Determinismo**: animaciones por frames (`interpolate`/`spring`), nunca por tiempo de reloj.
- **Zoom del primer clip** (`first_clip_zoom: 1.08`): interpolación de escala en los primeros ~0,4 s.

### 20.2 Ruta B — Generar un borrador de CapCut / Jianying (editable a mano)

Existe y funciona, con matices importantes. Librerías verificadas en su README:

| Proyecto | Qué es | Estado |
| --- | --- | --- |
| **pyJianYingDraft** (GuanYixuan, PyPI) | Librería Python que **genera y exporta borradores de 剪映/Jianying**: video, imagen, audio, pistas, keyframes, máscaras, **transiciones**, **animaciones de texto**, borde/sombra de texto, importar `.srt`, y **modo plantilla** | La más completa. Su versión CapCut está en `pyCapCut` (en desarrollo) |
| **capcut-mate** | Servicio FastAPI de automatización de borradores | Alternativa "API" |
| **VectCutAPI / capcut-cli / capgenie** | Variantes: API, CLI, edición de JSON de proyecto | Menos maduras |

Cómo se vería para este producto (plantilla + rankings):

```python
# Pseudocódigo: plantilla de CapCut con slots de ranking
folder  = draft.DraftFolder("<JianyingPro Drafts>")
script  = folder.duplicate_as_template("plantilla_top5", "ranking_123")  # abre el borrador
for p, clip in enumerate(items):           # 5 posiciones
    script.replace_text(rank_track[p], 0, f"#{p}")            # conserva el formato/animation
    script.replace_material_by_seg(video_track[p], 0, clip)   # cambia el material, mantiene tiempo
script.save()
```

**Limitaciones que hay que conocer antes de diseñar sobre esto** (del README, no de suposiciones):

1. **Cifrado**: en Jianying nuevo, `draft_content.json` "a menudo no es JSON en texto plano legible";
   el modo plantilla exige un `fallback_loader` adicional. (Jianying 6.0+ cifra el borrador.)
2. **Exportación automatizada**: solo **Windows**, solo Jianying **≤ 6.8**; en 7+ los controles están
   ocultos y **no se puede**. Es automatización de UI (`uiautomation`), no una API: controla el ratón y
   pone la ventana al frente.
3. **Efectos/transiciones/fuentes no cacheadas**: el editor intenta descargarlas al abrir el borrador y
   puede fallar ("xx加载失败"); las fuentes no cacheadas exigen reabrir el proyecto.
4. **CapCut móvil**: sin API pública. Las plantillas de CapCut se aplican desde la app. No es un camino.

Conclusión: la ruta B **no** sirve como producción automática (Windows-only, versión-dependente, cifrado,
UI automation), pero sí como **conveniencia interna**: el operador abre el borrador ya montado y retoca
el clip difícil. Si se usa, que sea un artefacto extra del render, nunca el camino crítico.

### 20.3 Ruta C — OpenTimelineIO: el puente estándar

`OpenTimelineIO` (Academy Software Foundation) es el formato de intercambio de información de montaje
("un EDL moderno") con adaptadores hacia Resolve/Premiere/FCP y Blender. Para este producto es la forma
barata de cumplir "el operador puede abrirlo donde quiera" sin escribir un adaptador por editor:

```
spec.json  ──(core/specs.py)──►  timeline.otio  ──►  Resolve / Premiere / Kdenlive
                                    │
                                    └──►  ranking.mp4 (Remotion / FFmpeg)
```

Y además obliga a que el spec sea **agnóstico del renderer**, que es lo que hace posible cambiar de
renderer sin rehacer el pipeline.

### 20.4 Recomendación

1. **Ruta A como camino crítico** (Remotion), con el fallback ASS/`drawtext` documentado.
2. **`spec.json` versionado + exportación OTIO en el `manifest.json`** — coste casi cero, y es lo que
   permite el "plantilla por preset" del encargo 1.
3. **Ruta B (borrador de CapCut/Jianying) fuera del producto** (ADR-8): con «solo texto editable y render
   automático» no hay nada que retocar a mano, así que generar un borrador no aporta y añade riesgo
   (cifrado desde 6.0, export Windows-only y ≤ 6.8). Queda documentada solo como referencia técnica de §20.2.
4. La "plantilla" que pide el encargo 3 son las **plantillas de §9.2 convertidas en `presets/<nicho>/`**:
   eso resuelve a la vez la edición tipo CapCut y la generalización a otros tipos de vídeo.

---

## 21. Enmiendas concretas a la Parte I (checklist de edición)

| # | Sección | Edición |
| --- | --- | --- |
| 1 | §3, RF-5, §9.2 | Añadir `cold_open` y resolver la contradicción "mejor primero / mejor en #1" (B1) |
| 2 | §9.2 | `hold_s` → `enter_at` / `hold_s` / `exit_at` con semántica escrita (B4) |
| 3 | §9.3, `core/specs.py` | Duración total con solapes de transición; el criterio 30–58 s se mide sobre el total real |
| 4 | §4, §8, §9.2, §17.2 | `preset_id` + `presets/<nicho>/`; `humor_type` → `moment_type`; `species` → `entities` (B2) |
| 5 | ADR-4 | Reenunciar: visual-first, ASR opcional por preset (B3) |
| 6 | RF-3 | Puertas por preset, con `advisory` permitido; OCR para leer texto quemado (B2, B5) |
| 7 | §11 | Regla explícita para rótulos que son handle/canal (`rejected`) vs. subtítulo genérico (`repair`); decisión sobre stems de audio |
| 8 | §7.1 | Marcar los pesos como hipótesis; ablation por señal en M1; candidatos nuevos: embeddings CLIP/SigLIP |
| 9 | §10.1 | Medir tokens por frame en M0 antes de fijar el techo de 0,003 USD/clip |
| 10 | §13.1, L0 | El entregable de CI que promete §13.1 ya está en L0 |
| 11 | §13.2 | Escribir la guía de etiquetado ("qué es un clip") junto con el set (B7) |
| 12 | §12, L3 | La ruta crítica de L3 es **etiquetar** el set de 40 vídeos, y se **cosecha de los recortes manuales de L1** en vez de etiquetarse desde cero; ponerle presupuesto de horas |
| 13 | §10.5, §10.1 | Revisar contra la regla de repositorio público (B8) |
| 14 | §9, nuevo | Exportación OTIO + nota de la ruta CapCut con sus limitaciones (§20.2–20.3) |
| 15 | Encabezado, §12, §15 | Orden de prioridades por capas L0–L4 (prioridades 1–4 del operador) + ADR-7, con la tabla de equivalencia L↔M |
| 16 | Encabezado, ADR-8, §9.2, §9.5, RF-7, §20.4 | Superficie editable = solo texto (título + nombres de los puestos) y render 100 % automático: saca la ruta B del producto, añade §9.5 (encaje del texto) y `PATCH /renders/{id}/texts` |

---

## 22. Fuentes

- PySceneDetect — https://www.scenedetect.com/ · https://github.com/Breakthrough/PySceneDetect
- AUTOCaT (corte automático por escenas) — https://www.reddit.com/r/editors/comments/13j89sv/
- `video-scene-splitter` — https://github.com/Ayden51/video-scene-splitter
- Segmentación semántica de escenas (*shot grouping*, surveys) —
  https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/video_scene_extraction_grouping.pdf ·
  https://link.springer.com/article/10.1007/s10462-024-10742-1 ·
  https://dl.acm.org/doi/10.1145/3654669
- PaddleOCR para texto quemado en vídeo — https://github.com/PaddlePaddle/PaddleOCR
- pyJianYingDraft (borradores Jianying/CapCut) — https://github.com/GuanYixuan/pyJianYingDraft ·
  https://github.com/GuanYixuan/pyCapCut · https://pypi.org/project/pyjianyingdraft/
- capcut-mate (API) — https://github.com/Hommy-master/capcut-mate ·
  VectCutAPI — https://github.com/sun-guannan/VectCutAPI
- Esquema y cifrado de `draft_content.json` —
  https://gist.github.com/renezander030/80823f1d47081c312d2c1f9edd20dc22
- OpenTimelineIO — https://github.com/AcademySoftwareFoundation/OpenTimelineIO ·
  https://opentimelineio.readthedocs.io/en/latest/
- Twelve Labs (segmentación y highlights de vídeo; alternativa de pago al scoring propio) —
  https://www.twelvelabs.io/ · https://www.twelvelabs.io/blog/introducing-pegasus-1-5
- Productos del nicho (para estudiar formato y precio, no para copiar): RankClips —
  https://rankclips.com/en · Revid listicle — https://www.revid.ai/tools/ai-listicle-generator
