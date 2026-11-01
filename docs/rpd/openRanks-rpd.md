# openRanks — RPD (requisitos del producto)

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **Fase 1 (L1, L2 y panel) construida y verificada.** **Fase 2 (galería y navegación) construida y probada**; solo queda el checklist E2E en el navegador. **Fase 3 (L3 · Extractora) diseñada, no construida** (§4.4, §5.5, RF-16 a RF-20) |
| **Fecha** | 28-oct-2026 |
| **Alcance** | **RPD**: qué es el producto, por qué, con qué reglas y con qué criterios de producto. El **plan de ejecución** (orden, entregables, estado y verificación) vive en `docs/plan/openRanks-plan.md` |
| **Documentos** | **RPD** (este) + **plan**. La numeración `§` es **compartida y estable**: §1–§11 y §14–§17 viven aquí; §12–§13 viven en el plan. Así las referencias del código no se mueven al separar los documentos |
| **Decisiones vigentes** | (1) **interfaz única y cómoda** (ADR-9); (2) **estilo bloqueado y render automático** (ADR-8); (3) **montaje siempre de corte seco** (ADR-10); (4) **encuadre automático** por detección del área útil (ADR-11); (5) **galería persistente y orden de selección = #1** (ADR-12, ADR-13); (6) **una categoría libre por clip** (ADR-14); (7) **borrado de usados explícito y confirmado** (ADR-15); (8) **generación automática aplazada hasta la Fase 3** (ADR-16, ADR-19); (9) **extractora con fuentes múltiples y derechos declarados** (ADR-17); (10) **escenas al estilo CapCut, con revisión humana** (ADR-18); (11) **score de viralidad 0-100 y el mejor clip al final (#1)** (ADR-19); (12) **score con Claude Haiku 5.5 y cliente intercambiable** (ADR-20) |

**Nomenclatura.** El servicio se llama `openRanks` (nombre anterior del borrador: *petrank*).
El nicho de mascotas es **el primer preset de estilo**, no el alcance del producto.

Este documento describe **lo que el producto hace hoy**, incluida la **Fase 2** ya implementada
en el panel, y **diseña la Fase 3 (L3 · Extractora) sin construirla**: sus requisitos (RF-16 a
RF-20) y sus criterios de aceptación quedan cerrados aquí, pero no hay código. Lo que sigue
siendo futuro se marca como tal; lo que aún no tiene diseño cerrado está en §16. La publicación
(L4) sigue **fuera del alcance** (§4.2).

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

