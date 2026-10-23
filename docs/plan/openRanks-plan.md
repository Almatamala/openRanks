# openRanks — plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **Fase 1 (L1, L2 y panel) construida y verificada.** **Fase 2 (galería y navegación) planificada**: requisitos cerrados, código pendiente |
| **Fecha** | 23-oct-2026 |
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
| **3** | **Fase 2 · Galería y navegación (panel)** | Menú lateral, galería persistente con categorías, selección ordenada de 5 a 10, generación manual, reordenación por arrastre y borrado de los usados | **Planificado** |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `prepared/NN.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `spec.json`.

La extracción automática (L3) y la publicación (L4) **no forman parte del alcance actual**; no
hay código, tablas ni endpoints de esas capas. La **generación automática** de la Fase 2 es
futura: solo existe el botón deshabilitado, sin algoritmo ni endpoint.

---

## Estado de implementación (23-oct-2026)

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
| Pruebas | `tests/` | Núcleo puro sin FFmpeg + integración real con FFmpeg |

**Pendiente — Fase 2.** La galería (`library/` + `library.json`), el menú lateral, la selección
ordenada, la generación manual, el arrastre de puestos y el borrado de usados están definidos
en el RPD (RF-10 a RF-15, §5.2–§5.4) y se planifican en el bloque **F2** de §12. No hay código
de esta fase todavía.

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
| **F2** — Galería y navegación (panel) | menú lateral, galería persistente, categorías, selección 5-10, generación manual, arrastre y borrado de usados | **Planificado** |

### 12.1 Entorno local: Python, venv y FFmpeg

El panel resuelve el intérprete y FFmpeg por su cuenta, en este orden:

- **Python**: `OPENRANKS_PYTHON` → `.venv` del repo → `py -3` / `python` (Windows) o
  `python3` / `python` (resto).
- **FFmpeg** (se exige 5+): `OPENRANKS_FFMPEG` / `OPENRANKS_FFPROBE` → `PATH` → npm
  (`ffmpeg-static` + `ffprobe-static`) → `static_ffmpeg` del venv.

Por eso **el panel no necesita el venv**: `npm run dev` desde la raíz funciona con Node y un
Python 3.11+ del sistema.

**¿Para qué sirve activar el venv al iniciar el repo?** Solo para la terminal en la que se
trabaja: al activarlo, `python`, `pip`, `pytest` y el comando `openranks` apuntan al entorno
del repo en vez de al Python global. Eso evita mezclar versiones e instalar dependencias de
desarrollo fuera del entorno. **No cambia la resolución del panel** (que ya mira `.venv`) y
**no configura FFmpeg** por sí solo: los binarios se resuelven por las variables o por el
`PATH`, y `static_ffmpeg` del venv solo entra como último recurso.

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
| Salida interna | **un clip preparado por puesto** + **un solo `union.mp4`** con audio a −14 LUFS; ninguno se descarga |
| **Salida (criterio)** | `ffprobe` valida los archivos (1080x1920, 30 fps, yuv420p, audio presente); el operador solo descarga el `ranking.mp4` que produce L2 |

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

### F2 — Galería y navegación (panel) · **planificado**

Depende de la Fase 1: el panel y el motor ya están verdes. **El motor no se toca**: la galería
guarda originales y, al generar, los copia a `input/`; `prepare` → `join` → `render` siguen
siendo los mismos.

| Tarea | Entregable | Depende de | Verificación |
| --- | --- | --- | --- |
| **P2-1** | Galería en disco: `library.json` + `library/<id>.<ext>`, con subida, listado, filtro y edición de categoría. APIs del panel para crear, listar y actualizar. | — | El índice y los archivos sobreviven a un reinicio; la API no expone rutas del host; subir un formato no permitido falla con un error legible. |
| **P2-2** | Layout con **menú lateral persistente**: «Montar ranking» y «Galería de videos», sección activa, foco y navegación por teclado. | — | Ambas secciones a un clic; la activa está marcada; ir a la galería y volver no pierde el montaje. |
| **P2-3** | UI de galería: subida, tarjetas, categoría en línea con autocompletado, filtro, selección ordenada, contador y límite de 10. | P2-1, P2-2 | Subir → recargar → sigue; categoría y filtro correctos; 4 seleccionados deshabilitan «Generar manual»; el 11.º no se puede seleccionar. |
| **P2-4** | **Generar manual**: valida 5-10, confirma el reemplazo si hay montaje, reemplaza casillas y `input/`/`render/` anteriores, copia los originales, prepara por puesto y abre Montar con las casillas en orden. | P2-3 | Con 5-10, las casillas quedan #1… y encienden su tick; cancelar la confirmación no cambia nada; no quedan archivos del montaje anterior; el motor recibe los mismos comandos de siempre. |
| **P2-5** | **Arrastrar y soltar** desde el borde izquierdo: intercambia puestos, renumera, invalida unión/edición y vuelve a preparar lo afectado. Equivalente por teclado. | P2-4 | Arrastrar #5 sobre #1 intercambia ambos; el vídeo sale en el nuevo orden; la unión anterior deja de valer; las flechas del asa hacen lo mismo. |
| **P2-6** | **Borrar videos utilizados**: aparece junto a Descargar solo con un ranking correcto; confirmación; borra los N clips de la galería y del disco; limpia casillas; conserva el ranking. | P2-4, P2-5 | Confirmar elimina exactamente los N clips y deja el `ranking.mp4` descargable; cancelar no cambia nada; no toca otros clips ni otros trabajos. |
| **P2-7** | **Generar automático** visible y deshabilitado con «Próximamente», sin endpoint ni side effects. | P2-3 | `disabled`/`aria-disabled`; un clic no hace ninguna petición; no hay ruta de generación automática. |
| **P2-8** | Pruebas y documentación de la fase: lógica pura de galería/selección con `node --test`, typecheck/build y checklist E2E del flujo completo. | Todas | CI en verde (pytest, `node --test`, typecheck, build); el checklist de §13.3 se pasa entero; RPD/plan actualizados si cambia una decisión. |

**Orden recomendado:** P2-1 → P2-2 → P2-3 → P2-4 → P2-5 → P2-6. P2-7 puede hacerse en
cuanto exista la galería; P2-8 se cierra al final de la fase, con las pruebas de cada tarea ya
verdes.

### 12.2 Fuera del alcance actual

- **L3 — Extractora**: ingesta de YouTube, segmentación de compilados, screening, scoring de
  viralidad y selección TOP N.
- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes y analítica.
- **Algoritmo de generación automática (Fase 2 futura)**: el botón deshabilitado se entrega en
  P2-7, pero el criterio de orden y el scoring no están definidos. Se documentan en el RPD antes
  de implementarlos.
- **v2+**: descarga de TikTok, voz en off/TTS, autopilot por canal, reescritura de bordes,
  generación de banners por IA, multi-idioma y A/B de estilos.

Si se retoma alguna, primero se documenta en el RPD y se añade aquí su entregable y su
verificación; no se construye por detrás de estas reglas.

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
renumeración al deseleccionar, filtro por categoría y validación 5-10) vive en funciones puras
y se prueba con `node --test`, sin dependencias nuevas. El contrato de la galería se prueba con
peticiones a la API (subir, listar, filtrar, categoría y borrado). CI mantiene `pytest`,
`typecheck` y `build`.

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
- **Siguiente: la Fase 2** (prioridad 3), en el orden P2-1 → P2-6 y con el checklist de §13.3.
  El resultado esperado es el flujo completo **galería → selección → generar manual → montaje →
  descarga → borrar usados**, más el botón de generación automática deshabilitado. La fase vive
  solo en el panel: el motor no gana comandos y sus pruebas siguen siendo la red de seguridad.
- El panel **no necesita el venv**: `npm run dev` desde la raíz resuelve un Python 3.11+
  cualquiera y el FFmpeg estático de npm. El venv es una comodidad para el CLI y los tests
  (§12.1).
- Pendiente de L2, ya previsto en el RPD: **banner con la foto de referencia**
  (`assets/banners/`, §9.2) y **música/sfx** con la cama a −14 LUFS (en MVP van desactivados,
  §9.2, y requieren assets propios).
- **La generación automática** de la Fase 2 es futura (ADR-16): el botón se entrega
  deshabilitado y el criterio de orden queda como decisión pendiente del RPD §16.
- **L3 y L4 no forman parte del alcance actual** (ADR-7): no se construyen ni se documentan con
  más detalle hasta que se retomen.
