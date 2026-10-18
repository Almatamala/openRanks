# openRanks — RPD y plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — servicio de generación y publicación de shorts de ranking a partir de vídeo largo |
| **Estado** | **L1, L2 y el panel están construidos y verificados**; L3 (extractora) y L4 (integración y publicación) son lo pendiente |
| **Fecha** | 16-oct-2026 (documento vigente, reescrito en presente) |
| **Alcance** | RPD (qué y por qué) + plan de ejecución (cómo, en qué orden, con qué criterios de salida) |
| **Decisiones vigentes** | (1) **servicio nuevo**, con código de OpenShorts como referencia; (2) **interfaz única y cómoda** (ADR-9); (3) **estilo bloqueado y render automático** (ADR-8); (4) **montaje siempre de corte seco** (ADR-10); (5) **encuadre automático** por detección del área útil (ADR-11) |
| **Repo de referencia** | **OpenShorts** (repositorio vecino, no este): de él se copia/adapta código con licencia **MIT**, con cabecera de origen y NOTICE. Su directorio `cloud/` es licencia comercial y **no se copia** nunca |
| **Archivo único** | Este documento vive junto al código que describe, y sustituye a los borradores anteriores |

**Nomenclatura.** El servicio se llama `openRanks` (nombre anterior del borrador: *petrank*).
El nicho de mascotas es **el primer preset de estilo**, no el alcance del producto.

Este documento describe **lo que existe hoy** y lo que falta por capas. No conserva las
propuestas ya descartadas: por qué se eligieron las alternativas vigentes está en los ADR
(§15), y lo descartado se justifica ahí mismo en su fila.

---

## Orden de prioridades del producto

**Decisión del operador (13-oct-2026): se construye de atrás hacia delante, empezando por el
vídeo terminado.** El orden sigue vigente: `L1 → L2 → L3 → L4`.

