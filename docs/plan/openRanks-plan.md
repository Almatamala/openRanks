# openRanks — plan de ejecución

| Campo | Valor |
| --- | --- |
| **Producto** | `openRanks` — montaje y edición automática de shorts de ranking a partir de clips ya cortados |
| **Estado** | **L1, L2 y el panel están construidos y verificados.** El alcance actual está cerrado a estas capas |
| **Fecha** | 23-oct-2026 |
| **Alcance** | **Plan**: en qué orden se construye, qué entrega cada capa, qué está hecho, cómo se verifica y qué falta. El **qué y el por qué** están en el RPD (`docs/rpd/openRanks-rpd.md`) |
| **Documentos** | **RPD** + **plan** (este). La numeración `§` es **compartida y estable**: §1–§11 y §14–§17 viven en el RPD; §12–§13 viven aquí |

Este documento no repite el producto, el formato ni las reglas de estilo: eso está en el RPD.
Aquí solo se registra **cómo se construye y cómo se comprueba**.

---

## Orden de prioridades del producto

**Decisión del operador (13-oct-2026): se construye de atrás hacia delante, empezando por el
vídeo terminado.** El orden es `L1 → L2` y el alcance se cierra en estas capas.

| Prio | Capa | Qué entrega | Estado |
| --- | --- | --- | --- |
| **1** | **L1 · Ensamblador** | Los clips ya listos (normalizados, 9:16, 30 fps, audio a −14 LUFS) **y su unión en un solo vídeo vertical en corte seco** | **Hecho** |
| **2** | **L2 · Editor de la plantilla** | Sobre la unión, **toda la edición del estándar**: título, subtítulo opcional, escalera de rangos, rótulo por puesto, medallas del podio y atenuado de lo que no tiene el turno. **Render automático y estilo bloqueado** | **Hecho** |

**Contrato entre capas.** Cada capa consume la salida de la anterior como **archivos +
manifiesto**, nunca como llamadas acopladas. L1 produce `prepared/NN.mp4` + `union.mp4` +
`manifest.json`; L2 produce `ranking.mp4` + `spec.json`.

La extracción automática (L3) y la publicación (L4) **no forman parte del alcance actual**; no
hay código, tablas ni endpoints de esas capas.

---

## Estado de implementación (23-oct-2026)

Lo que está construido y verificado, con la pieza donde vive:

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

**La interfaz es el punto de entrada único** (RF-9): no hay paso que exija terminal, `curl`
ni un editor externo, y el panel no enseña rutas, ids internos ni JSON crudo.

### Reglas del producto que el plan no reabre

Las decisiones de producto están cerradas y cualquier cambio de código debe respetarlas. El
detalle y el motivo de cada una están en el RPD: **solo texto editable y render automático**
(ADR-8, §6/RF-7), **corte seco** (ADR-10, §3), **encuadre automático** (ADR-11, §9) y **panel
único** (RF-9, §10.6). Si una tarea del plan parece exigir tocar esas reglas, se cambia el
RPD/ADR primero, no el código por detrás.

---

## 12. Plan de ejecución

| Capa (prioridad) | Contenido | Estado |
| --- | --- | --- |
| **L0** — Esqueleto | repo, contrato de entrada, medición, CI, legal | **Hecho** |
| **L1** — Clips listos y unión vertical | normalización 9:16 por clip, unión en corte seco, audio a −14 LUFS | **Hecho** |
| **L2** — Edición del estándar | overlay ASS, escalera, rótulos, spec, preset editable | **Hecho** |

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

### 12.2 Fuera del alcance actual

- **L3 — Extractora**: ingesta de YouTube, segmentación de compilados, screening, scoring de
  viralidad y selección TOP N.
- **L4 — Integración y publicación**: orquestación de punta a punta, cola, almacenamiento,
  publicación en redes y analítica.
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

---

## Estado y siguientes pasos

- **L1 y L2 están hechas** (prioridades 1 y 2) y el **panel** (RF-9) cubre el flujo de esas dos
  capas.
- El panel **no necesita el venv**: `npm run dev` desde la raíz resuelve un Python 3.11+
  cualquiera y el FFmpeg estático de npm. El venv es una comodidad para el CLI y los tests
  (§12.1).
- Pendiente de L2, ya previsto en el RPD: **banner con la foto de referencia**
  (`assets/banners/`, §9.2) y **música/sfx** con la cama a −14 LUFS (en MVP van desactivados,
  §9.2, y requieren assets propios).
- **L3 y L4 no forman parte del alcance actual** (ADR-7): no se construyen ni se documentan con
  más detalle hasta que se retomen.