**Fase 2 — galería y navegación (implementada).** El panel gana un menú lateral persistente con
**Montar ranking** y **Galería de videos**. La galería guarda los clips originales, les asigna
una categoría y permite filtrarlos; el operador selecciona entre 5 y 10 y el orden de selección
fija los puestos (#1 para el primero). **Generar manual** importa los clips al trabajo, los
prepara y abre el montaje con las casillas ya puestas. En el montaje, el borde izquierdo de
cada casilla permite reordenar por arrastre. Al terminar, **Borrar videos utilizados** elimina
de la galería los clips de ese ranking, con confirmación. **Generar automático** queda visible
y deshabilitado: su algoritmo no forma parte de esta fase.

Objetivos de la Fase 2:

1. **Reutilizar** los clips ya subidos sin volver a buscarlos ni subirlos.
2. **Reducir el montaje** a seleccionar, ordenar y pulsar «Generar manual».
3. **Corregir el orden** sin deshacer la selección ni volver a subir nada.
4. **Limpiar la galería** de lo publicado con una acción explícita y confirmada.
5. **Dejar preparada** la generación automática sin prometer un comportamiento que aún no
   existe.

**Fase 3 — extractora (diseñada, no construida).** El operador pega un enlace (YouTube, TikTok u
otra plataforma admitida) o elige un archivo local; openRanks detecta los cortes de escena y de
sonido, propone los tramos dentro de la banda del producto y el operador aprueba los que valen.
Cada clip entra en la **galería actual** con su procedencia, su categoría y un **score de
viralidad de 0 a 100**. Con esos scores la selección puede ser manual o automática (LLM), y el
orden sigue el criterio de retención: el vídeo **abre con el clip más flojo y cierra con el
mejor**, que ocupa el #1.

Las fases 1 y 2 son **CPU-only**: motor Python de stdlib pura y FFmpeg/libass, sin ASR ni modelos
locales. La Fase 3 añade **dos dependencias externas opcionales**: `yt-dlp` para la descarga y un
**LLM por API** para el score y la selección automática. Sin ellas, la extracción de archivos
locales y el score heurístico siguen funcionando.

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
- **Galería reutilizable (Fase 2)**: los clips se guardan una vez y se eligen para cada
  ranking. Al generar se **copian** al trabajo, así que borrar de la galería no rompe un
  montaje ya hecho ni un ranking ya descargado.
- **La extractora propone, el operador aprueba (Fase 3)**: la segmentación automática nunca
  publica un clip sin revisión; el sistema detecta y ordena por score, y el operador decide qué
  entra en la galería.
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

### 4.1 Dentro del alcance del producto

| # | Capacidad | Estado |
| --- | --- | --- |
| 1 | Ingesta de **archivo subido** (los clips que aporta el operador) | **Hecho** |
| 2 | Normalización: `ffprobe`, encuadre automático (recorte del área útil o relleno), 30 fps, audio a −14 LUFS | **Hecho** |
| 3 | **Preparación por puesto al subir** (tick) y **unión en corte seco al montar**, en un solo vídeo vertical | **Hecho** |
| 4 | Edición del estándar sobre la unión (título, subtítulo, escalera y rótulos) | **Hecho** |
| 5 | **Plantilla editable y persistente** (fuente, cursiva, tamaño y posición) | **Hecho** |
| 6 | **Panel único** con progreso por fase, errores accionables, descarga del ranking final y descarga opcional de la unión sin edición | **Hecho** |
| 7 | Re-render de solo el overlay al cambiar textos | **Hecho** |
| 8 | **Banner de referencia** y **música/sfx** con la cama a −14 LUFS | Pendiente de L2: requieren assets propios y van desactivados por defecto |
| 9 | **Galería persistente** de clips con categoría libre y filtro | **Hecho** |
| 10 | **Navegación lateral** entre «Montar ranking» y «Galería de videos» | **Hecho** |
| 11 | **Selección ordenada de 5 a 10** clips y **generación manual** del ranking | **Hecho** |
| 12 | **Reordenación por arrastrar y soltar** desde el borde izquierdo de cada casilla | **Hecho** |
| 13 | **Borrado de los videos utilizados** tras un render correcto, con confirmación | **Hecho** |
| 14 | **Generación automática** del ranking a partir de una selección | **Fase 3**: criterio definido en RF-19 (score 0-100 y el mejor clip al final); hoy el botón está visible y deshabilitado (ADR-16) |

### 4.2 Fuera del alcance actual

- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes, analítica y trazabilidad de coste.
- **v2+**: voz en off/TTS, autopilot por canal, reescritura de bordes de un clip ya cortado,
  generación de banners por IA, multi-idioma y A/B de estilos.

### 4.3 No objetivos

- Ser un editor manual de vídeo. La revisión existe para aprobar textos, no para editar segundo
  a segundo.
- Garantizar monetización: es una decisión de la plataforma (ver §11).

### 4.4 Fase 3 — L3 · Extractora (**diseñada, no construida**)

Diseño cerrado (ADR-17, ADR-18, ADR-19), sin código: no hay módulo de descarga, ni detector de
escenas, ni cliente de LLM en el repositorio.

| # | Capacidad | Estado |
| --- | --- | --- |
| 15 | **Ingesta multi-fuente**: enlace de YouTube, TikTok u otra plataforma admitida, o archivo local; descarga con `yt-dlp` | Diseñada (RF-16) |
| 16 | **Segmentación en escenas** por cambio de imagen y de sonido, filtrada a la banda 1-30 s y revisada por el operador | Diseñada (RF-17) |
| 17 | **Score de viralidad 0-100** visible en cada clip, con razones: heurístico y, opcionalmente, LLM | Diseñada (RF-18) |
| 18 | **Selección manual o automática** de 5 a 10 puestos y **orden con el mejor clip al final (#1)** | Diseñada (RF-19) |
| 19 | **Aterrizaje en la galería actual** con categoría, procedencia y score; reutiliza selección, generación y borrado de la Fase 2 | Diseñada (RF-20) |

---

## 5. Usuarios y flujos

**Usuario único del MVP: el operador de la cuenta de rankings** (una persona o un equipo
pequeño que trabaja varios rankings por día). No hay multiusuario ni facturación.

### 5.1 Flujo de la Fase 1 (montaje directo)

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
5. Ve el `ranking.mp4` en 9:16 dentro del panel y lo descarga: es el **entregable principal**.
   Opcionalmente puede descargar la **unión sin edición** (`union.mp4`) desde el mismo bloque de
   resultado, sin overlay ni textos.
6. Si cambia un texto, vuelve a montar la edición sobre el mismo vídeo (segundos).

Historias de usuario:

- **US-1** *Como operador quiero hacer todo desde un panel cómodo y no desde la terminal* → pego
  los clips, veo el avance de cada fase y descargo el resultado sin abrir otra herramienta; la
  UI nunca enseña JSON ni rutas, y cada error trae un botón para reintentar. *(RF-9, hecho)*
- **US-2** *Como operador quiero corregir un título sin volver a montar* → el cambio re-renderiza
  solo el overlay sobre el `union.mp4` y tarda segundos. *(RF-7, hecho)*
- **US-3** *Como operador quiero que el encuadre no me obligue a recortar a mano* → el clip
  horizontal se ajusta al área útil y el vertical se escala sin recortar. *(ADR-11, hecho)*

### 5.2 Flujo de la Fase 2 (extremo a extremo)

1. El operador abre **Galería de videos** desde el menú lateral izquierdo.
2. Sube los clips originales y les asigna una categoría. La subida **no** normaliza ni prepara
   el clip: la galería guarda el original.
3. Filtra por categoría si quiere y **selecciona** los clips en el orden del ranking. El
   primero seleccionado recibe el **#1** (el mejor, cierra el vídeo), el segundo el #2, etc. Al
   llegar a **10** no se puede seleccionar ningún clip más; con menos de **5**, «Generar
   manual» está deshabilitado y la interfaz indica cuántos faltan.
4. Con **5 a 10** seleccionados, pulsa **Generar manual**. «Generar automático» está visible
   pero deshabilitado («próximamente»).
5. Si hay un montaje en curso sin descargar, el panel pide **confirmación antes de reemplazar
   las casillas**. Si el operador cancela, vuelve a la galería sin cambiar nada.
6. Al confirmar, el panel **reutiliza el trabajo actual** (o crea uno si no hay), fija sus
   puestos al tamaño de la selección, **copia** los clips elegidos a su `input/`, los prepara
   por puesto y navega a **Montar ranking** con las casillas ya puestas, en el orden de
   selección. Cada casilla muestra su tick cuando su clip está preparado.
7. En el montaje, el operador puede **reordenar** arrastrando el **borde izquierdo** de una
   casilla hacia arriba o abajo. Los números de puesto se actualizan y la unión/edición
   anteriores dejan de valer, pero el intercambio **no recodifica los clips**: mueve sus
   preparados con ellos y los ticks siguen encendidos. La unión y la edición se rehacen al
   pulsar «Montar».
8. Escribe título, subtítulo y nombres, pulsa **Montar** y revisa el resultado; cuando termina,
   descarga el `ranking.mp4`.
9. Junto a **Descargar** aparece **Borrar videos utilizados**. Al pulsarlo se abre una
   **confirmación**. Si acepta, se eliminan de la galería y del disco los clips usados en ese
   ranking y se limpian las casillas; el `ranking.mp4` ya generado **no se toca**. Si cancela,
   no cambia nada.

### 5.3 Historias de usuario de la Fase 2

- **US-4** *Como operador quiero reutilizar clips que ya subí* → la galería los conserva entre
  sesiones, con su categoría, y puedo filtrarlos sin volver a subirlos. *(RF-11)*
- **US-5** *Como operador quiero elegir el orden del ranking con un clic* → la selección asigna
  #1, #2, #3… en orden; el contador y el límite de 10 me dicen si puedo generar. *(RF-12)*
- **US-6** *Como operador quiero corregir el orden sin volver a elegir los clips* → arrastro el
  borde izquierdo de una casilla y los puestos se renumeran. *(RF-13)*
- **US-7** *Como operador quiero limpiar la galería de lo que ya publiqué* → tras descargar,
  «Borrar videos utilizados» elimina solo esos clips, con confirmación. *(RF-14)*
- **US-8** *Como operador quiero saber que la generación automática existirá* → el botón está
  visible, deshabilitado y explica «próximamente», sin prometer un comportamiento que aún no
  existe. *(RF-15)*

### 5.4 Casos borde y reglas de la Fase 2

| Caso | Comportamiento definido |
| --- | --- |
| Menos de 5 seleccionados | «Generar manual» deshabilitado; el contador indica «faltan N». No se crea ni se modifica ningún trabajo. |
| Ya hay 10 seleccionados | Las tarjetas no seleccionadas quedan deshabilitadas y se explica el máximo; para cambiar hay que deseleccionar una. |
| Deseleccionar un puesto intermedio | Los siguientes se renumeran de forma consecutiva (#1, #2, #3…); el montaje en curso no cambia hasta volver a pulsar «Generar manual». |
| Generar con un montaje en curso | Se pide confirmación antes de reemplazar las casillas; cancelar no altera el montaje ni la selección. |
| Cerrar la app antes de borrar | La galería, el trabajo y el `ranking.mp4` persisten en disco. Al volver, el botón de borrado sigue disponible para ese ranking. |
| Cancelar el borrado | No se elimina ningún archivo ni se limpia ninguna casilla. |
| Borrar el último clip de una categoría | La categoría desaparece del filtro y del autocompletado; no existe una entidad de categoría aparte que mantener. |
| Un clip usado en dos rankings | «Borrar usados» lo quita de la galería; el otro trabajo conserva su copia y su ranking. |
| Reordenar después de montar | Los puestos se intercambian. El clip ya preparado se mueve con su puesto (no se vuelve a normalizar y el tick sigue encendido); solo la unión/edición se invalidan y se rehacen al pulsar «Montar». |
| Cambiar la categoría con un filtro activo | El clip sigue seleccionado aunque deje de coincidir con el filtro; el contador incluye la selección oculta. |
| Fallo al importar o preparar | El trabajo muestra el error con acción de reintentar; no se borra nada de la galería y la selección se conserva. |
| Clip sin categoría | Se agrupa como «Sin categoría» y se puede etiquetar después. |

### 5.5 Flujo de la Fase 3 (L3 · Extractora) — diseñado, no activo

1. El operador abre **Extraer clips** (sección nueva del menú lateral, junto a «Montar ranking» y
   «Galería de videos»), pega el enlace del compilado (YouTube, TikTok u otra plataforma
   admitida) o elige un archivo local.
2. Declara la **procedencia y los derechos** del material (canal propio, licencia, CC-BY o permiso
   escrito). Sin esa declaración el botón de extraer está deshabilitado: es §11.7.
3. Pulsa **Extraer**. El panel descarga el vídeo con `yt-dlp` (progreso por fase, cancelable) y lo
   analiza **sin recodificar**: cortes de escena y de movimiento, silencios y negros.
4. openRanks propone los **tramos candidatos** dentro de la banda de 1-30 s, con miniatura,
   duración y score. Los tramos demasiado cortos se fusionan con el vecino; los demasiado largos
   se parten.
5. El operador **aprueba o descarta** candidatos en una parrilla. Aprobar un candidato crea su clip
   en la **galería actual**, con procedencia, categoría y score; descartarlo no deja nada.
6. Con los clips en la galería, el flujo es el de la Fase 2: seleccionar 5-10 y **Generar manual**,
   o dejar que **Generar automático** elija y ordene por score (RF-19).
7. El orden de reproducción es ascendente en score: **el vídeo abre con el clip más flojo y cierra
   con el mejor**, que ocupa el #1.

---

## 6. Requisitos funcionales

Se conservan los identificadores **RF-0, RF-6, RF-7 y RF-9** para no romper las referencias
del código. La Fase 2 añade **RF-10 a RF-15**; RF-15 no está activo. La Fase 3 añade **RF-16 a
RF-20**: están definidos y sus criterios de aceptación son medibles, pero **ninguno está activo**
hasta que se construya esa capa. Los requisitos de las capas fuera de alcance siguen sin estar
activos.

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
4. Artefactos: `ranking.mp4` (final, **entregable principal**), `union.mp4` (unión sin edición,
   descarga opcional), `spec.json` (props exactas, reproducible) y el `manifest.json` de L1
   ampliado con el bloque de L2 (capa, preset, hashes, medidas y avisos).

**Criterio de aceptación** (verificado en `tests/test_overlay_e2e.py`): el MP4 valida con
`ffprobe` (1080x1920, 30 fps, yuv420p, audio presente) y **el overlay dibuja de verdad** (se
comparan píxeles de la región del título contra la unión: si no hay cambio, el test falla); el
audio se copia, así que la duración y la medición de loudness no cambian.

### RF-7 — Textos y revisión · **hecho**

1. `GET /jobs/{id}` devuelve el estado, la fase, el avance, el ETA, los artefactos y las últimas
   líneas del log.
2. **Superficie editable = solo texto (ADR-8)**: título, subtítulo opcional y nombre de cada
   puesto. **No** existe endpoint para recortar, cambiar la plantilla ni tocar el estilo. La
   única excepción es el **orden de los puestos** (RF-13): es una decisión de montaje, no una
   propiedad visual del preset.
3. Un cambio de texto **no** obliga a recomponer el vídeo: se re-renderiza solo la capa de
   overlay sobre el `union.mp4` (segundos, no minutos).
4. Sustituir el clip de un puesto conserva los otros: el tick de ese puesto se apaga, su unión y
   su edición se invalidan y se rehacen al volver a montar.
5. El panel ofrece **Guardar** junto al título y el subtítulo: persiste el texto actual en
   el navegador y en el servidor (`text.json`) y recupera ese respaldo si el navegador
   pierde el borrador local.

### RF-9 — Interfaz de operación (un solo panel, cómodo y fácil de usar) · **hecho**

**El panel es la única superficie del producto.** El operador no usa terminal, ni `curl`, ni un
editor de vídeo, ni una segunda web: si una tarea del flujo de §5 no se puede cerrar desde el
panel, el entregable no está terminado. La UI es propia (`web/`, Next.js App Router).

1. **Un solo sitio.** El panel cubre el flujo de L1/L2 —clips (que se preparan solos al entrar),
   textos, plantilla, montaje, resultado y la descarga del ranking (y, opcionalmente, de la
   unión sin edición)— sin cambiar de herramienta.
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
   nombres y el número de puestos; el estado real vive en el servidor. El título y el
   subtítulo tienen además un botón **Guardar** a su derecha, que confirma el texto actual
   en el navegador y en el servidor.
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

### RF-10 — Navegación lateral · **Fase 2**

1. El panel tiene un **menú lateral izquierdo persistente** con dos secciones: **Montar
   ranking** (vista principal) y **Galería de videos** (nueva). No es el cajón de la plantilla
   de RF-9.5: aquel sigue siendo el panel de ajustes; este es la navegación principal. El menú
   puede **retraerse** a una barra estrecha con un control etiquetado para volver a abrirlo,
   de modo que deje todo el ancho al contenido cuando el operador no lo necesita.
2. La sección activa está marcada de forma visible y con `aria-current`; cada entrada es
   alcanzable con un clic desde cualquier vista.
3. Cambiar de sección **no pierde trabajo**: la selección de la galería y el montaje en curso se
   conservan; al volver a Montar, el estado se reconstruye desde el servidor como hoy.
4. En pantallas estrechas el menú se pliega en un control etiquetado (nunca iconos mudos) y
   sigue permitiendo las dos secciones.
5. La navegación no introduce rutas técnicas ni ids en la URL visible para el operador.

**Criterio de aceptación.** Con el menú desplegado, las dos secciones se alcanzan en un clic;
la activa está marcada, un montaje en marcha sigue vivo al ir a la galería y volver, y el menú
funciona con teclado y con lector de pantalla.

### RF-11 — Galería de clips y categorías · **Fase 2**

1. **Repositorio persistente.** La galería guarda los clips originales en el directorio de
   trabajos (`library/` + `library.json`) y sobrevive a reinicios y a cerrar el navegador. No
   normaliza ni prepara nada al subir.
2. **Subida.** Acepta los mismos formatos y límite de tamaño que la subida actual (mp4, mov,
   mkv, webm, m4v, avi; hasta 2 GB por archivo) y valida tipo y tamaño antes de aceptarlo. El
   contrato completo del clip (duración, lado corto, códec) se valida al generar el ranking,
   porque la galería no prepara nada al subir.
3. **Categoría.** Cada clip tiene **una** categoría de **texto libre**; se crea al escribirla,
   se edita en la propia tarjeta y se sugiere con autocompletado a partir de las existentes. Se
   recorta el espacio sobrante y se comparan sin distinguir mayúsculas; vacío = «Sin
   categoría». No hay pantalla de administración de categorías.
4. **Filtro.** Un control permite ver «Todas» o una categoría concreta. Filtrar no borra la
   selección: un clip seleccionado que deja de coincidir con el filtro sigue contando y se
   indica en el contador.
5. **Tarjeta de clip.** Muestra nombre original, categoría, duración y estado de selección; los
   datos visibles nunca incluyen rutas del host ni ids internos.
6. **Reutilización.** Un mismo clip puede usarse en varios rankings; seleccionarlo no lo
   consume ni lo bloquea.
7. **Borrado individual** de un clip de la galería queda como decisión pendiente (§16); en esta
   fase el único borrado definido es el de «Borrar videos utilizados» (RF-14).

**Criterio de aceptación.** Un clip subido aparece tras recargar la página, conserva su
categoría, se filtra por ella y desaparece del filtro cuando se borra el último clip de esa
categoría. La API y la UI no exponen rutas ni ids internos.

### RF-12 — Selección ordenada y generación manual · **Fase 2**

1. **Seleccionar/deseleccionar** un clip con un clic. El **orden de selección** asigna los
   puestos de forma consecutiva: el primero seleccionado es el **#1** (el mejor, cierra el
   vídeo), el segundo el #2, etc. Deseleccionar un puesto intermedio **renumera** los
   siguientes sin huecos.
2. **Límites.** Mínimo **5** y máximo **10** clips. Con menos de 5, «Generar manual» está
   deshabilitado y se indica cuántos faltan; al llegar a 10, las tarjetas no seleccionadas se
   deshabilitan y se explica el máximo.
3. **Generar manual** solo está activo con 5 a 10 seleccionados. Al pulsarlo:
   - si hay un montaje en curso sin descargar, se pide **confirmación** antes de reemplazar;
   - se **reutiliza el trabajo actual** (o se crea uno si no hay), se fijan sus puestos al tamaño
     de la selección, se reemplazan sus casillas y sus archivos `input/`/`render/` anteriores, se
     **copian** los originales a `input/`, se prepara cada puesto (el tick de siempre) y se navega
     a **Montar ranking** con las casillas puestas en el orden de selección;
   - el motor no cambia: sigue usando `prepare` → `join` → `render`.
4. Si el operador cancela la confirmación, no se crea ni se modifica ningún trabajo y la
   selección se conserva.
5. La selección vive en la sesión del panel mientras no se genera; al recargar antes de generar
   se pierde, pero los clips siguen en la galería (persistirla es una decisión pendiente,
   §16.9). Una vez generado, el orden queda en el trabajo.
6. **Generar automático** está visible pero **deshabilitado** con la etiqueta «Próximamente»
   (RF-15); no se puede activar ni ejecutar.
7. **El selector de puestos sigue activo después de generar.** Aumentar el tamaño añade
   casillas vacías, que se rellenan subiendo clips; reducirlo deja fuera los puestos
   sobrantes. Los clips que se conservan no se preparan otra vez.

**Criterio de aceptación.** Con 4 seleccionados el botón está deshabilitado; con 5 se generan
exactamente 5 casillas en el orden elegido y cada una enciende su tick; con 10 no se puede
seleccionar el 11.º; cancelar la confirmación deja intacto el montaje anterior. En un montaje
creado desde la galería, el selector de la Fase 1 **sigue activo**: al ampliar aparecen casillas
vacías y al reducir se dejan de usar las sobrantes.

### RF-13 — Reordenación por arrastrar y soltar · **Fase 2**

1. El **control de arrastre es el borde izquierdo** de cada casilla de puesto; el resto de la
   casilla no inicia el arrastre.
2. Se arrastra **hacia arriba o abajo** y se suelta sobre otra casilla: ambos puestos se
   **intercambian** y los números se actualizan automáticamente.
3. Funciona con ratón, puntero táctil y teclado: el asa es enfocable, tiene etiqueta accesible y
   las flechas arriba/abajo realizan el mismo intercambio.
4. Reordenar **invalida la unión y la edición** anteriores, que se rehacen al pulsar
   «Montar». El intercambio **no vuelve a preparar ni recodificar los clips**: mueve
   `prepared/NN.mp4` y su JSON con el clip, así que los ticks siguen encendidos. Si un
   puesto todavía no estaba preparado, ese caso aislado se prepara después del intercambio.
5. El orden resultante es el que usan `join` y `render`: `#N → … → #1`, con el #1 al final.
6. No se puede arrastrar fuera de la lista ni cambiar el número de puestos desde el asa.

**Criterio de aceptación.** Arrastrar el #5 sobre el #1 intercambia ambos, actualiza los
números y el vídeo resultante reproduce el nuevo orden; la unión y el ranking anteriores dejan
de estar disponibles; el mismo intercambio se puede hacer con el teclado.

### RF-14 — Borrar los videos utilizados · **Fase 2**

1. El botón **Borrar videos utilizados** aparece **solo cuando el ranking se ha generado
   correctamente**, junto a **Descargar**.
2. Al pulsarlo se abre una **ventana de confirmación** que indica cuántos clips se van a borrar
   y advierte de que la acción es irreversible. **Cancelar no cambia nada.**
3. Al confirmar se eliminan de la galería **y del disco** únicamente los clips usados en ese
   ranking; se limpian las casillas de la vista de montaje y la selección de la galería.
4. El `ranking.mp4` generado, su `spec.json` y su `manifest.json` **no se tocan**: la descarga
   sigue disponible hasta que se inicie otro montaje. Tampoco se borran otros clips de la
   galería ni otros trabajos.
5. Si un archivo de la galería ya no existe, el borrado termina sin error, limpia la entrada y
   avisa de lo que faltaba.
6. La acción no se puede deshacer desde el panel; no hay papelera ni restauración.

**Criterio de aceptación.** Tras confirmar, exactamente los N clips de ese ranking han
desaparecido de la galería y del disco, las casillas están vacías y el `ranking.mp4` se sigue
pudiendo descargar. Cancelar deja los N clips, las casillas y el ranking como estaban.

### RF-15 — Generación automática (futura) · **no activa en la Fase 2**

1. El botón **Generar automático** está visible en la galería, deshabilitado y acompañado de
   «Próximamente».
2. No tiene endpoint, no crea trabajos, no modifica la selección y no se puede activar por
   teclado ni por API.
3. El criterio de orden automático (scoring, diversidad, duración, categorías) **no está
   definido**; se documentará en el RPD antes de implementarlo.

**Criterio de aceptación.** El control tiene `disabled`/`aria-disabled`, un clic no produce
ninguna petición ni cambio de estado y no aparece ninguna ruta de generación automática en la
API.

### RF-16 — Ingesta multi-fuente · **diseñada, no activa (Fase 3)**

1. Tres formas de entrada: **enlace** de YouTube, de TikTok u otra plataforma de la lista admitida,
   y **archivo local** (la subida que ya existe en la Fase 2). Una URL por extracción.
2. La descarga la hace `yt-dlp` como **herramienta externa**, resuelta como FFmpeg
   (`OPENRANKS_YTDLP` → `PATH` → error accionable en el panel). Sin DRM, sin muros de pago y sin
   contenido privado: los enlaces que exigen sesión o cookies no forman parte del alcance.
3. **Antes de descargar** se declara la procedencia y los derechos del material: autor o canal,
   URL, fecha y licencia declarada. Esa procedencia se guarda por clip y se muestra en la galería
   (RF-20).
4. La fuente descargada va a un **área temporal**, nunca a la galería: solo los tramos aprobados
   entran en `library/`.
5. Progreso por fase y cancelación, como en L1/L2. Si la descarga falla o se cancela, no queda
   nada: ni temporal ni entrada en la galería.
6. Límites de la fuente: 60 min y 2 GB (ajustables por entorno) y **una descarga a la vez**.

**Criterio de aceptación.** Con un enlace válido de YouTube y otro de TikTok (contenido propio) se
obtiene el archivo y la parrilla de candidatos. Sin `yt-dlp` el panel dice qué instalar y no crea
trabajo; sin declaración de derechos el botón está deshabilitado; una URL inválida, privada o de
una plataforma no admitida falla con mensaje legible y **0 archivos**; al cancelar no quedan
restos en disco.

### RF-17 — Segmentación en escenas (estilo CapCut) · **diseñada, no activa (Fase 3)**

1. Detección en **dos señales**: imagen (cambio de escena y de movimiento, `scdet`/`select scene`
   con umbral en el preset del extractor) y audio (`silencedetect`), más `blackdetect` para
   descartar negros.
2. **Referencia funcional: el «Split scenes» de CapCut**, que divide el vídeo en un subclip por
   plano detectando cambios de escena y de movimiento. openRanks hace lo mismo y después **filtra
   por la banda del producto** (§3): fusiona los tramos de menos de 1 s con el vecino, parte los de
   más de 30 s y deja **0,2 s de margen** en cada corte para no comerse el primer fotograma.
3. El sistema **propone, nunca publica solo**: cada candidato se revisa con miniatura y duración
   (ADR-18).
4. Los tramos aprobados se extraen del temporal y entran en la galería como clips normales; el
   archivo descargado se borra al cerrar la revisión (retención en §16).
5. El **análisis no recodifica** (una pasada por fotograma; ~17x tiempo real en 1080p medido con
   `scdet`). El corte de un tramo se hace por **copia** cuando cae en keyframe y recodifica **solo
   ese tramo** cuando no.
6. Si la detección no da al menos **5 tramos válidos**, se avisa: ese vídeo no puede generar un
   ranking.

**Criterio de aceptación.** Sobre un compilado de referencia con cortes conocidos, la propuesta
recupera **≥ 80 %** de los cortes con **≤ 20 %** de falsos positivos. Ningún candidato queda fuera
de 1-30 s. Aprobar 6 candidatos deja exactamente **6 clips** en la galería, con su procedencia y
su duración dentro de la banda, y el temporal se borra; descartarlos todos no deja nada. Cambiar el
umbral del preset cambia la propuesta sin tocar código.

### RF-18 — Score de viralidad 0-100 · **diseñada, no activa (Fase 3)**

1. Todo clip tiene un **score de 0 a 100** visible en su tarjeta (parrilla de revisión, galería y
   montaje), con **2 o 3 razones** cortas y la fuente del score (`heurístico` o `llm`).
2. **Base heurística local**, siempre disponible y sin coste: movimiento y cambio visual, presencia
   de caras, energía y picos de audio, texto en pantalla, duración y fuerza del primer segundo.
3. **Refinamiento LLM opcional**: lee miniaturas, metadatos y, si está configurada, la
   transcripción; devuelve score y razones con un JSON Schema. Usa **el mismo modelo y prompt para
   todos los clips de un trabajo**, para que los scores sean comparables entre sí.
4. El score se guarda con la **versión del modelo, la fecha y el hash del clip**: mismo archivo y
   mismos parámetros ⇒ mismo score heurístico; el del LLM es reproducible por estar guardado, no
   por volver a llamarlo.
5. Si el LLM no está configurado, falla o tarda: el clip se queda con el score **heurístico**, el
   panel lo avisa y **nada bloquea** la selección ni el render.
6. Coste y latencia: heurístico **< 1 s** por clip; el LLM puntúa el trabajo en **una sola
   llamada** (comparabilidad entre clips), con **p95 < 20 s**, modelo por defecto **Claude Haiku
   5.5** y **tope de 0,02 USD por trabajo**; con ese modelo, un trabajo de 10 clips cuesta
   ≈ **0,0011 USD** (§7.9).

**Criterio de aceptación.** Un set dorado de clips con orden humano da una **correlación de
Spearman ≥ 0,6** con el score. El 100 % de los scores está en 0-100 y trae sus razones. El mismo
clip procesado dos veces da el mismo score heurístico. Con el LLM caído el flujo completa y los
scores quedan marcados como heurísticos. El coste medido por trabajo no pasa de **0,002 USD** con
el modelo por defecto y nunca del tope de **0,02 USD**.

### RF-19 — Selección y orden por score · **diseñada, no activa (Fase 3)**

1. Dos caminos, con el score siempre a la vista: **manual** (el operador selecciona en la galería,
   como RF-12) y **automático** (con LLM decide a partir de los scores y la diversidad; sin LLM
   ordena por score heurístico y diversidad). En ambos casos elige 5-10, cabe en 30-58 s y explica
   la elección.
2. El automático **propone**; el operador acepta, ajusta o descarta. Aceptar deja la misma
   selección ordenada que el camino manual: nada se monta sin pasar por el panel (ADR-9).
3. **Orden de retención**: los puestos se ordenan por score **ascendente en el sentido de
   reproducción**. El vídeo **abre con el clip de menor score** (#5, #6…) y **cierra con el mejor,
   que ocupa el #1**. Es la lectura operativa de ADR-13: el mejor es el #1 y el #1 va al final.
4. El botón **«Generar automático»** del panel (RF-15) **se activa con esta fase** y usa los mismos
   scores; «Generar manual» no cambia.
5. Sin scores todavía no hay automático: el botón queda deshabilitado y explica el motivo.

**Criterio de aceptación.** Con 10 clips de scores conocidos, el orden del `ranking.mp4` es
ascendente y el #1 es el de mayor score. El automático nunca elige menos de 5 ni más de 10, no
repite clip y su elección cabe en 30-58 s. Aceptar la propuesta deja casillas y ticks como el
camino manual. Sin scores, «Generar automático» está deshabilitado y explica por qué; «Generar
manual» sigue igual.

### RF-20 — Galería, procedencia y deduplicación · **diseñada, no activa (Fase 3)**

1. Los clips aprobados entran en la **galería actual** (`library/` + `library.json`) y se comportan
   como cualquier otro: filtro por categoría, selección 5-10, generar y borrar usados (RF-11 a
   RF-14).
2. Cada clip guarda **procedencia** (plataforma, URL, autor o canal, fecha y licencia declarada) y
   su **score**; la tarjeta lo muestra sin enseñar rutas del host (§10.3).
3. **Deduplicación por hash**: si el tramo ya está en la galería, se avisa y se reutiliza la
   entrada en vez de duplicar el archivo.
4. El archivo de la fuente es **temporal**: se borra al cerrar la revisión (o según la retención
   que fije §16) y solo los tramos aprobados ocupan espacio.
5. La categoría se escribe como hoy (texto libre con autocompletado, ADR-14) o se sugiere a partir
   de la fuente.

**Criterio de aceptación.** Aprobar 6 tramos deja 6 entradas con categoría, procedencia y score
visibles y sin rutas del host. Volver a extraer el mismo tramo no crea duplicado: avisa y reutiliza
la entrada. El temporal desaparece y el espacio ocupado es el de los tramos aprobados. «Borrar
videos utilizados» sigue borrando solo los clips de ese ranking.

---

## 7. Diseño técnico

### 7.1 Alcance técnico

El código implementa **L1, L2 y el panel**. La **Fase 2** añade a esa misma arquitectura una
galería persistente y la navegación lateral; **el motor no cambia**: la galería guarda
originales y, al generar, los copia al `input/` del trabajo para que `prepare` → `join` →
`render` sigan siendo los mismos. La **Fase 3** está diseñada (§7.8) y **no construida**; la
publicación (L4) sigue fuera del alcance y no hay módulos de cola, almacenamiento objeto ni
publicación. La extracción se documentó primero y se implementará después, con sus propias tareas
en el plan.

### 7.5 Arquitectura de componentes

Arquitectura de componentes (Fase 1 + Fase 2) en un solo servicio:

```
                 ┌──────────────────┐
   operador ────►│  panel (Next.js) │  galería, selección, textos, plantilla, ver, descargar
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
                 │  trabajos en disco│  library/, input/, render/prepared/, union.mp4, ranking.mp4, manifiestos
                 └──────────────────┘
```

No hay servicios adicionales. La **galería de la Fase 2** vive en el mismo directorio de
trabajos (`library/` + `library.json`) y la sirve el propio panel; no añade base de datos ni
proceso aparte. La cola, la base de datos y el almacenamiento objeto pertenecen a L4 y no
forman parte de esta arquitectura.

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

La Fase 2 se implementó **solo en el panel**: la lógica de galería y selección
(`web/lib/gallery.ts`), las rutas de galería y el layout con el menú lateral. El motor no gana
comandos ni flags nuevos.

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
La galería de la Fase 2 queda dentro del **mismo volumen** (`/data/jobs/library/`), así que
sobrevive a reinicios y despliegues sin configuración adicional.

### 7.8 Fase 3 — diseño técnico (no construido)

```
enlace ──► yt-dlp ──► temporal ──► análisis (ffprobe + scdet / silencedetect / blackdetect)
                                          │
                                          ▼
                               candidatos (extract.json + miniaturas)
                                          │
                             parrilla de revisión (panel)
                                          │  aprueba
                                          ▼
                    library/<id>.<ext> + procedencia + score
```

- **Mismas piezas que L1/L2**: motor Python de stdlib pura y FFmpeg. Se suman `yt-dlp` (herramienta
  externa, detectada como FFmpeg) y un **cliente LLM por HTTP** (chat completions con imagen,
  sin SDK); ninguno es obligatorio para L1/L2. Proveedor, modelo y coste: §7.9.
- **Un trabajo por extracción** en el mismo directorio de trabajos: `extract/source.*` (temporal),
  `extract.json` (cortes, umbrales, versiones y scores) y `candidates/` (miniaturas). Los clips
  aprobados se copian a `library/`, así que la Fase 2 no cambia.
- **Sin cola ni base de datos**: una extracción a la vez por panel y progreso por fase con el mismo
  mecanismo que L1/L2.
- **Determinismo y trazabilidad**: mismo archivo + mismos umbrales ⇒ mismos cortes. El manifiesto
  guarda hash de la fuente, versión de `yt-dlp` y de FFmpeg, umbrales, modelo y prompt del LLM, y
  los scores con sus razones; nunca rutas absolutas.
- **Dependencia del roadmap de IA**: el score por LLM y la selección automática son las tareas
  IA-1 e IA-2 de §12.3 del plan. Sin ellas, la capa funciona con el score heurístico y la
  selección manual.

### 7.9 Proveedor del LLM del score: comparación, decisión y coste

**Decisión (ADR-20, 28-oct-2026): Claude Haiku 5.5**, con **cliente intercambiable** por entorno.
Los otros dos candidatos se miden con el mismo set dorado y se cambian sin tocar código:
`gpt-6-luna` (OpenAI) y `Gemini 3.8 Flash`.

El cliente habla **chat completions con la imagen en data URL y salida JSON**, que es lo que
exponen los tres proveedores (Google y Anthropic publican una capa compatible con OpenAI; se
comprueba con la prueba de humo al implementar). Cambiar de proveedor es cambiar URL, clave y
modelo, no código.

**Unidad de coste.** Un trabajo = **10 clips puntuados en una sola llamada** (mismo modelo y
prompt para todos, RF-18): 1 miniatura de 512x512 por clip (≈350-400 tokens de imagen) + 40 tokens
de metadatos, 600 tokens de prompt y esquema, y ≈120 tokens de salida por clip. Total estimado
**≈5.000 tokens de entrada y 1.200 de salida** por trabajo. Precios de lista por 1M de tokens,
consultados el 28-oct-2026 (sin lote ni caché; el procesamiento por lotes abarata ~50 %):

| Opción | Entrada / salida (USD/1M) | Coste por trabajo (10 clips) | Por 1.000 trabajos | Notas |
| --- | --- | --- | --- | --- |
| **Claude Haiku 5.5** (elegido) | 0,10 / 0,50 | **0,0011 USD** | **1,10 USD** | Visión y salida estructurada; el modelo más rápido de su familia, posicionado para clasificar y extraer |
| GPT-6 Luna (OpenAI) | 0,10 / 0,50 | 0,0011 USD | 1,10 USD | Mismo precio; alternativa directa si el set dorado lo puntúa mejor |
| Gemini 3.8 Flash | 0,75 / 3,75 (1,50 / 7,50 desde 1-ene-2027) | 0,0083 USD | 8,25 USD | Multimodal fuerte; el *free tier* usa los datos para mejorar el producto, así que solo vale para calibrar con material sin derechos de terceros |
| GLM-5V-Turbo (Z.ai) | 1,20 / 4,00 | 0,0108 USD | 10,80 USD | Visión; más caro por token que Haiku y sin ventaja medida para esta tarea |
| GPT-6.1 Terra (OpenAI) | 1,00 / 5,00 | 0,0110 USD | 11,00 USD | Gama media; no aporta nada al score que no dé Luna por 10× menos |
| Local (Qwen-VL en CPU) | 0 | 0 | 0 | **Descartado**: sin GPU no cumple el p95 de 20 s por trabajo |

**Por qué Haiku 5.5.** El score es **clasificar y extraer** (0-100 + razones) a partir de una
miniatura, que es exactamente el uso para el que el modelo está posicionado, y el coste por
trabajo queda en **una décima de céntimo**: a este volumen (decenas de trabajos por semana) la
diferencia con los demás candidatos es calderilla, así que decide la calidad, no el precio.
Haiku, Luna y Gemini 3.8 Flash se comparan con el set dorado (RF-18) y se cambia
`OPENRANKS_LLM_MODEL` si alguno supera claramente la correlación de 0,6 o no cumple el p95.

**Control de coste.** Una llamada por trabajo, resultado cacheado por hash de clip, estimación de
tokens antes de enviar y tope **0,02 USD por trabajo** (`OPENRANKS_LLM_MAX_COST_USD`, 18× el
coste típico con Haiku). Si se supera el tope, no se llama al LLM y el trabajo sigue con el score
heurístico. El tope mensual y quién paga la clave quedan en §16.16.

**Lo que este coste no incluye.** La transcripción: `gpt-transcribe` cuesta 0,0045 USD/minuto de
audio, así que un compilado de 10 minutos son **0,045 USD**, unas **40 veces** el score de 10
clips. Por eso la transcripción sigue siendo una pregunta abierta (§16.12) y no entra en el
presupuesto del score.

**Datos y privacidad.** Las miniaturas salen del servidor al proveedor: solo de material con
derechos declarados (RF-16, §11.7), sin datos personales añadidos, y con la política del
proveedor de no entrenar con los datos de su API por defecto. Si el operador prefiere no salir de
su máquina, se queda el score heurístico local.

---

## 8. Modelo de datos

**No hay base de datos.** El estado de un trabajo vive en disco, dentro del directorio de
trabajos:

- `status.json`: estado, fase, avance, `clips{}` con el tick de cada puesto, `join`, resultado y
  el mapa `gallery` (puesto → id de galería) que usa «Borrar videos utilizados».
- `binding.json`: título, subtítulo opcional y puestos.
- `text.json`: último texto guardado con el botón **Guardar** (título y subtítulo), como
  respaldo para una sesión sin borrador local.
- `input/`: los clips subidos o importados desde la galería.
- `render/`: `prepared/NN.mp4` con los clips ya preparados, `union.mp4`, `ranking.mp4`,
  `spec.json` y `manifest.json`.
- `log.txt`: la traza del trabajo.
- `library.json`: índice de la **galería** (Fase 2) con `id`, `file`, `original_name`,
  `category`, `bytes` y `added_at`.
- `library/<id>.<ext>`: los clips **originales** de la galería. Al generar un ranking se
  copian a `input/` del trabajo; borrarlos de la galería no afecta a los trabajos ya creados.

La unión y las piezas intermedias quedan solo para trazabilidad: la API únicamente sirve
`ranking.mp4`. El preset guardado vive en el mismo directorio de trabajos
(`preset.json`). La **selección** de la galería no se guarda en el servidor: es estado de la
sesión del panel y se materializa en el trabajo al pulsar «Generar manual».

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
| `ranking.mp4` | 1080x1920, 30 fps, H.264 High, CRF 19, yuv420p, audio copiado, `+faststart`, ≤ 60 s. **Entregable principal** |
| `union.mp4` | Unión de los clips preparados sin overlay; **descarga opcional sin edición** desde el panel |
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
- **Galería (Fase 2)**: subir solo guarda el original (no normaliza). Listar y filtrar responde
  en ≤ 300 ms con una biblioteca de hasta 200 clips; si crece, la lista se pagina. La selección
  se refleja en ≤ 100 ms y el máximo de 10 se aplica también en el servidor, no solo en la UI.

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
| Galería → montaje | seleccionar 5-10 clips y generar en ≤ 2 clics, sin volver a subirlos |
| Acciones destructivas | el 100 % pide confirmación; cancelar no cambia ningún dato ni archivo |
| Límite de selección | 10 clips como máximo, indicado en la UI y aplicado también en el servidor |

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
7. **Ingesta (Fase 3)**: solo material con derechos —canal propio, licencia explícita, CC-BY o
   permiso escrito— y la procedencia se declara **antes** de extraer. No se sortean DRM ni muros
   de pago, no se descarga contenido privado y se respetan los términos de la plataforma.

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
| R6 | **Duplicación de almacenamiento** (original en la galería + copia en cada trabajo) | Medio | La copia es lo que permite borrar de la galería sin romper rankings; se documenta y se prevé una política de retención/limpieza (§16) |
| R7 | **Borrado accidental de clips** | Alto | Confirmación obligatoria, solo tras un render correcto, y se borran únicamente los ids de ese ranking; el `ranking.mp4` no se toca |
| R8 | **Reordenar con clips ya preparados** | Medio | El intercambio mueve los preparados con el clip (sin recodificar) y conserva los ticks; solo invalida la unión/edición, que se rehacen al montar. Si un puesto no estaba preparado, se prepara después del intercambio |
| R9 | **Galería grande o lenta** | Bajo | Se guardan solo originales, se lista con paginación si supera 200 clips y el filtro se resuelve en el servidor |
| R10 | **Ingesta de material ajeno** (derechos y términos de la plataforma) | Alto: retirada del vídeo o del canal | Declaración de procedencia y derechos antes de extraer (§11.7), procedencia guardada por clip y visible en la galería; ni vídeos privados ni DRM |
| R11 | **La plataforma bloquea la descarga o `yt-dlp` se queda viejo** | Medio: una extracción falla | Versión mínima de la herramienta, error accionable con la orden de actualización y prueba de humo con una URL por plataforma |
| R12 | **Score de viralidad engañoso** | Medio: se elige un clip flojo | Set dorado con orden humano y correlación mínima (RF-18), razones visibles y revisión humana antes de montar (RF-19) |
| R13 | **Coste o latencia del LLM** | Medio: el flujo se encarece o espera | Score heurístico local como base, llamadas en lote con tope por trabajo, caché por hash de clip y degradación a heurístico si falla |
| R14 | **Escenas mal cortadas** (fundidos, destellos, planos muy cortos) | Medio: candidatos inútiles | Segunda señal de audio, banda 1-30 s con fusión y partición, margen de 0,2 s y revisión con miniaturas (ADR-18) |

---

## 15. Decisiones registradas (ADR-lite)

Solo se conservan las decisiones que gobiernan el alcance actual; las de L4 se retomarán con esa
capa.

| ADR | Decisión | Motivo |
| --- | --- | --- |
| ADR-3 | Overlay **ASS sobre FFmpeg (`libass`)**, no Remotion ni `drawtext` | Un solo runtime (el mismo motor que hace L1) y sin assets: `drawtext` no permite cambiar el color dentro de una línea y Remotion añadía Node, Chromium y un servicio de render a un producto que ya renderiza con FFmpeg. La pieza que importa (el spec reproducible, §9.3) es la misma |
| ADR-7 | **Construcción de atrás hacia delante: L1 → L2**, y el alcance se cierra en estas capas | Primero existe el producto terminado —formato y edición validados, algo publicable— y después se decide si se automatiza su entrada. L3/L4 no formaban parte del alcance el 23-oct-2026; ADR-17 abre la Fase 3 (L3) el 28-oct-2026 y L4 sigue fuera |
| ADR-8 | **Render 100 % automático y superficie editable = solo texto**: título del vídeo + subtítulo opcional + nombre de cada puesto | Decisión del operador. El estándar visual lo fija el preset y no el operador por vídeo, así que el resultado es reproducible y comparable entre rankings, el trabajo humano se reduce a elegir y revisar, y el render nunca espera a nadie. Obliga a reglas de encaje automático del texto (§9.5) |
| ADR-9 | **La interfaz es un requisito de producto, no un extra**: un **panel único** cubre el flujo de punta a punta, con progreso por fase, errores accionables, plantilla y textos en el mismo sitio | Decisión del operador: el producto debe ser cómodo y fácil de usar. El valor del servicio es ahorrar trabajo humano, y eso se pierde si el operador necesita terminal, `curl` o un editor. Convierte la usabilidad en criterio de aceptación medible (RF-9, §10.6) |
| ADR-10 | **El montaje es siempre de corte seco**: sin transiciones, sin *swoosh* y sin zoom de entrada. La unión se hace por **copia de streams** | Decisión del operador (16-oct-2026). El corte limpio se ve igual de bien en este nicho, elimina una generación de recodificación en la unión, quita dos decisiones por vídeo del panel y deja la capa transformativa donde de verdad se ve: el overlay. Consecuencia en el código: fuera `xfade` y fuera el `zoompan` del primer clip |
| ADR-11 | **Encuadre automático**: el clip horizontal con un clip vertical centrado se recorta al **área nítida**; el vertical no se recorta. Si la confianza es baja, se rellena con negro sin recortar | Decisión del operador (18-oct-2026). Los clips de entrada llegan en los dos formatos y el operador no debe recortar a mano ni decidir por vídeo; el render sigue siendo automático (ADR-8). La detección usa 12 fotogramas a 192 px y un refino a resolución completa, así que no compite con la codificación. El caso de fallo se resuelve ignorando islas nítidas aisladas y, si no hay confianza, no se recorta |
| ADR-12 | **Galería persistente de originales**: los clips viven en `library/`; al generar un ranking se **copian** al `input/` del trabajo | Decisión del operador (23-oct-2026). Reutilizar clips no puede obligar a volver a subirlos ni a prepararlos si no se usan. La copia mantiene el motor intacto (`prepare` → `join` → `render`) y hace que borrar de la galería no rompa un ranking ya hecho |
| ADR-13 | **El orden de selección asigna #1, #2, #3…**: el primero elegido es el mejor y cierra el vídeo | Decisión del operador (23-oct-2026). El operador elige de mejor a peor, que es el orden mental del ranking; el #1 ya es el mejor en todo el producto y el arrastre permite corregir después. Con score (Fase 3) el orden lo fija el score y no el clic (RF-19) |
| ADR-14 | **Una categoría de texto libre por clip**, creada al escribirla y sugerida por autocompletado; sin entidad ni pantalla de categorías | Decisión del operador (23-oct-2026). Evita administración y mantiene el flujo en la propia tarjeta. El filtro y las sugerencias salen de los datos; al borrar el último clip de una categoría, esta desaparece |
| ADR-15 | **Borrado de usados explícito y confirmado**, solo tras un render correcto: elimina los clips de la galería y del disco, limpia las casillas y **no toca** el ranking generado | Decisión del operador (23-oct-2026). Es la única acción destructiva del flujo y debe requerir intención clara; conservar el `ranking.mp4` evita que el operador pierda lo que acaba de descargar |
| ADR-16 | **Generación automática aplazada**: el botón existe visible y deshabilitado («Próximamente»), sin endpoint ni criterio de orden | Decisión del operador (23-oct-2026). Promete la dirección del producto sin inventar un scoring que aún no está definido; se diseñará en el RPD antes de implementarlo; ADR-19 ya fija el criterio para la Fase 3 |
| ADR-17 | **La Fase 3 (L3 · Extractora) entra en el alcance**: ingesta de YouTube, TikTok u otra plataforma admitida y archivos locales, con **declaración de derechos obligatoria** antes de descargar | Decisión del operador (28-oct-2026). El cuello de botella del producto es conseguir los clips, y la descarga de TikTok pasa de v2+ a esta fase. La declaración de derechos y la procedencia guardada mantienen §11: no se sortean DRM ni muros de pago y se sigue exigiendo material propio o licenciado |
| ADR-18 | **Segmentación por escenas y movimiento (como el «Split scenes» de CapCut), con revisión humana**: el sistema propone tramos dentro de la banda 1-30 s y el operador aprueba los que entran en la galería | Decisión del operador (28-oct-2026). CapCut demuestra que cortar por plano ahorra el trabajo manual, pero un compilado ajeno tiene planos que no valen: proponer y aprobar conserva la comodidad sin publicar relleno. La segunda señal de audio cubre lo que la imagen no ve (fundidos, reacciones) |
| ADR-19 | **Score de viralidad 0-100 por clip y orden con el mejor al final**: selección manual o automática con el score a la vista; el vídeo abre con el clip más flojo y cierra con el mejor, que es el #1. Activa «Generar automático» cuando exista la Fase 3 | Decisión del operador (28-oct-2026). El cierre con el mejor clip es lo que retiene hasta el final, aunque el orden parezca contraintuitivo (mejor = último). El score hace comparables los clips entre trabajos y da al camino automático un criterio explícito: resuelve la pregunta abierta 10 de §16 y da contenido al botón de RF-15 |
| ADR-20 | **Proveedor del score: Claude Haiku 5.5 por defecto, con cliente intercambiable** por entorno (`OPENRANKS_LLM_MODEL`, `OPENRANKS_LLM_BASE_URL`, `OPENRANKS_LLM_API_KEY`) y tope de 0,02 USD por trabajo | Decisión del operador (28-oct-2026), con precios de lista del 28-oct-2026 (§7.9). El score es una tarea de clasificación y extracción sobre una imagen, y Haiku 5.5 la cubre a 0,0011 USD por trabajo de 10 clips, por debajo de Gemini 3.8 Flash (0,0083), GLM-5V-Turbo (0,0108) y GPT-6.1 Terra (0,0110). El cliente configurable evita atarse a un proveedor: el set dorado (Spearman ≥ 0,6, p95 < 20 s) decide si hay que cambiar a GPT-6 Luna o Gemini 3.8 Flash |

---

## 16. Preguntas abiertas

1. **Banner de referencia**: ¿el operador lo sube por ranking, o hay una biblioteca fija por
   temática y el sistema solo elige? El MVP asume una biblioteca propia y el banner entra como
   parte del preset (no por vídeo).
2. **Duración objetivo** del short (30–58 s por defecto): ¿se quiere admitir un formato «TOP 10»
   más largo? Hoy el número de puestos llega a 10, pero el techo de duración sigue siendo 58 s.
3. **Idioma y tono** de los textos (`clip_label`, título y subtítulo): el preset no los fija.
4. **Miniaturas de la galería**: ¿basta con nombre, categoría y tamaño, o hace falta un
   fotograma de referencia? Generarlo requiere `ffmpeg` al subir y un archivo extra por clip.
5. **Borrado individual** de un clip de la galería (fuera del flujo de «Borrar usados»): ¿se
   permite, con qué confirmación y qué pasa si está seleccionado?
6. **Retención de la galería**: la deduplicación por hash ya está definida en RF-20; queda abierto
   cuántos clips se conservan y si se borran los originales de trabajos antiguos para no duplicar
   espacio.
7. **Categorías globales**: con texto libre, renombrar «Gatos» en un clip no cambia los demás.
   ¿Hace falta un renombrado/merge global o basta con editar clip a clip?
8. **Subida directa desde Montar**: la Fase 1 la mantiene. ¿Debe guardar también el clip en la
   galería, o la galería es solo para subidas hechas desde ella?
9. **Selección antes de generar**: hoy es efímera (se pierde al recargar). ¿Debe persistir en
   `sessionStorage` o en el servidor para sobrevivir a un cierre accidental?
10. **Criterio de la generación automática**: resuelto en ADR-19 (score 0-100 y el mejor clip al
    final). Queda abierto el presupuesto y la titularidad de la clave (pregunta 16).
11. **Alcance de la ingesta**: ¿una URL por extracción, o también listas de reproducción y canales
    completos? El diseño asume una URL por trabajo.
12. **Transcripción para el score**: ¿se transcribe el audio (Whisper, IA-1) para puntuar el
    remate y el contexto, o el score se queda en imagen + audio? Cambia el coste y el alcance.
13. **Umbrales de segmentación**: los valores de partida (≈10 de `scdet`, ≈0,35 de `select scene`)
    hay que calibrarlos por tipo de contenido (vlog, gameplay, animación).
14. **Retención del original descargado**: ¿se borra al cerrar la revisión o se conserva N días
    para re-extraer sin volver a descargar? Afecta a espacio y a derechos.
15. **LLM**: resuelto en ADR-20 y §7.9 (Claude Haiku 5.5 por defecto, ≈0,0011 USD por trabajo de
    10 clips, tope de 0,02 USD por trabajo y cliente intercambiable).
16. **Presupuesto y titularidad de la clave del LLM**: quién la paga y qué tope mensual; el diseño
    asume clave propia del operador y el tope por trabajo de §7.9.

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
| `OPENRANKS_LLM_API_KEY` | — | Clave del proveedor del score (Fase 3); sin ella se usa el heurístico |
| `OPENRANKS_LLM_MODEL` | Claude Haiku 5.5 | Modelo del score; el cliente es intercambiable (ADR-20) |
| `OPENRANKS_LLM_BASE_URL` | el del proveedor | Endpoint del cliente LLM |
| `OPENRANKS_LLM_MAX_COST_USD` | `0.02` | Tope de coste estimado por trabajo antes de llamar al LLM |

La Fase 2 **no añade variables de entorno**: la galería vive en `OPENRANKS_JOBS_DIR/library/` y
la sirve el propio panel. El arranque local, la utilidad del venv y el orden de resolución de
Python/FFmpeg están en el plan, §12.1. La Fase 3 añadirá las de su propia capa cuando se
construya (`OPENRANKS_YTDLP`, ya prevista arriba).

### 17.2 Referencias de la Fase 3

- **CapCut — Split scenes**: divide el vídeo en un subclip por plano detectando cambios de escena
  y de movimiento; es la referencia funcional de RF-17 (<https://www.capcut.com/tools/split-scene>).
- **FFmpeg — detección de escenas**: `scdet` (umbral `t`, por defecto 10; 8-14 para imagen real) y
  `select='gt(scene,0.35)'` (0,25-0,5), con la advertencia de que fundidos y disoluciones se
  escapan y de que conviene dejar 0,2-0,5 s de margen en cada corte
  (<https://ffmpeg-cookbook.com/en/articles/scene-detect/>).
- **PySceneDetect**: referencia de umbrales y detección por contenido para comparar resultados
  (<https://www.scenedetect.com/cli/>).
- **Precios del LLM (28-oct-2026)**: Claude Haiku 5.5
  (<https://claude.com/pricing>), GPT-6 Luna y GPT-6.1 Terra
  (<https://developers.openai.com/api/docs/pricing>), Gemini 3.8 Flash
  (<https://ai.google.dev/gemini-api/docs/pricing>) y GLM-5V-Turbo
  (<https://docs.z.ai/guides/overview/pricing>). Si cambian, se recalcula §7.9.