| Prio | Capa | Qué entrega | Estado |
| --- | --- | --- | --- |
| **1** | **L1 · Ensamblador** | Los clips ya listos (normalizados, 9:16, 30 fps, audio a −14 LUFS) **y su unión en un solo vídeo vertical en corte seco** | **Hecho** |
| **2** | **L2 · Editor de la plantilla** | Sobre la unión, **toda la edición del estándar**: título, escalera de rangos, rótulo por puesto, medallas del podio, atenuado de lo que no tiene el turno. **Render automático y estilo bloqueado** | **Hecho** |
| **3** | **L3 · Extractora** | Los clips obtenidos solos desde un vídeo largo: segmentación, screening, scoring y selección — *el riesgo técnico real* | Pendiente |
| **4** | **L4 · Integrador** | Orquestación de punta a punta, publicación y operación | Pendiente (el panel ya cubre L1/L2) |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `clips/*.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `cover.jpg` + `spec.json`; L3 producirá **los
mismos `clips/*.mp4`** que el operador aporta a mano hoy. Consecuencia: **L2 y L3 no se
conocen entre sí** y L4 solo orquesta.

---

## Estado de implementación (16-oct-2026)

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
| CLI | `openranks/cli.py` | `assemble`, `render`, `preview`, `preset`, `probe`, `fit` |
| Panel | `web/` (Next.js) | Flujo completo sin terminal: subir, escribir, montar, ver, descargar |
| Plantilla guardable | `web/lib/preset.ts`, `openranks/core/overlay.py` | Preset editable y persistente que el motor lee por `OPENRANKS_PRESET_FILE` |
| Pruebas | `tests/` | Núcleo puro sin FFmpeg + integración real con FFmpeg |

**La interfaz es el punto de entrada único** (RF-9): no hay paso que exija terminal, `curl`
ni un editor externo. `GET /api/engine` responde «¿por qué no me monta?» sin abrir una
consola, y el panel no enseña rutas, ids internos ni JSON crudo.

### La regla dura del producto (ADR-8)

Del short terminado, **lo único editable es el texto**: el **título del vídeo** y el
**nombre de cada puesto**. Todo lo demás —layout, posiciones, tipografía, colores,
animaciones, duración y encuadre— vive en el **preset bloqueado** y no se toca por vídeo.
El **render es siempre automático**: no hay editor, ni timeline, ni exportación a mano.

Tres consecuencias que el código ya respeta:

1. La revisión se limita a **aprobar / rechazar / sustituir un clip / editar los dos textos**.
2. El texto es input libre de una persona, así que el renderer lo encaja solo (§9.5),
   con las mismas reglas al entrar (`core/binding.py`).
3. Cambiar un texto **no** recompone el vídeo: `openranks render` re-renderiza **solo la
   capa de overlay** sobre el `union.mp4` ya montado (segundos, no minutos).

### El montaje es siempre de corte seco (ADR-10)

Los clips se pegan uno tras otro, **sin transiciones ni zoom de entrada**. La unión se hace
por **copia de streams**, sin recodificar: es la ruta más rápida y la única que no gasta una
generación de compresión. Consecuencias:

1. La duración del ranking es la **suma exacta** de sus tramos: no hay solapes que descontar.
2. El CLI ya no expone `--transition-seconds` / `--transition` / `--zoom`, y el motor ya no
   construye `xfade`.
3. El panel no ofrece ajustes de montaje: monta con el preset y con el corte seco, y nada más.

### Cómo se ve el estado del trabajo en el panel

Cada trabajo publica su **fase con nombre humano** («Normalizando el clip #4 (2 de 5)»,
«Uniendo los 5 clips en vertical») y el **porcentaje medido** que emite el motor por stderr
(`openranks/core/progress.py`). El panel lo convierte en barra y en **tiempo restante** por
regla de tres sobre el tiempo ya empleado: no hay temporizador inventado.

### La plantilla de la edición

El panel enseña el preset **valor por valor**, con el archivo donde se cambia, y deja
ajustar y **guardar** una parte:

| Qué | Clave | Editable en el panel |
| --- | --- | --- |
| Fuente del overlay | `font` | Sí (lista blanca de familias) |
| Cursiva de todo el texto | `italic` | Sí |
| Tamaño del título | `title.size` | Sí |
| Fondo negro tras el título | `title.background` | Sí |
| Tamaño del número de cada puesto | `rank_ladder.size` | Sí |
| Posición horizontal de la escalera | `rank_ladder.x` | Sí |
| Altura del `#1` y del `#5` | `rank_ladder.y_top` / `y_bottom` | Sí |
| Colores, contornos, fundidos, medallas, rótulo | — | No: son de fábrica |

**El preset guardado persiste entre sesiones.** Se escribe en el directorio de trabajos
(`web/.jobs/preset.json` en local, `/data/jobs/preset.json` dentro del contenedor, que es un
volumen), se conserva **el último**, y el panel se lo pasa al motor por
`OPENRANKS_PRESET_FILE` **tanto en la vista previa como en el montaje**, así que lo que se ve
en el render de la plantilla es exactamente lo que llevará el vídeo. Al vivir en el volumen,
sobrevive a un reinicio del panel: la próxima sesión arranca con la plantilla guardada.
**Restablecer** vuelve a los valores de fábrica. Solo se aceptan las claves editables: un
archivo manipulado no puede colar otros ajustes.

### Fragmentos que interesa recordar

- El **overlay es ASS, no `drawtext`** (§9.3): libass resuelve la fuente por nombre (sin
  escapar rutas en la cadena de filtros) y permite cambiar el color del número dentro de una
  misma línea.
- El **audio de L2 se copia**: L1 ya lo normalizó y no se pierde esa medición.
- **Metadatos limpios**: `-map_metadata -1` en todo lo que se escribe, y el manifiesto guarda
  nombres de archivo y hashes, nunca rutas del host (regla de repositorio público).

---

## Cómo está organizado este documento

- **§1–§17**: RPD y plan de ejecución — requisitos, diseño, modelo de datos, render, legal,
  capas L0–L4, verificación, riesgos, decisiones registradas, preguntas abiertas y anexos.

Las referencias `§n` apuntan siempre a este documento.

---

# Parte I — RPD y plan de ejecución

## 1. Resumen ejecutivo

Construimos un servicio que, a partir de material de vídeo largo, produce un **short vertical
9:16 de tipo "TOP 5..10"**: momentos graciosos/locos/adorables, ordenados en ranking, con el
número de posición y un rótulo por puesto.

El valor no está en «cortar vídeo» —eso ya existe en el repo de referencia— sino en las
cuatro capacidades que el nicho exige y que hoy **no** existen en OpenShorts:

1. **Segmentación de compilados**: descubrir cuántos clips hay dentro de un vídeo largo y
   cortarlos individualmente (y reconocer cuándo la entrada *ya* es un clip único).
2. **Scoring de viralidad por clip, sin transcripción**. El pipeline de OpenShorts es
   *transcript-first* (`get_viral_clips`) con un fallback visual (`get_visual_clips`) que manda
   **el vídeo entero** a Gemini y, según la documentación del propio repo, *«nada guarda su
   longitud»*. El servicio nuevo lo hace **a base de frames muestreados**, lo que elimina el
   techo de longitud y el coste del vídeo completo.
3. **Selección de grupo**: elegir los N clips que maximizan el ranking bajo restricciones de
   diversidad (no dos del mismo vídeo fuente, no dos del mismo tipo de chiste, mezcla
   gato/perro).
4. **Render con overlay de ranking** y **puerta de revisión** antes de publicar.

Consecuencia arquitectónica: al no necesitar ASR, el servicio es **CPU-only en el camino
crítico** (no hay Whisper/faster-whisper, no hay `release_models()`, no hay contención de
VRAM). Eso reduce coste y complejidad de despliegue de forma sustancial.

**Hoy el producto ya entrega la mitad «de atrás»**: con los clips aportados a mano, el
servicio monta el vídeo y le pone la edición del estándar, todo desde el panel. Lo que falta
(L3 y L4) es la automatización de la entrada y la publicación.

---

## 2. Hallazgos del repo de referencia (base del diseño)

Verificado leyendo el código, no de memoria. Las filas marcadas **L3/L4** son las que se
copiarán cuando se construyan esas capas; las de L1/L2 se escribieron desde cero:

| Necesidad | Qué hay hoy en OpenShorts | Decisión |
| --- | --- | --- |
| Detección de cortes (L3) | `scene_detection.py` (PySceneDetect 0.7 + `_merge_short_scenes`) | **Copiar** y envolver con la lógica de agrupación propia |
| Detección de persona/objeto (L3) | `main.detect_person_yolo`, `yolov8n.pt`, `ultralytics` | **Copiar** y extender a clases `cat`/`dog` |
| Descarga de YouTube (L3) | `main.download_youtube_video`, `plan_download_attempts`, `cap_source_duration`, `yt_clients.py` | **Copiar** (MIT) y simplificar: sin ledger de proxy de pago en el MVP |
| Reencuadre vertical (L3) | `reframe_v2.py`, `layout_picker.py`, `split_layout.py` | **Copiar** el modo TRACK como camino por defecto |
| Codificación y metadatos | `ffmpeg_utils.py` (`video_encode_args`, `METADATA_SCRUB`, `QUALITY_FAST`) | **Patrón reproducido** en `openranks/core/ffmpeg.py` |
| Cliente Gemini + esquemas (L3) | `gemini_worker.py` (pydantic), `clip_selection.MODEL_PRICES` | **Copiar** el patrón: *schema-enforced JSON* + cálculo de coste |
| Cola de trabajos (L4) | `app.py`: `process_queue`, `asyncio.Semaphore`, subproceso por job | **Reimplementar** sobre Postgres (`FOR UPDATE SKIP LOCKED`) |
| Publicación social (L4) | `app.py` `/api/social/post`, `TIKTOK_POST_MODE` (MIT) y `cloud/social_profiles.py` (comercial, solo lectura de referencia) | **Adaptar** el patrón; reimplementar `social_profiles` sin copiar código de `cloud/` |
| Panel de operación | `dashboard/` (React + Vite) | **Propio**: `web/` (Next.js). El frontend de OpenShorts no aporta nada aquí (§10.5) |

### 2.1 Reglas duras del repo que el servicio hereda (o evita a propósito)

- **`get_visual_clips` no tiene guarda de longitud** (~300 tok/s; 1 h ≈ 1,08 M tokens > ventana
  de 1 M). En `openRanks` **no se manda vídeo a Gemini**: se mandan frames. Se acabó el problema.
- **La selección se hace donde las puntuaciones son comparables** (`clip_selection.score_batches`).
  Nuestro scoring replica la regla: **el LLM puntúa, el código decide**.
- **La cuota se aplica en código, no en el prompt** (`clip_count_targets`, `trim_to_best`,
  `dedupe_overlapping`). La selección de «exactamente N» es código puro, testeable sin FFmpeg.
- **Errores de política de contenido se propagan** (`GeminiBlockedError`), no se convierten en
  «no hay clips».
- **Sin secretos, hosts, métricas ni datos de cliente en el repo** (regla de repo público).

---

## 3. Formato del producto

Anatomía del short objetivo, según lo que **dicen** los dos vídeos de referencia
["How To Make VIRAL Ranking Videos"](https://www.youtube.com/watch?v=kOBED9yKees) y
["How to Make Monetizable Ranking Videos"](https://www.youtube.com/watch?v=hhTjwKwq8xs)
(sus transcripciones se obtuvieron y se leyeron: ver §17.4):

```
┌──────────────────────────────┐  1080 x 1920, 30 fps, 30-58 s
│ ╔══ TÍTULO (2 capas) ════════╗│  y = 96..240 — "TOP 5 GATOS 😹": dos capas para
│ ║ TOP 5 GATOS 😹              ║│  dar color propio al número ("5") más grande
│ ╚═════════════════════════════╝│
│ [5] ─────────────────────────│  ESCALERA DE RANGOS: x=176,
│ [4]   [ RÓTULO DEL CLIP ]    │  #5 abajo … #1 arriba (no un solo badge),
│ [3]                          │  la casilla de turno nítida y el resto atenuado
│ [2]        [ CLIP ]          │  clip 9:16 encuadrado
│ [1]                          │
└──────────────────────────────┘
```

Reglas de composición (cada regla, respaldada por lo que indican los tutoriales, salvo la
última, que es una decisión del operador):

- **Orden**: cuenta atrás `#5 → #1`, con el mejor clip en `#1`. El «arranque fuerte» de los
  tutoriales se consigue con un **cold open** (un adelanto del `#1` al principio): si se
  activa, el clip `#1` abre ~2 s **sin rótulo de posición** y luego cierra el vídeo completo.
- **Duración**: clips de 5–10 s + rótulos ⇒ **30–58 s** de vídeo unido.
- **Números de rango**: cinco capas de texto, una por posición, repartidas en vertical
  (**#5 abajo, #1 arriba**). Colores por posición: **#3 bronce, #2 plata, #1 oro**; **del 4 en
  adelante el número va en blanco** (el azul competía con el rótulo y se leía peor).
- **Rótulo por clip**: un título corto por clip, diseñado para **provocar comentarios**. Entra
  con su clip, **se queda hasta el final** (los textos se acumulan, no se sustituyen) y **se
  atenúa y difumina cuando su puesto cede el turno**, igual que su casilla.
- **Título global**: arriba, con el número destacado (dos capas: texto + número de otro color).
- **Legibilidad**: texto blanco con **stroke negro**, contorno grueso.
- **Encuadre**: un clip horizontal con un clip vertical centrado se recorta al **área nítida**
  y se rellena con negro; uno que ya es vertical no se recorta. La detección es automática y,
  si la confianza es baja, se prefiere **no recortar** (ADR-11).
- **Montaje**: **siempre corte seco** (ADR-10). El formato de referencia usa transiciones
  animadas con *swoosh* y *zoom-in* en el primero; el operador ha decidido no usarlas: el
  montaje va a cortes limpios y la capa transformativa se concentra en la edición del overlay.
- **Audio**: normalizado a **−14 LUFS**, pico −1 dBTP, medido con dos pasadas de `loudnorm`.
- **Cold open**: opcional, **desactivado por defecto** y disponible solo por CLI
  (`--cold-open-seconds`).

---

## 4. Alcance

### 4.1 Dentro del MVP

| # | Capacidad | Estado |
| --- | --- | --- |
| 1 | Ingesta de **archivo subido** (los clips que aporta el operador) | **Hecho** |
| 2 | Normalización: `ffprobe`, encuadre automático (recorte del área útil o relleno), 30 fps, audio a −14 LUFS | **Hecho** |
| 3 | **Unión en corte seco** en un solo vídeo vertical | **Hecho** |
| 4 | Edición del estándar sobre la unión (título, escalera, rótulos) | **Hecho** |
| 5 | **Plantilla editable y persistente** (fuente, cursiva, tamaño y posición) | **Hecho** |
| 6 | **Panel único** con progreso por fase, errores accionables y descargas | **Hecho** |
| 7 | Re-render de solo el overlay al cambiar textos | **Hecho** |
| 8 | Ingesta de **URL de YouTube** y de los N últimos de un canal | Pendiente (L3) |
| 9 | **Detección de compilado vs. clip único** con confianza, y **segmentación** | Pendiente (L3) |
| 10 | Screening determinista: mascota presente, sin watermark ajeno, sin split-screen, nitidez y duración válidas → **rechazo con motivo** | Pendiente (L3) |
| 11 | Scoring de viralidad 0–100 por clip (Gemini sobre frames) con **umbral configurable** | Pendiente (L3) |
| 12 | Agrupación en TOP N con restricciones de diversidad y orden de cuenta atrás | Pendiente (L3) |
| 13 | Revisión humana: aprobar / rechazar / **sustituir un clip** | Parcial: los textos sí, la sustitución no |
| 14 | Publicación a TikTok, IG Reels, YouTube Shorts (inmediata o programada) | Pendiente (L4) |
| 15 | Metro de coste por fuente, por clip y por render; trazabilidad de prompts y modelos | Pendiente (L3/L4) |

### 4.2 Fuera del MVP (v2+)

- Descarga de TikTok (la allowlist de URLs del repo rechaza todo lo que no sea YouTube).
- Voz en off / TTS, dubbing, traducción.
- Autopilot por canal con calendario y analítica cerrada (existe en `cloud/autopilot.py`, se
  portará después).
- Detección automática del «momento exacto» dentro de un clip ya cortado (reescritura de bordes).
- Generación de las fotos de referencia por IA (en el MVP son assets del operador).
- Multi-idioma de textos de overlay (MVP: un idioma configurable por proyecto).

### 4.3 No objetivos

- Ser un editor manual de vídeo. La revisión existe para aprobar, no para editar segundo a
  segundo.
- Garantizar monetización: es una decisión de la plataforma (ver §11).

---

## 5. Usuarios y flujos

**Usuario único del MVP: el operador de la cuenta de rankings** (una persona o un equipo
pequeño que trabaja varios compilados por día). No hay multiusuario ni facturación.

Flujo actual (lo que ya se puede hacer hoy, entero dentro del panel):

1. Sube los clips, uno por puesto, y elige cuántos puestos tiene el ranking (de 5 a 10).
2. Escribe el título y el nombre de cada puesto; el panel valida los límites antes de gastar
   un montaje.
3. Ajusta la plantilla si hace falta (menú lateral, con el render exacto sobre negro) y la
   guarda.
4. Monta: el panel muestra la fase y el tiempo restante.
5. Ve el `ranking.mp4` en 9:16 dentro del panel, la portada, y descarga cualquier artefacto.
6. Si cambia un texto, vuelve a montar la edición sobre el mismo vídeo (segundos).

Flujo completo objetivo (cuando lleguen L3 y L4): pegar una URL → el sistema segmenta, filtra
y puntúa → el operador crea el ranking → revisa y publica.

Historias de usuario (con criterio de aceptación resumido):

- **US-1** *Como operador quiero pegar una URL y recibir clips separados* → dado un compilado
  de 12 min con 24 clips, el sistema produce 20–28 segmentos, con fronteras a ±0,5 s de las
  reales, en ≤ 4 min. *(L3)*
- **US-2** *Como operador quiero que un clip ya cortado no se trocee* → dado un mp4 de 9 s de
  un solo gato, el sistema devuelve `kind=single_clip` con confianza ≥ 0,8 y **un** segmento
  que cubre el 100 % de la duración. *(L3)*
- **US-3** *Como operador quiero descartar automáticamente lo que no vale* → un clip con marca
  de agua de otro canal, o sin ninguna mascota, se marca `rejected` con motivo. *(L3)*
- **US-4** *Como operador quiero un TOP N coherente* → los N clips vienen de fuentes distintas,
  sin repetir el mismo tipo de chiste. *(L3)*
- **US-5** *Como operador quiero publicar sin salir del panel* → el render aprobado se publica
  en las 3 redes y queda registrado con su id remoto. *(L4)*
- **US-6** *Como operador quiero hacer todo desde un panel cómodo y no desde la terminal* → pego
  los clips, veo el avance de cada fase y descargo el resultado sin abrir otra herramienta; la
  UI nunca enseña JSON ni rutas, y cada error trae un botón para reintentar. *(RF-9, hecho)*

---

## 6. Requisitos funcionales

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
4. Los tramos se unen **en corte seco** (`#5 → #1`, con cold open opcional) por **copia de
   streams**, sin recodificar.
5. Salidas: un archivo por puesto (`clips/05-<nombre>.mp4` … `clips/01-<nombre>.mp4`),
   `union.mp4` y `manifest.json` con fuentes, hashes, formato y loudness medida.

**Criterio de aceptación** (verificado en `tests/test_assemble_e2e.py`): los seis archivos
validan con `ffprobe` (1080x1920, 30 fps, yuv420p, audio presente) y el unido cae en la banda
de 30–58 s; con 5 clips de 2 s, la unión da **300 fotogramas y 10,0 s exactos**.
El encuadre tiene su propia suite (`tests/test_framing.py`, `test_framing_args.py` y
`test_framing_e2e.py`): clasificación sin análisis, recorte de un clip sobre fondo borroso,
agua ajena ignorada, rotación y salida normalizada.

### RF-1 — Ingesta y detección de «ya está cortado» (L3) · *pendiente*

1. `POST /sources` acepta `{kind: youtube_url | upload, url?, file?}`. Para `youtube_url` se
   admite `?list=` de canal → se ingesta el vídeo pedido; `channel` → se listan los últimos N.
2. Descarga con `yt-dlp` con el plan de intentos del repo, `noplaylist` siempre, allowlist de
   URL y techo de duración `MAX_SOURCE_MINUTES` (defecto 45).
3. Se genera un **proxy de análisis**: 240p, 8 fps, audio 16 kHz mono. Todo el análisis trabaja
   sobre el proxy; el corte final siempre sobre el original.
4. Clasificación `compilation | single_clip` según §7.2, con `confidence` y `reasons[]`.
5. Se guarda la **metadata de engagement de la fuente** (`view_count`, `like_count`,
   `comment_count`, `upload_date`, `channel`): es un prior barato que sirve de desempate entre
   candidatos de score parecido. No sustituye al scoring visual.

**Criterio de aceptación**: sobre el set de evaluación (§13.2), precisión ≥ 0,9 y recall ≥ 0,9
en la clase `compilation`; ninguna entrada de ≤ 15 s se clasifica como compilado.

### RF-2 — Segmentación en clips individuales (L3) · *pendiente*

1. Cortes de plano con `scene_detection.detect_scenes` (motor seleccionable con `SCENE_ENGINE`;
   el servicio arranca con **`pyscenedetect`** por ser CPU-only).
2. Agrupación de planos en **clips candidatos** con las señales de §7.1
   (`core/segmentation.py`, stdlib-only).
3. Fronteras ajustadas al **primer frame válido** con margen de 120 ms antes / 200 ms después;
   nunca en negro.
4. Banda de duración: `MIN_SEGMENT_SECONDS=1.5`, `MAX_SEGMENT_SECONDS=45`.
5. Cada segmento guarda `separator`, `cohesion` 0–1 y `segmentation_confidence`.
6. Deduplicación interna: dos segmentos que solapan > 60 % del más corto se fusionan.

**Criterio de aceptación**: **F1 de fronteras a ±0,5 s ≥ 0,85** y recuento de segmentos dentro
de ±20 % del humano en ≥ 80 % de los vídeos.

### RF-3 — Screening determinista (L3) · *pendiente*

Antes de gastar una llamada a Gemini, cada segmento pasa por puertas baratas y **binarias**:

| Puerta | Cómo | Resultado |
| --- | --- | --- |
| Mascota presente | YOLO (`cat`/`dog`/`bird`/`small animals`) en ≥ 3 frames clave | sin mascota → `rejected:no_pet` |
| Marca de agua ajena | plantilla de logo cuasi-estática detectada en ≥ 70 % de los frames | `rejected:foreign_watermark` |
| Rótulo ajeno quemado | densidad de bordes/texto en banda superior/inferior en ≥ 60 % de frames | **reparar** si la banda ocupa ≤ 18 % del alto (`repair:mask_text`); rechazar si es mayor o tapa la acción |
| Split-screen | línea negra vertical central persistente | `rejected:split_screen` |
| Barras negras / pillarbox | borde negro persistente > 8 % del frame | `reframed` o rechazo si supera 25 % |
| Nitidez y luz | varianza del Laplaciano y media de luma | `rejected:blurry` / `rejected:too_dark` |
| Estático | ≥ 80 % de los frames casi idénticos | `rejected:static` |
| Duración | fuera de banda | `rejected:duration` |
| Duplicado global | pHash de 3 keyframes contra la librería | `rejected:duplicate` |

**Criterio de aceptación**: precisión ≥ 0,95 en los rechazos por `foreign_watermark`,
`burned_text`, `no_pet`; coste de la fase < 8 s por minuto de fuente en CPU.

### RF-4 — Scoring de viralidad por clip (L3) · *pendiente*

1. Por cada candidato que pasó el screening se extraen **8–12 frames** repartidos por el clip
   (150–1024 px, con el primero como frame de portada) + un resumen numérico de señales (§7.3).
2. **Una llamada a Gemini por lote de 6 clips** (patrón `_run_stage_split` del repo: la
   puntuación por lotes es comparable porque el prompt puntúa *todos* los elementos del lote
   contra la misma rúbrica).
3. Salida validada con pydantic: `score` (0–10), `verdict` (`keep|reject`), `humor_type` (lista
   cerrada), `species`, `payoff_second`, `why`, `hook` (≤ 10 palabras) y **`clip_label`**
   (≤ 4 palabras en pantalla, pensado para provocar comentarios).
4. Score final = `0.7 * llm + 0.3 * señales`, redondeado a 0–100. Umbral por defecto **70**,
   configurable por proyecto (`RANKING_SCORE_CUTOFF`).
5. Los clips por debajo del umbral pasan a `verdict=below_threshold` (recuperables, **no
   borrados**).
6. Se guarda `model`, `prompt_version`, `frames_sampled`, `tokens_in/out` y `cost_usd`.

**Criterio de aceptación**: Spearman ≥ 0,6 entre score y ranking humano en el set de
calibración de 120 clips; **coste medio ≤ 0,003 USD por clip puntuado**.

### RF-5 — Agrupación en TOP N (L3) · *pendiente*

1. Entradas: clips `keep` con score ≥ umbral, más, si faltan, los `below_threshold` en orden
   descendente hasta completar N (nunca se rellena con clips rechazados por RF-3).
2. Restricciones duras: como máximo 1 clip por vídeo fuente
   (`RANKING_MAX_PER_SOURCE=1`); como máximo 1 por `humor_type`; si el tema declara mezcla,
   al menos 1 de cada especie cuando existan candidatos.
3. Objetivo: maximizar `Σ score` con penalización de duplicidad visual. Búsqueda voraz +
   mejora por intercambio; determinista con semilla.
4. Orden `#N → #1` por score ascendente, con el mejor en `#1`.

**Criterio de aceptación**: nunca se generan dos items con el mismo `source_clip_id` o la misma
fuente; duración total dentro de 30–58 s en el 95 % de los rankings.

### RF-6 — Render del short (L2) · **hecho**

1. `openranks assemble --edit` encadena L1 y L2; `openranks render` rehace **solo** el overlay
   sobre un `union.mp4` ya montado.
2. El spec de la edición lo construye `core/specs.py` (puro, testeable): ventanas de tiempo de
   cada badge, escalera, rótulos, encaje del título y duración total.
3. La capa de overlay se dibuja con un script **ASS** sobre la unión, con el mismo encuadre y
   formato (1080x1920, 30 fps, yuv420p), `-map_metadata -1` y `+faststart`.
4. Artefactos: `ranking.mp4` (final), `cover.jpg` (fotograma con la escalera completa),
   `spec.json` (props exactas, reproducible) y el `manifest.json` de L1 ampliado con el bloque
   de L2 (trazabilidad: capa, preset, hashes, medidas y avisos).
5. **Watermark de marca** del operador: fuera del MVP; cuando entre, se aplica como último paso
   para que el archivo canónico quede limpio.

**Criterio de aceptación** (verificado en `tests/test_overlay_e2e.py`): el MP4 valida con
`ffprobe` (1080x1920, 30 fps, yuv420p, audio presente) y **el overlay dibuja de verdad** (se
comparan píxeles de la región del título contra la unión: si no hay cambio, el test falla); el
audio se copia, así que la duración y la medición de loudness no cambian.

### RF-7 — Revisión · *parcialmente hecho*

1. `GET /jobs/{id}` devuelve el estado, la fase, el avance, los artefactos y las últimas líneas
   del log. **(hecho)**
2. La aprobación sigue siendo puerta de publicación (RF-8.2): un render no aprobado no se
   publica. *(pendiente, con L4)*
3. **Superficie editable = solo texto (ADR-8)**: título y nombre de cada puesto. **No** existe
   endpoint para recortar, reordenar, cambiar la plantilla ni tocar el estilo. **(hecho)**
4. Un cambio de texto **no** obliga a recomponer el vídeo: se re-renderiza solo la capa de
   overlay sobre el `union.mp4` (segundos, no minutos). **(hecho)**
5. Sustituir un clip de un puesto conservando los otros y sin recodificar todo: **pendiente**.

### RF-8 — Publicación y resultado (L4) · *pendiente*

1. `POST /renders/{id}/publish` con `{platforms, title, description, schedule_at?, timezone?}` —
   modelo y flujo calcados de `/api/social/post` (multipart, `TIKTOK_POST_MODE`, descripción por
   plataforma).
2. Tick de confirmación explícito con las plataformas conectadas; nunca publicar por defecto.
3. Se guarda `publications` (id remoto, estado, payload, error) y `GET /publications` lista con
   estado.
4. `GET /analytics?render_id=` devuelve las métricas disponibles por Upload-Post (lectura, sin
   promesas que la API no dé).

### RF-9 — Interfaz de operación (un solo panel, cómodo y fácil de usar) · **hecho**

**El panel es la única superficie del producto.** El operador no usa terminal, ni `curl`, ni un
editor de vídeo, ni una segunda web: si una tarea del flujo de §5 no se puede cerrar desde el
panel, el entregable no está terminado. La UI es propia (`web/`, Next.js App Router).

1. **Un solo sitio.** El panel cubre el flujo de L1/L2 —clips, textos, plantilla, montaje,
   resultado y descargas— sin cambiar de herramienta.
2. **Mínimos pasos.** Iniciar un montaje = subir los clips + un botón. Ajustar la plantilla =
   arrastrar un control. Ningún paso obligatorio pide escribir un id, una ruta ni JSON.
3. **Estado y progreso siempre visibles.** Cada job muestra su **fase con nombre humano**
   («Preparando el clip #4 (2 de 5)», «Uniendo los 5 clips en vertical»), su avance medido y un
   **tiempo restante estimado**; nunca un spinner mudo.
4. **Errores accionables, en lenguaje humano.** Cada fallo se muestra como *qué pasó + qué
   hacer + botón de reintentar*. Prohibido en la UI: `stack traces`, rutas de fichero, ids
   internos, JSON crudo y códigos de error sin traducir.
5. **La plantilla se ajusta con el render de verdad.** El menú lateral enseña el preset como
   pantalla de móvil y lo dibuja **el motor** sobre fondo negro (no una imitación del navegador,
   que mentía con fuentes, trazos y medallas); los cambios se piden al terminar de mover el
   control, no en cada tirón.
6. **Los dos textos editables se editan en su sitio**, con contador de caracteres y validación
   en vivo antes de gastar un montaje (§9.5).
7. **Nada del trabajo en curso se pierde.** El panel persiste el título, los nombres y el número
   de puestos; el estado real vive en el servidor.
8. **Legibilidad y accesibilidad.** Contraste sobre fondo oscuro, controles etiquetados
   (no iconos mudos), `aria` en la barra de progreso y foco visible.
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

### 7.1 Señales de segmentación (`core/segmentation.py`, L3, stdlib + numpy) · *pendiente*

Fronteras candidatas = cortes de plano de `scene_detection.py`. Entre dos planos consecutivos
se calculan continuidades y **solo se abre un clip nuevo cuando hay un "reset"**, porque un
compilado de mascotas suele tener varios planos por clip (plano del perro + reacción del dueño
= *un* clip):

```
reset_score =
    0.35 * cambio_de_aspecto_o_barras      (letterbox/pillarbox distinto)
  + 0.25 * cambio_de_marca_agua            (aparece/desaparece logo)
  + 0.20 * discontinuidad_audio            (salto de loudness/spectral flux)
  + 0.15 * distancia_de_paleta             (histograma HSV, distancia χ²)
  + 0.05 * salto_de_resolución_o_ruido     (cambio de calidad/compresión)
  + 0.10 * silencio_o_negro_entre_planos   (≥ 250 ms de negro/silencio)
reset_score >= 0.45  → frontera de clip
```

Cohesión interna del candidato = media de `1 - reset_score` en sus fronteras interiores; se usa
para partir los candidatos demasiado largos por su frontera **más débil**.

**Aviso de calibración (obligatorio antes de confiar en los pesos):** son una **hipótesis sin
medir** y tienen un modo de fallo conocido — cuando el compilado está **re-codificado en un solo
formato** (mismo aspecto, sin marca de agua, un solo bitrate), las dos señales de más peso valen
**0 en todo el vídeo** y quedan 0,45 de señal útil, justo en el umbral. En L3, antes de tocar
los pesos: **ablation por señal** sobre el set etiquetado y añadir la señal que sí sobrevive,
como **embeddings de frame** (CLIP/SigLIP) cortando donde cae la similitud semántica.

### 7.2 Clasificador compilado vs. clip único (L3) · *pendiente*

```
score_compilado =
    0.30 * min(1, planos_distintos / 6)
  + 0.25 * min(1, duración / 240 s)
  + 0.20 * nº_de_resets_detectados_normalizado
  + 0.15 * diversidad_visual_global   (pHash de keyframes: 1 - similitud media)
  + 0.10 * heterogeneidad_de_formato  (¿más de un aspecto/bitrate/letterbox?)
```

`compilation` si `score ≥ 0.55`, `single_clip` si `≤ 0.35`, y entre ambos `ambiguous` → se trata
como compilado pero con `confidence` baja (el operador puede forzar con
`force_mode=single|compilation`). Un clip de ≤ 15 s con un solo plano nunca es compilado.

### 7.3 Señales de viralidad deterministas (`core/signals.py`, L3) · *pendiente*

`motion_energy`, `payoff` (pico seguido de cámara estable), `animal_ratio`, `face_ratio`
(señal negativa cuando > 0,7 y no hay mascota grande), `audio_peak`, `music_bed`, `text_bands`,
`static_ratio`, `sharpness`, `luma_mean`, `pHash[]`.

`llm_score` y estas señales se combinan en `core/scoring.py` (función pura, con pesos y umbral
como parámetros). El desglose se guarda para poder recalibrar sin volver a llamar a Gemini.

### 7.4 Rúbrica del prompt visual (una sola rúbrica, cerrada) · *pendiente*

El prompt pide, por clip: `score` entero 0–10, `verdict`, `humor_type` de lista cerrada
(`caida | susto | robo_de_comida | travesura | reaccion | baile | rescate | ternura |
caos_multiple | otro`), `species`, `payoff_second`, `why` (una frase), `hook` (≤ 10 palabras) y
`clip_label` (≤ 4 palabras). La rúbrica se pondera en el prompt (remate cómico 40 %, sorpresa
20 %, ternura 20 %, energía 10 %, legibilidad del primer segundo 10 %) y **no** se pide ninguna
medida ni una decisión abierta: el modelo puntúa, el código decide.

### 7.5 Arquitectura de componentes

Lo construido (L1 + L2 + panel) en un solo servicio:

```
                 ┌──────────────────┐
   operador ────►│  panel (Next.js) │  subir clips, textos, plantilla, ver, descargar
                 └────────┬─────────┘
                          │ proceso hijo (CLI)
                 ┌────────▼───────────────┐
                 │  motor (Python)        │  openranks assemble --edit
                 │  L1: medir→normalizar  │
                 │      →unir (corte seco)│
                 │  L2: overlay ASS       │
                 └────────┬───────────────┘
                          │ FFmpeg / libass
                 ┌────────▼─────────┐
                 │  trabajos en disco│  input/, clips/, union.mp4, ranking.mp4, manifiestos
                 └──────────────────┘
```

Cuando lleguen L3 y L4 se añaden los servicios del despliegue completo (Postgres para la cola y
el estado, MinIO para el almacenamiento objeto, worker de análisis y publicación):

- **Cola en Postgres** (`jobs` con `SELECT … FOR UPDATE SKIP LOCKED`), no Redis: menos piezas,
  transaccional con los datos, suficiente para ~50 fuentes/día.
- **Sin GPU en el camino crítico**: YOLOv8n en CPU, PySceneDetect en CPU, Gemini remoto.
- **Almacenamiento**: MinIO en compose para fuente original, proxy, segmentos y renders;
  retención configurable (fuentes 30 días, renders y manifiestos indefinido, proxies 7 días).

### 7.6 Esqueleto del repositorio (lo que existe hoy)

```
openranks/
  core/           config, binding, media, ffmpeg, framing, plan, runner, manifest, specs, overlay, progress
  assemble.py     orquestación de L1: medir → encuadrar → normalizar → unir → verificar → manifiesto
  framing.py      análisis de encuadre con FFmpeg (muestreo, refino, JSON)
  overlay.py      orquestación de L2: union.mp4 + manifiesto → ranking.mp4 + cover + spec
  cli.py          openranks assemble | render | preview | preset | probe | fit
web/              panel Next.js (App Router): API de trabajos, preset, vista previa y la UI
scripts/          clips sintéticos para probar a mano
tests/            núcleo puro (sin FFmpeg) + integración real
docs/rpd/         este documento
```

`core/` es **stdlib puro**: toda la lógica de decisión (plan, specs, encaje del título, preset y
geometría del encuadre) se testea en CI sin FFmpeg y sin red. El análisis de píxeles vive en
`framing.py` y se ejecuta en el ensamblador. Los comandos de FFmpeg se **construyen** en
`core/ffmpeg.py` y `core/overlay.py`, y se **ejecutan** en `assemble.py` / `overlay.py`.

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
contenedor manda el de apt). Cuando lleguen L3/L4 se añaden `postgres`, `minio`, `worker` y el
servicio de publicación, con el dimensionado por CPU y por rate limit de Gemini, no por VRAM.

---

## 8. Modelo de datos

**Hoy** el estado de un trabajo vive en disco, dentro del directorio de trabajos: `status.json`
(estado, fase, avance y resultado), `binding.json` (título y puestos), `input/` (los clips
subidos), `render/` (clips normalizados, `union.mp4`, `ranking.mp4`, `cover.jpg`, `spec.json`,
`manifest.json`) y `log.txt`.

**Con L3/L4** entra Postgres con el esquema mínimo siguiente:

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

assets(id, kind, name, key, tags text[], spec jsonb, created_at)

score_ledger(id, source_clip_id, kind, prompt_version, model, cost_usd, created_at)
```

Índices obligatorios: `source_clips(source_id, idx)`, `clip_scores(source_clip_id) WHERE
is_current`, `ranking_items(ranking_id, position)`, `jobs(state, created_at)`,
`publications(render_id)`.

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
Lo único que varía entre rankings es el **texto**: el título del vídeo y el nombre de cada
puesto. `Template` (layout, posiciones, colores, animaciones, duración) es **constante**;
`Binding` lleva **solo texto**.

El preset de fábrica vive en `openranks/core/overlay.py` (`DEFAULT_STYLE`) y los colores por
puesto en `openranks/core/specs.py` (`RANK_COLORS`). Lo que hay hoy:

| Tema | Cómo está |
| --- | --- |
| Fuente | `font` (por defecto `Arial`; en el contenedor manda `OPENRANKS_FONT`). Familias ofrecidas: `DejaVu Sans`, `Liberation Sans`, `DejaVu Serif`, `URW Gothic` (sans-serif **geométrica**) y `Symbola` (símbolos y medallas) |
| Cursiva | `italic`: itálica en todo el texto del overlay |
| Color del título | Base blanco con contorno negro; el **número** va en acento y mayor (§3). El operador marca **palabras** con `*amarillo*` y `_azul_`; las marcas no se dibujan |
| Fondo del título | Opcional (`title.background`): caja negra opaca detrás del título |
| Escalera | Cinco casillas fijas (o tantas como puestos); **🥇🥈🥉** en el podio (fuente monocroma `medal_font`) y el número en el resto; color por puesto (`RANK_COLORS`) |
| Turno | La casilla **activa** se ve nítida durante su clip; las demás **se atenúan y difuminan** (`dim_alpha`, `dim_blur`) |
| Rótulo | Va **al lado de su propia casilla** (misma altura, `clip_label.dx`); entra con su clip, se queda acumulado y se atenúa cuando su puesto cede el turno |
| Encaje del clip | `auto` por defecto (`OPENRANKS_FIT`): detecta el área útil y rellena con negro; `band`, `contain` y `cover` son elecciones explícitas |
| Preset editable | Una **parte** se ajusta y guarda desde el panel: `font`, `italic`, `title.size`, `title.background`, `rank_ladder.{size,x,y_top,y_bottom}` (`EDITABLE_SECTIONS` en `core/overlay.py`) |

**Sin CTA de cierre.** El estándar no dibuja ningún texto de «sígueme» al final: el vídeo
termina con la escalera completa y el rótulo del `#1`. La franja inferior queda libre para la
UI de la plataforma (§9.1).

**Todo ajuste se puede consultar sin leer el código**: `openranks preset` (o
`openranks preset --json`, que es lo que consume el panel) lista cada valor con **qué es y en
qué archivo se cambia**. El panel lo enseña en la tarjeta «Plantilla de la edición».

### 9.3 Cómo se dibuja el overlay (ASS sobre FFmpeg)

La edición se compone con un **script ASS** dibujado por **libass** encima del `union.mp4` de
L1, mediante el mismo motor que hace L1:

- **Un evento por elemento**: el título (con el número en su color inline), la casilla de cada
  puesto y el rótulo de cada puesto.
- **La escalera está completa desde el primer fotograma**: todas las casillas están puestas y
  lo que llega con cada clip es su **turno**; la activa se ve nítida (con un pulso al activarse)
  y el resto atenuadas y difuminadas.
- **Animaciones deterministas**: fundidos (`\fad`) y escalados (`\t`), relativos al tiempo de
  vídeo. El mismo texto + el mismo preset producen **el mismo MP4** en cada corrida.
- **El audio se copia** (`-c:a copy`): L1 ya lo dejó a −14 LUFS y no se pierde esa medición.
- **Vista previa = render real**: `openranks preview` y el panel aplican **el mismo
  `build_ass`** sobre una fuente negra generada por FFmpeg, así que lo que se ve es lo que
  saldrá en el vídeo. El script queda en `<salida>/work/overlay.ass` y se puede leer tal cual.

### 9.4 Salidas por render

| Artefacto | Especificación |
| --- | --- |
| `ranking.mp4` | 1080x1920, 30 fps, H.264 High, CRF 19, yuv420p, audio copiado, `+faststart`, ≤ 60 s |
| `cover.jpg` | fotograma con la escalera completa, 1080x1920 |
| `spec.json` | props exactas del render (reproducible) |
| `manifest.json` | ids y hashes de los tramos, scores, `prompt_version`, modelo, tokens, coste, duración, versión del motor y avisos |
| `clips/*.mp4` | un archivo normalizado y descargable por puesto |

### 9.5 Encaje del texto editable (obligatorio)

Con el estilo bloqueado y el render automático, el texto es el **único** punto por donde entra
input humano: el renderer no puede depender de que el operador escriba corto. Reglas
deterministas, aplicadas también en la validación de entrada:

| Regla | Valor por defecto |
| --- | --- |
| Título del vídeo | ≤ 28 caracteres por capa, 3 capas; envoltura a 2 líneas como máximo |
| Nombre de cada puesto | ≤ 4 palabras / 24 caracteres; 2 líneas como máximo |
| Reducción por encaje | *shrink-to-fit* acotado (hasta 0,8× del tamaño nominal); después, envoltura; después, truncado con elipsis |
| Zona segura | el texto nunca invade las safe areas de §9.1 ni la banda de la escalera |
| Prohibido | que un texto largo mueva posiciones, cambie la duración de un clip o altere el timing de los badges |

El spec guarda el texto **de entrada** y el renderer calcula el encaje en cada corrida
(determinista: `fit_title()` reparte en renglones y baja el tamaño hasta que cabe), de modo que
un mismo par texto + preset produce siempre el mismo MP4.

---

## 10. Requisitos no funcionales

### 10.1 Coste (estimación, se mide en L3)

Referencia de precios del repo (`clip_selection.MODEL_PRICES`), `gemini-3.1-flash-lite`:
**0,25 USD / 1M input**, **1,50 USD / 1M output**.

Supuestos por clip puntuado: 8 frames a ~600 tok + ~600 tok de prompt ≈ 5.400 tok input;
~250 tok output ⇒ `≈ 0,0017 USD/clip`. Un compilado de 20 min → ~40 candidatos →
**≈ 0,07 USD por fuente**, más ~0,02 USD de títulos y razonamientos ⇒ **≤ 0,10 USD por short**.

Presupuesto de aceptación: **≤ 0,30 USD por short publicado**, medido con los contadores reales
del SDK. **Antes de fijar el techo de 0,003 USD/clip hay que medir tokens por frame**: la
tokenización por mosaicos de Gemini no es lineal con el lado mayor y un frame grande puede
costar 2–4× lo estimado. Para *puntuar* no hace falta 1024 px: 512 px basta y reduce coste y
latencia (reservar 1024 px para el frame de portada) y conviene **context caching** del prompt
del sistema por proyecto.

### 10.2 Latencia y throughput

Objetivo de capacidad: **50 fuentes/día** con un worker de 4 vCPU; el límite real será el rate
limit de Gemini, no la CPU. Fase de análisis (L3) objetivo, sobre un compilado de 20 min:

| Fase | Objetivo |
| --- | --- |
| Descarga + proxy | ≤ 3 min |
| Segmentación + señales | ≤ 3 min |
| Screening | ≤ 1 min |
| Scoring (6 clips/llamada) | ≤ 1 min |

Y lo medido en L1 + L2 (el panel lo publica como ETA): normalizar 5 clips y unir en corte seco
es una copia de streams; el overlay recodifica una sola generación.

### 10.3 Fiabilidad

- Jobs reintentables con backoff exponencial y techo de intentos (`jobs.max_attempts = 3`);
  el estado de cada fase es idempotente (`content_hash` + `is_current`).
- Errores de política de contenido de Gemini se propagan con su motivo, no se silencian.
- Rate limit de Gemini: cola con backoff y degradación a «menos candidatos por corrida».
- Backups: `pg_dump` diario; MinIO con versión de objeto si el despliegue lo permite.

### 10.4 Seguridad y privacidad

- API key propia (header `X-API-Key`) para el panel; sin multiusuario en el MVP.
- Claves de Gemini/Upload-Post solo por entorno, nunca en BD ni en logs; `.env` fuera del repo.
- Los secretos no aparecen en `spec.json` ni en `manifest.json`.
- Logs con ids, nunca con URLs completas de contenido privado ni rutas del host. El panel
  tampoco sirve artefactos por ruta libre: solo entrega los que él mismo lista.

### 10.5 Huella de cómputo

Hechos comprobados leyendo el repo de referencia — su `docker-compose.yml`, sus Dockerfiles y
los imports de `app.py`:

- En OpenShorts **no hay un servicio «api» y otro «back»**: `docker-compose.yml` levanta
  `backend` (FastAPI + cola de jobs), `frontend` y `renderer`. «Correr solo api y back»
  equivale a correr solo el `backend`.
- **La GPU no la consume ningún contenedor por existir**: la consume el subproceso de job
  (`main.py`, el único `import torch` a nivel de módulo) y solo mientras hay trabajo.
- El mayor consumidor de VRAM es el ASR (`faster-whisper`), y el ASR es justo lo que este nicho
  **no** necesita (ADR-4).
- `frontend` en el stage `prod` es nginx sirviendo estáticos; en el compose local es un Vite dev
  server con HMR, el único consumidor prescindible de verdad y solo en local.
- `renderer`: Chromium headless + Remotion. CPU-intensivo durante un render, ~0 en reposo.

Consecuencias aplicadas a `openRanks`:

1. **No se reutiliza el frontend de OpenShorts.** El panel es propio (`web/`) y su modo dev es
   el único trozo prescindible del stack.
2. **No se reutiliza su imagen de GPU.** Sin ASR no hace falta `--build-arg GPU=1` (~2 GB de
   librerías CUDA), ni la puerta de 4,5 GB de VRAM, ni `torch` en el camino crítico.
3. **Puede convivir** con OpenShorts en la misma GPU de 6 GB: lo que ocupa es YOLOv8n +
   PySceneDetect, no un modelo de voz. Aun así, L1/L2 y el diseño de L3 son **CPU-only**.
4. **Apagar el frontend ahorra RAM y disco, no GPU.** Las palancas reales son: no transcribir,
   acotar la duración de fuente y no renderizar en paralelo.

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

## 11. Legal y cumplimiento (bloqueante, no opcional)

Este producto republica fragmentos de vídeo de terceros; ese es su riesgo principal.

1. **Solo fuentes con derechos**: canal propio, contenido con licencia explícita, CC-BY, o
   permiso escrito del creador. El sistema guarda `source.url` + autor para poder retirar
   contenido (proceso DMCA interno). Se desaconseja el scraping masivo de compilados ajenos:
   además del copyright, choca con las políticas de contenido reutilizado de las plataformas.
2. **Nunca** se recorta ni se tapa la marca de agua ajena para ocultar la autoría: las puertas de
   RF-3 **rechazan** el clip y el motivo queda registrado.
3. **Música**: solo pistas de bibliotecas con licencia comercial (o audio del propio creador con
   permiso). El compilado ajeno trae música con derechos: se **sustituye**.
4. **Crédito y divulgación**: campo de crédito al creador original en la descripción y
   declaración de contenido sintético/editado donde la plataforma lo exija.
5. **Descarga**: se respetan los términos de YouTube y los mecanismos del repo (cookies,
   clientes de yt-dlp, `noplaylist`, allowlist).
6. **Datos de terceros**: no se almacenan datos de usuarios finales; no se usa `cloud/`.
7. **Edición transformativa como requisito, no como estilo.** El motivo declarado de añadir
   rótulos propios, títulos y una edición encima es que el vídeo deje de ser una recopilación y
   pase a ser un producto editado. En el diseño eso se traduce en **nunca publicar un clip ajeno
   sin capa propia** (título, rótulo o escalera) y no permitir el modo «publicar el
   compilado tal cual».

**Puerta de salida L0**: checklist legal firmado por el operador sobre qué fuentes puede usar.
Sin esto no se publica nada, aunque el pipeline funcione.

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
| Salida doble | **un archivo descargable por puesto** + **un solo `union.mp4`** con audio a −14 LUFS |
| **Salida (criterio)** | `ffprobe` valida los archivos (1080x1920, 30 fps, yuv420p, audio presente) y el operador los descarga del panel |

### L2 — Entregable 2: la edición del estándar · **hecho**

| Entregable | Detalle |
| --- | --- |
| Plantilla = datos | `Template + Binding → spec.json`; **`Template` bloqueado** y `Binding` con **solo texto** (título + N nombres) |
| Overlays | escalera de posición con la casilla de turno nítida, rótulo por clip, medallas del podio |
| Renderer | **ASS + FFmpeg** (`libass`), el mismo motor que hace L1 (§9.3). Sin segundo runtime |
| Cover + verificaciones | `cover.jpg`, `spec.json`, `manifest.json` y determinismo (mismo spec ⇒ mismo MP4) |
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
  porcentaje y listado del preset. Son `tests/test_{binding,plan,specs,ffmpeg_args,media,
  manifest,config,overlay_args,progress,preset}.py`.
- **Integración** (FFmpeg de verdad sobre clips sintéticos, marcados `integration`):
  `test_assemble_e2e.py` comprueba el criterio de salida de L1 (300 fotogramas y 10,0 s con 5
  clips de 2 s, sin audio perdido) y `test_overlay_e2e.py` que `ranking.mp4` es 1080x1920/30
  fps/yuv420p con audio, que se escriben portada y spec **y que el overlay dibuja de verdad**
  (comparación de píxeles contra la unión). Se saltan si no hay FFmpeg.
- **Contrato con el panel**: hay tests que leen `web/lib/limits.ts` y `web/lib/preset.ts` para
  garantizar que el panel no ofrece lo que el motor rechaza (puestos y familias tipográficas).
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
4. Documentación actualizada (este RPD, ADR si cambió una decisión, runbook si cambió la operación).

---

## 14. Riesgos y mitigaciones

| # | Riesgo | Impacto | Mitigación |
| --- | --- | --- | --- |
| R1 | **Segmentación mala en compilados con cortes de plano internos** (fronteras mal puestas) | Alto: el short corta a mitad de chiste | Spike temprano de L3; set etiquetado **cosechado de los recortes manuales de L1**; banda de tolerancia ±0,5 s; revisión humana como red |
| R2 | **Derechos de autor / contenido reutilizado** | Muy alto: strikes, desmonetización, retirada | §11 completo; puertas que rechazan watermark ajeno; registro de fuente y autor; checklist legal |
| R3 | Gemini puntúa de forma inconsistente entre corridas | Medio: ranking inestable | Rúbrica cerrada, `prompt_version` persistida, temperatura baja, lote homogéneo, umbral calibrado con datos |
| R4 | Falsos rechazos del screening (se pierden buenos clips) | Medio | Precisión ≥ 0,95 como criterio, umbrales conservadores, todo rechazo recuperable por el operador |
| R5 | Rate limit / coste de Gemini | Medio | Lotes de 6, caché por `content_hash` del segmento, presupuesto por fuente, context caching del prompt |
| R6 | Música con derechos arrastrada del compilado | Medio | Sustitución por defecto por pista con licencia; `music_bed` detectado y registrado |
| R7 | Licencia: copiar código de OpenShorts | Bajo | Núcleo MIT, se copia con NOTICE y cabecera de origen; **nunca** `cloud/` |
| R8 | Render lento o no determinista | Bajo | Animaciones por tiempo de vídeo (ASS), sin reloj; unión sin recodificar; caché de tramos normalizados |
| R9 | La analítica de la plataforma no da retención | Bajo | No se promete; solo se leen las métricas que Upload-Post exponga |
| R10 | Dependencia de la API de terceros para publicar | Medio | Adaptador aislado (`publish.py`) con contrato propio; el render queda publicado manualmente si falla |

---

## 15. Decisiones registradas (ADR-lite)

| ADR | Decisión | Motivo |
| --- | --- | --- |
| ADR-1 | **Servicio nuevo**, no un modo dentro de OpenShorts. Código reutilizado con cabecera de origen y commit upstream anotado | El flujo es *visual-first* y *ranking-first*; forzarlo dentro del pipeline transcript-first mezclaría dos productos. Además: perfiles de ejecución incompatibles (GPU/ASR vs. CPU-only) y riesgo legal distinto (republicación de terceros) |
| ADR-1b | **No copiar y pegar a ciegas**: lo copiado entra como paso intermedio y el paquete compartido se extrae cuando se sabe qué helpers se usan de verdad | Copia pura = fork con divergencia silenciosa (yt-dlp y los detectores cambian); extraer antes de tiempo = abstraer código que quizá no se usa. Hasta hoy **no se ha copiado código**: L1 y L2 están escritas desde cero |
| ADR-2 | Cola en **Postgres** (`SKIP LOCKED`), sin Redis | Un solo motor de datos; suficiente para ~50 fuentes/día; transaccional con el estado de las fases |
| ADR-3 | Overlay **ASS sobre FFmpeg (`libass`)**, no Remotion ni `drawtext` | Un solo runtime (el mismo motor que hace L1) y sin assets: `drawtext` no permite cambiar el color dentro de una línea y Remotion añadía Node, Chromium y un servicio de render a un producto que ya renderiza con FFmpeg. La pieza que importa (el spec reproducible, §9.3) es la misma |
| ADR-4 | **Sin ASR**: servicio CPU-only | El nicho no tiene diálogo útil; elimina Whisper, VRAM y `release_models()` del camino crítico. Si un preset futuro necesita habla, el repo de referencia ya tiene el camino MIT (`get_viral_clips`) como puerta de escape |
| ADR-5 | **Frames, nunca vídeo completo a Gemini** | El repo documenta que `get_visual_clips` no tiene guarda de longitud (~1 M tok/hora); con frames el coste y el límite desaparecen |
| ADR-6 | El **LLM puntúa, el código decide** | Heredado de `clip_selection.score_batches`: la comparación y las cuotas se hacen donde son medibles |
| ADR-7 | **Construcción de atrás hacia delante por capas**: L1 → L2 → L3 → L4 | Decisión del operador: primero existe el producto terminado —formato y edición validados, algo publicable— y después se automatiza su entrada. Contrato entre capas = **archivos + manifiesto**, así L2 y L3 no se conocen. Invierte «el riesgo primero»: la extracción es la prio 3, con spike temprano y el set de evaluación cosechado de los recortes manuales de L1. El riesgo mayor (contenido ajeno sin capa propia, §11) lo cubren justamente L1/L2 |
| ADR-8 | **Render 100 % automático y superficie editable = solo texto**: título del vídeo + nombre de cada puesto | Decisión del operador. El estándar visual lo fija el preset y no el operador por vídeo, así que el resultado es reproducible y comparable entre rankings, el trabajo humano se reduce a elegir y revisar, y el render nunca espera a nadie. Obliga a reglas de encaje automático del texto (§9.5) |
| ADR-9 | **La interfaz es un requisito de producto, no un extra**: un **panel único** cubre el flujo de punta a punta, con progreso por fase, errores accionables, plantilla y textos en el mismo sitio | Decisión del operador: el producto debe ser cómodo y fácil de usar. El valor del servicio es ahorrar trabajo humano, y eso se pierde si el operador necesita terminal, `curl` o un editor. Convierte la usabilidad en criterio de aceptación medible (RF-9, §10.6) |
| ADR-10 | **El montaje es siempre de corte seco**: sin transiciones, sin *swoosh* y sin zoom de entrada. La unión se hace por **copia de streams** | Decisión del operador (16-oct-2026). El formato de referencia usa transiciones animadas, pero el corte limpio se ve igual de bien en este nicho, elimina una generación de recodificación en la unión, quita dos decisiones por vídeo del panel y deja la capa transformativa donde de verdad se ve: el overlay. Consecuencia en el código: fuera `xfade` y fuera el `zoompan` del primer clip |
| ADR-11 | **Encuadre automático**: el clip horizontal con un clip vertical centrado se recorta al **área nítida**; el vertical no se recorta. Si la confianza es baja, se rellena con negro sin recortar | Decisión del operador (18-oct-2026). Los clips de entrada llegan en los dos formatos y el operador no debe recortar a mano ni decidir por vídeo; el render sigue siendo automático (ADR-8). La detección usa 12 fotogramas a 192 px y un refino a resolución completa, así que no compite con la codificación. El caso de fallo (marca de agua en la zona borrosa) se resuelve ignorando islas nítidas aisladas y, si no hay confianza, no se recorta |

---

## 16. Preguntas abiertas

1. **Foto de referencia del banner**: ¿el operador la sube por ranking, o hay una biblioteca fija
   por temática y el sistema solo elige? El MVP asume una biblioteca propia en `assets/banners/`
   y el banner entra como parte del preset (no por vídeo).
2. **Idioma de los textos** (`clip_label`, título) y **tono**: el set de calibración debe
   etiquetarse en ese idioma.
3. **Volumen objetivo** (shorts/día) para dimensionar `WORKER_CONCURRENCY` y el presupuesto de
   Gemini.
4. **¿Se publica en la cuenta del propio operador únicamente?** (afecta a `TIKTOK_POST_MODE` y al
   flujo de perfiles de Upload-Post).
5. **Revisión**: ¿siempre humana antes de publicar, o modo «auto-publicar si score ≥ X»? El MVP
   exige revisión.
6. **Duración objetivo** del short (30–58 s por defecto): ¿se admite un formato «TOP 10» largo?
   (Sí: cambiando solo `n` en la selección y el número de puestos en el panel.)
7. **Voz en off**: una frase por clip con ElevenLabs. Es copy barato y la capa transformativa más
   fuerte frente al riesgo de contenido reutilizado (§11), pero añade una dependencia
   (ElevenLabs) y una decisión de idioma/voz. Recomendación: entrar como opción del preset, con
   `voiceover.enabled=false` por defecto.
8. **¿Se publica el mismo short en las tres redes con el mismo texto, o con copy por plataforma?**
   El repo guarda `video_description_for_tiktok` / `_instagram` / `video_title_for_youtube_short`.
9. **Generalización a otros temas**: el core debe servir para más tipos de vídeo (deporte, cocina)
   sin tocar `core/`. Hoy el nicho está en el prompt y en las puertas de RF-3, no en el esquema:
   cuando exista L3, la puerta de calidad es que **un segundo tema pase los criterios añadiendo
   solo su preset** (taxonomía de momentos, vocabulario de sujetos y umbrales), sin tocar código.

---

## 17. Anexos

### 17.1 Variables de entorno

| Variable | Defecto | Uso |
| --- | --- | --- |
| `OPENRANKS_ITEMS` | `5` | Puestos del ranking (de 5 a 10); el panel lo fija por trabajo |
| `OPENRANKS_WIDTH` / `OPENRANKS_HEIGHT` | `1080` / `1920` | Lienzo de salida |
| `OPENRANKS_FPS` | `30` | Fotogramas por segundo |
| `OPENRANKS_FIT` | `auto` | Encuadre del clip (`auto` \| `band` \| `contain` \| `cover`) |
| `OPENRANKS_CRF` / `OPENRANKS_PRESET` | `19` / `medium` | Calidad y preset de x264 |
| `OPENRANKS_LOUDNESS_LUFS` | `-14.0` | Objetivo de loudness |
| `OPENRANKS_MIN_CLIP_SECONDS` / `MAX_CLIP_SECONDS` | `1.0` / `30.0` | Banda por clip |
| `OPENRANKS_MIN_TOTAL_SECONDS` / `MAX_TOTAL_SECONDS` | `30.0` / `58.0` | Banda del vídeo unido |
| `OPENRANKS_FONT` | `Arial` (`DejaVu Sans` en el contenedor) | Familia del overlay (libass la resuelve por nombre) |
| `OPENRANKS_PRESET_FILE` | — | Plantilla guardada por el panel; se aplica sobre la de fábrica |
| `OPENRANKS_JOBS_DIR` | `web/.jobs/` | Directorio de trabajos (volumen en Docker) |
| `OPENRANKS_ROOT` / `OPENRANKS_PYTHON` | — / autodetectado | Dónde está el motor y con qué intérprete |
| `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` | — | Binarios de FFmpeg (si no, PATH o el de npm) |
| `DATABASE_URL`, `S3_ENDPOINT`, `GEMINI_API_KEY`, `UPLOAD_POST_API_KEY` | — | L3/L4: cola, almacenamiento, scoring y publicación |
| `MAX_SOURCE_MINUTES` | `45` | Techo de duración de fuente (L3) |
| `SCENE_ENGINE` | `pyscenedetect` | Motor de cortes (L3) |
| `SEGMENT_RESET_THRESHOLD` | `0.45` | Umbral de frontera (L3) |
| `RANKING_SCORE_CUTOFF` | `70` | Umbral de viralidad (L3) |
| `RANKING_MAX_PER_SOURCE` | `1` | Diversidad de fuentes (L3) |
| `SCORE_BATCH_CLIPS` | `6` | Clips por llamada a Gemini (L3) |

### 17.2 Prompt de scoring visual (esquema) · *L3*

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
  clip_label: <= 4 palabras, para la pantalla (provocar comentarios, no describir)

Reglas: puntúa TODOS los clips del lote contra la misma rúbrica (no elijas
"los mejores"); no describas el vídeo en general; penaliza clips donde no se
distingue la mascota o donde no hay remate visible; no devuelvas medidas.
```

### 17.3 Mapa de reuso (resumen ejecutable)

Las filas marcadas **ahora** están escritas desde cero; las de L3/L4 indican de qué archivo del
repo de referencia se copiarán (siempre MIT, con cabecera de origen y NOTICE).

| Paso | Módulo | Origen |
| --- | --- | --- |
| Configuración y contrato | `openranks/core/config.py`, `core/binding.py` | **Nuevo (ahora)** |
| Medición | `openranks/core/media.py` | **Nuevo (ahora)** |
| Codificación y unión | `openranks/core/ffmpeg.py` | **Nuevo (ahora)**; patrón de `ffmpeg_utils.py` |
| Plan del montaje | `openranks/core/plan.py` | **Nuevo (ahora)** |
| Overlay (spec + ASS) | `openranks/core/specs.py`, `core/overlay.py` | **Nuevo (ahora)**; posiciones de `hooks.py` como referencia |
| Plantilla guardable | `openranks/core/overlay.py`, `web/lib/preset.ts` | **Nuevo (ahora)** |
| Panel | `web/` | **Nuevo (ahora)**; `dashboard/src` como referencia de patrón |
| Progreso | `openranks/core/progress.py` | **Nuevo (ahora)** |
| Pruebas | `tests/` | **Nuevo (ahora)** |
| Ingesta de YouTube | `worker/stages/ingest.py` *(L3)* | `main.download_youtube_video`, `plan_download_attempts`, `yt_clients.py` |
| Segmentación | `core/segmentation.py` *(L3)* | `scene_detection.py` |
| Screening | `core/signals.py`, `worker/stages/screen.py` *(L3)* | `main.detect_person_yolo` (extendido a cat/dog), `yolov8n.pt` |
| Scoring | `core/scoring.py`, `worker/stages/score.py` *(L3)* | `gemini_worker.py` (esquemas, coste), `clip_selection.MODEL_PRICES` |
| Selección | `core/selection.py` *(L3)* | `clip_selection.{trim_to_best, dedupe_overlapping}` como inspiración |
| Publicación | `worker/stages/publish.py` *(L4)* | `app.py:/api/social/post`, `TIKTOK_POST_MODE` (patrón de `cloud/social_profiles.py`, reimplementado) |

### 17.4 Evidencia del formato: transcripciones de los vídeos de referencia

El formato de §3 y los tokens de §9.2 **no** se derivaron del título de los vídeos: se sacaron
leyendo sus transcripciones. No se puede ver vídeo desde aquí, pero sí su audio transcrito, que en
dos tutoriales es literalmente el procedimiento completo. Receta reproducible (temporal, fuera del
repo):

```bash
python -m venv /tmp/refvids/venv && /tmp/refvids/venv/bin/pip install yt-dlp
/tmp/refvids/venv/bin/yt-dlp --skip-download --write-auto-subs --sub-langs "en.*" \
  --sub-format vtt -o "%(id)s.%(ext)s" "https://www.youtube.com/watch?v=<ID>"
# limpiar el VTT (quitar timestamps y el rolling duplicado) -> texto plano
```

Qué confirmó, qué corrigió y qué se decidió al final:

| Punto | Antes (diseño inicial) | Según los tutoriales | Decisión vigente |
| --- | --- | --- | --- |
| Números de rango | Un badge que cambia de número | Cinco capas fijas en vertical, `#5` abajo → `#1` arriba | **Escalera**, `#5` abajo → `#1` arriba |
| Colores | Un solo color de acento | Oro `#1`, plata `#2`, bronce `#3`; acento para los bajos | **Oro/plata/bronce** y blanco del 4 en adelante |
| Título por clip | No contemplado | Sí, uno por clip, para provocar comentarios | **Rótulo por puesto**, al lado de su casilla |
| Rótulo ajeno quemado | Rechazar el clip | Taparlo con desenfoque + máscara | **Rechazar** si es autoría ajena; reparar solo rótulos genéricos (§11.2) |
| Transiciones | Corte seco | Transición animada entre todos + swoosh, y zoom-in en el primero | **Corte seco** (ADR-10): decisión del operador |
| Música | Parte del preset | Opcional: los tutoriales ni la mencionan | **Opcional** y desactivada por defecto |
| Selección de fuentes | Solo por contenido | También por views y comentarios del clip original | Se guarda como **prior de desempate** (RF-1.5) |
| Voz en off | v2 | Central en el tutorial «monetizable»: es la capa transformativa | **Pregunta abierta** (§16.7) |
| Riesgo de monetización | Riesgo legal en general | Motivo declarado de cada adorno: no parecer contenido reutilizado | **§11.7**: nunca publicar un clip ajeno sin capa propia |

Lo que estas transcripciones **no** pueden dar (y sigue pendiente): proporciones exactas,
tipografías reales y timing de las animaciones. Eso lo fija la foto de referencia + un frame real.
