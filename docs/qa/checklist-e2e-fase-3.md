# Checklist E2E — Fase 3 (extractora de clips)

| Campo | Valor |
| --- | --- |
| **Qué es** | Guía operativa del checklist E2E de §13.4 del plan, paso a paso y con el registro de resultados |
| **Fase** | Fase 3 — L3 · Extractora: entrada de material, descarga, segmentación en escenas, parrilla de revisión, aterrizaje en la galería, score con LLM y generación automática |
| **Requisitos que cubre** | RF-16 a RF-22 |
| **Dónde vive el checklist original** | `docs/plan/openRanks-plan.md` §13.4 (esta guía no lo cambia: lo hace ejecutable) |
| **Estado del registro** | **Pendiente de ejecución** (ver §0) |
| **Fecha de preparación** | 17-nov-2026 |
| **Commit bajo prueba** | `master` tras `d3cef77` (`fix api key`); textos de la UI y de los documentos corregidos el 19-nov-2026 |

---

## 0. Estado del registro

**Todavía no hay resultados de la sesión de navegador.** Los 12 pasos requieren interacción
real con el panel y este entorno no tiene navegador, así que la tabla de §5 llega con todas
las filas en **Pendiente**. No se anota ningún «Pasa» que no se haya observado.

Lo que **sí** está medido antes de la sesión:

| Comprobación | Comando | Resultado (17-nov-2026) |
| --- | --- | --- |
| Pruebas del panel (incluye `extract.test.mjs`, `extract-api.test.mjs`, `extract-approve.test.mjs`, `auto-select.test.mjs`, `gallery-score.test.mjs`, `settings.test.mjs`) | `npm test` | **103/103 pasan**, 0 fallos (≈4,3 s) |
| Tipos del panel | `npm run typecheck` | **Sin errores** (`tsc --noEmit`, exit 0) |
| `pytest`, `npm run build` y `scripts/evaluate_score.py` | — | **No ejecutados** en esta preparación |
| `yt-dlp` disponible | `yt-dlp --version` | **No instalado** (`command not found`) → afecta a los pasos 3 y 4a |

Del set dorado (P3-8) lo documentado en el plan es **Spearman 0,81 y p95 ≈ 0,6 s por clip**;
no se ha vuelto a medir aquí. Las suites de segmentación y corte (`tests/test_scenes.py`,
`tests/test_cut.py`, `tests/test_scenes_e2e.py`) tampoco se han ejecutado en esta preparación.

### 0.1 Discrepancias con §13.4 (léelo antes de marcar un «Falla»)

El checklist del plan describe comportamientos que la UI no hace igual. Si se marca como
fallo lo que solo es una diferencia de redacción, la fase no se cierra nunca. Las deudas de
nombres que había al preparar esta guía —«Extraer clips» por «Divisor de escenas», el botón
«Extraer» por «Descargar vídeo»/«Subir vídeo» y «Ajustes» por «Configuración»— se corrigieron
el 19-nov-2026 en el plan, el RPD y los textos del panel, así que ya no cuentan como
discrepancia:

| # | Dice §13.4 | Lo que hace el panel | Cómo se registra |
| --- | --- | --- | --- |
| 1 | La parrilla del paso 4/6 enseña **score** | La parrilla enseña **nº, franja, duración, miniatura y duplicados**, sin score. El score nace en **«Puntuar galería»** (necesita clave LLM) y se ve en el informe, en la propuesta automática y en el puesto del montaje (**«Score N/100 · llm»**) | El score se verifica en los pasos 10-11; en el 4 y el 6 se anota «no aplica en la parrilla» |
| 2 | Sin clave, **«Dividir en escenas»** no arranca | El divisor **no usa la clave**: solo corta con FFmpeg, y el propio panel lo dice («El divisor de escenas no necesita clave»). Sin clave fallan **«Puntuar galería»** y **«Generar automático»** | El paso 12 comprueba el corte sin clave y el score bloqueado |

---

## 1. Cómo se registra la sesión

1. **Una sola sesión de navegador**, de principio a fin: los pasos comparten material (trabajo
   temporal, galería, scores y montaje). Si hay que reiniciar el panel, se anota en el paso.
2. Cada paso se cierra con **un** estado: `Pasa`, `Falla`, `Bloqueado` (no se pudo ejecutar:
   falta `yt-dlp`, material, clave…) o `Pendiente`.
3. Cada paso indica su **modo**: `Enlace` (necesita `yt-dlp` y material propio),
   `Archivo local` (no necesita `yt-dlp`) o `Ambos`.
4. **Evidencia obligatoria** en `Falla`: mensaje exacto, error de consola/Red o captura
   (`paso-06-parrilla.png`).
5. En **Notas** se apunta cualquier desviación del texto esperado aunque el resultado sea
   correcto.
6. **No se arregla nada a mitad del checklist**: si un paso falla, se registra, se sigue si es
   posible y se anota en §6.
7. Al terminar, se rellenan §6 (defectos) y §7 (cierre) y se actualiza el plan.

---

## 2. Requisitos previos

### 2.1 Entorno

- **Node** y **Python 3.11+** (probado aquí con 3.12.3). No hace falta venv: el panel resuelve
  el intérprete solo (§12.1 del plan).
- **FFmpeg**: lo aporta npm (`ffmpeg-static` + `ffprobe-static`).
- Arranque:

```bash
npm run dev      # desde la raíz del repo → http://localhost:3000
```

- Reinicia el panel antes de empezar: la detección de `yt-dlp` se cachea **una vez por
  proceso**, así que instalarlo con el panel abierto no basta.

### 2.2 `yt-dlp` (solo para los pasos 3 y 4a)

Este equipo **no lo tiene instalado**. Si no lo instalas, los pasos 3 y 4a se registran como
`Bloqueado` con ese motivo, y el resto se pasa entero en modo **Archivo local**.

```bash
pip install -U yt-dlp                 # o, en el venv del repo: pip install -e ".[extract]"
# alternativa: exportar OPENRANKS_YTDLP=/ruta/al/yt-dlp y reiniciar el panel
```

El panel lo detecta solo al arrancar y, si no lo encuentra, muestra qué instalar.

### 2.3 Material de prueba

Hace falta **un compilado vertical con cortes limpios**. El que genera §3 está medido: 60 s,
10 tramos de color de 6 s con audio → el análisis devuelve **9 candidatos** (uno de 12 s y ocho
de 6 s, porque el primer corte a 6 s no se marca) y **sin avisos**. Aprobar 6 candidatos de 6 s
da **36 s**, dentro de la banda de 30-58 s, y deja material suficiente para el automático.

Para el paso 8 hace falta **el mismo archivo** (o el mismo enlace) otra vez.

### 2.4 Estado limpio (opcional, con respaldo)

La galería y los trabajos viven en `web/.jobs/` (o en `OPENRANKS_JOBS_DIR`):

```bash
mv web/.jobs web/.jobs.bak-2026-11-17     # con el panel parado
```

> **No borres `web/.jobs`**: contiene trabajos y clips reales. Al terminar, restaura con
> `mv web/.jobs.bak-2026-11-17 web/.jobs`. Si prefieres no tocar nada, anota el conteo inicial
> de la galería en el paso 6.

### 2.5 Clave de IA (pasos 10 y 12)

- Menú → **Configuración** → pega la clave de **Claude (Anthropic)** o **Gemini (Google)** →
  **Guardar claves**. El estado debe pasar a **«En uso: …»**.
- Sin clave, el corte y el aterrizaje funcionan igual; **no hay score**, y «Generar
  automático» queda deshabilitado. Cada pasada de score es una llamada al LLM: no repitas el
  paso 10 con «Todos los clips» sin motivo.

---

## 3. Preparar el material (una vez)

Un compilado de 10 colores sólidos de 6 s, con audio, en vertical:

```bash
FF=$(node -p "require('./web/node_modules/ffmpeg-static')")
rm -rf demo/e2e-extract && mkdir -p demo/e2e-extract/seg
i=0
for c in red green blue yellow magenta cyan white orange purple pink; do
  i=$((i+1))
  "$FF" -y \
    -f lavfi -i "color=c=$c:s=720x1280:r=30:d=6" \
    -f lavfi -i "sine=frequency=$((300 + i * 40)):duration=6" \
    -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
    "demo/e2e-extract/seg/$(printf %02d $i).mp4"
  echo "file 'seg/$(printf %02d $i).mp4'" >> demo/e2e-extract/list.txt
done
"$FF" -y -f concat -safe 0 -i demo/e2e-extract/list.txt -c copy demo/e2e-extract/compilado.mp4
```

Comprobación (debe dar `60.0` y una pista de audio):

```bash
FP=$(node -p "require('./web/node_modules/ffprobe-static').path")
"$FP" -v error -show_entries format=duration -of csv=p=0 demo/e2e-extract/compilado.mp4
"$FP" -v error -show_entries stream=codec_type -of csv=p=0 demo/e2e-extract/compilado.mp4
```

Antes de la sesión puedes repetir el análisis sin abrir el panel (mismo comando que usa la API):

```bash
python -m openranks analyze --input demo/e2e-extract/compilado.mp4 \
  --out demo/e2e-extract/analysis --json --quiet \
  --ffmpeg "$FF" --ffprobe "$FP"
# → extract.json con 9 candidatos; el #1 va de 0 a 12 s y el resto son de 6 s
```

`demo/e2e-extract/` es material desechable de la sesión.

---

## 4. Los 12 pasos

### Paso 1 — Abrir el panel · RF-16 · Modo: ambos

**Acciones**

1. Arranca el panel y abre `http://localhost:3000`.
2. Mira el menú lateral: **Montar ranking**, **Galería de videos**, **Divisor de escenas** y
   **Configuración**.
3. Entra en **Divisor de escenas** y comprueba que queda marcada (`aria-current="page"`) y que
   la cabecera dice **«openRanks · divisor de escenas»**.
4. Recorre el menú **solo con teclado** (`Tab` + `Enter`) y vuelve a esta sección.

**Esperado**

- [ ] La sección existe con el nombre real **«Divisor de escenas»**.
- [ ] La sección activa está marcada y se alcanza con teclado, con foco visible.
- [ ] La cabecera explica el flujo: «De un vídeo a las escenas: declara los derechos;
      openRanks lo divide en escenas y tú eliges las que entran en el ranking.»

**Si falla, mira**: la sección se llama así en `Sidebar.tsx`; si no aparece en el menú, la
build no es la del commit bajo prueba.

---

### Paso 2 — Enlace sin casilla · RF-16.1 · Modo: enlace

**Acciones**

1. En **Origen del material**, deja **Enlace del vídeo**.
2. Pega `https://example.com/video` y sal del campo.
3. Borra el enlace, pega uno de YouTube (`https://www.youtube.com/watch?v=…`) y **no marques**
   la casilla.
4. Mira el botón de acción y el aviso que lo acompaña.

**Esperado**

- [ ] Con el enlace ajeno: error de campo **«Solo se admiten enlaces de YouTube, TikTok e
      Instagram.»**
- [ ] Con el enlace de YouTube y la casilla vacía: botón **«Descargar vídeo»** deshabilitado y
      motivo **«Pega el enlace y marca la casilla para poder extraer.»**
- [ ] El motivo de la casilla es «Marca que cumples los términos de la plataforma y la política
      de privacidad.»
- [ ] **No hay ninguna petición de descarga** (DevTools → Red: solo el `GET /api/extract` de la
      carga) y **0 archivos** nuevos en `web/.jobs/extract/`.

**Si falla, mira**: si el botón se habilita sin casilla, es un fallo de §11.7 (bloqueante); si
el enlace ajeno se acepta, el problema está en `parseLink` (`web/lib/extract.ts`).

---

### Paso 3 — Casilla marcada y sin `yt-dlp` · RF-16.2/16.3 · Modo: enlace

**Acciones**

1. Marca la casilla de cumplimiento con el enlace válido puesto.
2. Sin `yt-dlp` instalado (el estado de este equipo), mira la tarjeta **Herramienta de
   descarga** y el botón.
3. Pulsa **Volver a comprobar**.
4. Cuenta los archivos de `web/.jobs/extract/` y los clips de la galería.

**Esperado**

- [ ] Alerta con qué instalar: **«Falta yt-dlp, la herramienta que descarga el vídeo del
      enlace. Instálala con `pip install -U yt-dlp` … o define OPENRANKS_YTDLP con la ruta del
      ejecutable.»**
- [ ] El botón sigue **deshabilitado** con el motivo **«Sin yt-dlp no se puede descargar el
      vídeo.»** (no se puede pulsar: el plan habla de «pulsar», pero la UI lo impide).
- [ ] **0 archivos** en `web/.jobs/extract/` y la galería no cambia.
- [ ] **Volver a comprobar** no cambia nada mientras no se reinicie el panel.

**Si falla, mira**: si el panel deja descargar sin `yt-dlp`, es bloqueante; si instalaste
`yt-dlp` y sigue el aviso, reinicia el panel (la detección se cachea).

---

### Paso 4 — Descargar o subir y dividir en escenas · RF-16, RF-17 · Modo: enlace (4a) o archivo local (4b)

**4a. Enlace (requiere `yt-dlp`)**

1. Pega un enlace propio y admitido, marca la casilla y pulsa **Descargar vídeo**.
2. Sigue el avance: fase, **«Avance de la extracción»**, detalle `N % · X de Y · velocidad ·
   quedan …` y el botón **Cancelar la descarga**.
3. Al terminar, lee el aviso y pulsa **Dividir en escenas**.
4. Espera el análisis (barra indeterminada, **«Avance del análisis»**, «Dividiendo en
   escenas», «Una pasada sin recodificar: solo los cambios de imagen y los negros.»).

**4b. Archivo local (sin `yt-dlp`)**

1. Elige **Archivo local** y arrastra `demo/e2e-extract/compilado.mp4` (o pulsa y elígelo). La
   zona acepta **MP4, MOV, MKV, WEBM, M4V y AVI · hasta 2 GB**.
2. Marca la casilla y pulsa **Subir vídeo**.
3. Espera **«Vídeo completo listo · … MB»** y pulsa **Dividir en escenas**.

**Esperado (en los dos modos)**

- [ ] Enlace: aviso **«Descarga lista · … MB. El vídeo se queda en el área temporal y no entra
      en la galería.»** con **Descargar vídeo**, **Dividir en escenas** y **Descartar la
      descarga**.
- [ ] Local: aviso **«Vídeo completo listo · … MB. Se queda en el área temporal para dividirlo
      en escenas; el original no entra en la galería.»**
- [ ] Aparece **«Escenas propuestas»** con **«9 escenas · 0 aprobadas»** (con el material de
      §3) y ninguna fuera de **1-30 s**.
- [ ] Cada tarjeta muestra `#n`, franja (`0:00 – 0:12 · 12,0 s`), miniatura y los botones
      **Aprobar / Descartar / Dividir / Unir con la siguiente**.
- [ ] La parrilla **no enseña score** (ver §0.1, fila 1); el vídeo original **no** está en la
      galería.
- [ ] En disco: `web/.jobs/extract/<id>/` con `source.*`, `extract.json`, `job.json` y
      `candidates/`.

**Si falla, mira**: si el análisis devuelve 0 escenas, el material no tiene cortes (usa el
compilado); si un candidato se sale de 1-30 s, es un fallo de RF-17.2.

---

### Paso 5 — Cancelar a mitad · RF-16.5 · Modo: enlace o archivo local

**Acciones**

1. Empieza una extracción nueva.
2. Cancela durante el proceso: **Cancelar la descarga** (enlace), **Cancelar la subida**
   (archivo local) o **Cancelar la división** (análisis).
3. Mira el formulario, `web/.jobs/extract/` y la galería.

**Esperado**

- [ ] Se vuelve al formulario de entrada, sin trabajo a medias.
- [ ] La carpeta `web/.jobs/extract/<id>` **ya no existe** (ni `source.*`, ni miniaturas, ni
      `job.json`).
- [ ] La galería tiene los mismos clips que antes y no aparece ningún trabajo de montaje
      nuevo.

**Nota**: la subida del compilado de 60 s es instantánea y su análisis dura unos segundos, así
que para ver la cancelación con margen usa el **modo enlace** o genera un compilado más largo
(encadena el bloque de colores dos o tres veces). «Descartar la descarga» y «Descartar el vídeo
y las escenas» borran el temporal por el mismo camino.

**Si falla, mira**: si queda `source.*` tras cancelar, es un fallo de RF-16.5 (espacio
ocupado); si la galería gana un clip, el aterrizaje se está ejecutando antes de aprobar.

---

### Paso 6 — Parrilla: descartar, aprobar 6 y aterrizar · RF-17, RF-20 · Modo: ambos

**Acciones**

1. Recorre la parrilla y comprueba duraciones y botones.
2. **Descarta** un tramo (por ejemplo el último) y mira el resultado.
3. **Aprueba 6** tramos de 6 s (por ejemplo #2 a #7).
4. En **Categoría de los clips** escribe `e2e-f3` (o déjala vacía para «Sin categoría»).
5. Pulsa **Añadir escenas a la galería (6)**.

**Esperado**

- [ ] Descartar no recorta nada: la tarjeta queda marcada y ofrece **Recuperar**; la galería no
      cambia.
- [ ] Aprobar actualiza el contador: **«9 escenas · 6 aprobadas»**.
- [ ] El aterrizaje muestra **«Añadiendo escenas…»** y luego **«6 clips en la galería.»**
      (si alguno ya existía, añade «· N ya existían y se reutilizaron») con **Ir a la
      galería**.
- [ ] En `web/.jobs/library/` hay **6 archivos** nuevos y `library.json` suma **6 entradas**,
      con nombre `escena-02.mp4`…, duración `6`, categoría `e2e-f3` y sin score todavía.
- [ ] Los tramos no aprobados no dejan archivo.

**Si falla, mira**: si el aterrizaje deja entradas a medias, debe deshacerlas y conservar el
temporal para reintentar (`extract-approve.ts`); si un tramo fuera de 1-30 s se puede aprobar,
es RF-17.

---

### Paso 7 — Cerrar la revisión · RF-20.4 · Modo: ambos

**Acciones**

1. Después del paso 6, mira `web/.jobs/extract/` y `web/.jobs/library/`.
2. Comprueba el tamaño que ocupa el temporal.

**Esperado**

- [ ] La carpeta `web/.jobs/extract/<id>` **desapareció**: ni el vídeo descargado, ni las
      miniaturas, ni el estado.
- [ ] Solo ocupan espacio los tramos aprobados en `library/` (6 archivos de 6 s).
- [ ] Alternativa sin aprobar: **Descartar el vídeo y las escenas** borra el temporal y no deja
      ningún clip en la galería.

**Si falla, mira**: si queda el `source.*` de 60 s, es un fallo de RF-20.4 (espacio).

---

### Paso 8 — Reextraer y reutilizar · RF-20.3 · Modo: ambos

**Acciones**

1. Repite el paso 4 con **el mismo archivo** (o el mismo enlace) y vuelve a dividir.
2. Aprueba **solo el mismo tramo** que ya entró (por ejemplo el #2, de 6,0 s).
3. Pulsa **Añadir escenas a la galería (1)**.
4. Cuenta los clips de la galería y busca duplicados por `sha256` en `library.json`.

**Esperado**

- [ ] Aviso **«1 clip en la galería · 1 ya existían y se reutilizaron.»**
- [ ] La galería sigue con **6 clips**, no 7.
- [ ] No hay un archivo nuevo en `library/` ni dos entradas con el mismo `sha256`.
- [ ] El trabajo temporal se borra igual que en el paso 7.

**Si falla, mira**: el duplicado se busca por el SHA-256 del tramo recortado; si el corte
cambia unos bytes (otro punto de corte), no habrá reutilización y el clip será distinto, no un
duplicado. Usa exactamente el mismo tramo.

---

### Paso 9 — Galería: filtro, selección y generación manual · RF-20, RF-12 · Modo: ambos

**Acciones**

1. Menú → **Galería de videos**. Los 6 clips aprobados deben estar ahí, con su categoría y
   duración.
2. Filtra por `e2e-f3` (si la pusiste) y vuelve a **Todas las categorías**.
3. Selecciona los **6** clips y pulsa **Generar manual**.

**Esperado**

- [ ] Los clips aprobados se filtran y se seleccionan como los subidos a mano.
- [ ] Con 6: **«6 de 10 seleccionados. Listo para generar.»**
- [ ] Se generan 6 casillas con sus ticks y el panel navega a **Montar ranking** con el orden
      de selección.
- [ ] El borrado de usados **no se prueba aquí**: se comprueba en el paso 13 para no quedarte
      sin material para el paso 10.

**Si falla, mira**: si falta un clip aprobado, revisa el conteo del paso 6; si la galería
enseña rutas del host, es RF-20/§10.3.

---

### Paso 10 — Puntuar y generar automático · RF-18, RF-19 · Modo: ambos (requiere clave)

**Acciones**

1. Comprueba en **Configuración** que hay clave y que el estado dice **«En uso: …»**.
2. Galería → **Puntuar galería**.
3. En el diálogo **Puntuar la galería**, deja **Solo los no puntuados** y pulsa **Puntuar 6
   clips**.
4. Lee el informe **«Galería puntuada · umbral 55»**. No borres nada: **Cerrar**.
5. Pulsa **Generar automático**.

**Esperado**

- [ ] El diálogo resume «6 clips en la galería · 6 sin puntuar · 0 ya puntuados…» y marca cada
      clip como «Se puntúa» o «Se respeta».
- [ ] El informe da **score entero 0-100** y un **título** por clip, con **«Se queda» / «No
      pasa»** y el aviso de cuántos se puntuaron y cuántos se respetaron.
- [ ] **Generar automático** abre **«Propuesta automática · N clips»** con 5-10 clips, el texto
      «Elegidos por score, con un máximo de dos clips por categoría y hasta 58 s…», la lista
      `#1…#N` con **Score N/100 · llm · duración · categoría**, las marcas **Cierra el vídeo**
      (el #1) y **Abre el vídeo** (el último), y **Total**.
- [ ] Con los 6 clips de 6 s en la misma categoría, la propuesta esperada es **5 clips · 30,0
      s**: el tope de dos por categoría se relaja para llegar al mínimo de 5 y a los 30 s.
- [ ] El total cae en **30-58 s**, no repite clips y el **#1 es el de mayor score**.
- [ ] **Descartar** no cambia nada; **Generar con esta selección** deja casillas y ticks como
      el camino manual (si hay un montaje abierto, antes pide confirmación de reemplazo).

**Si falla, mira**: sin clave no debe haber scores; si el automático elige menos de 5 o pasa de
58 s, es RF-19; si el #1 no es el mejor score, el orden de la propuesta está mal.

---

### Paso 11 — Montar y orden del vídeo · RF-19, RF-20 · Modo: ambos

**Acciones**

1. Pulsa **Montar el ranking** y espera el resultado.
2. Reproduce el vídeo y descarga **Descargar el ranking (X MB)**.
3. Comprueba el orden: qué clip abre y cuál cierra, y qué puesto ocupa cada uno.

**Esperado**

- [ ] El montaje termina y el vídeo se reproduce en 9:16.
- [ ] Cada casilla muestra su **«Score N/100 · llm»** cuando el clip lo tiene.
- [ ] El vídeo **abre con el clip de menor score** y **cierra con el #1**, el de mayor score.
- [ ] La descarga se reproduce igual que la vista previa.

**Si falla, mira**: el orden lo fija la propuesta (el #1 cierra); si el vídeo sale al revés,
revisa `suggestAutoSelection` y el orden de importación.

---

### Paso 12 — Sin clave o con el proveedor caído · RF-18, RF-22 · Modo: ambos

**12a. Sin clave**

1. Configuración → **Quitar** la clave y confirma («¿Quitar la clave de … del panel? El score
   con ese proveedor dejará de estar disponible.»).
2. Galería → **Puntuar galería** → **Puntuar N clips** (con todo puntuado, el diálogo abre en
   **Todos los clips**).
3. Mira **Generar manual** y el divisor.

**Esperado**

- [ ] «Puntuar galería» falla con **«Sin clave de IA: guárdala en Configuración para puntuar
      la galería.»**
- [ ] **Generar manual** sigue funcionando.
- [ ] **Dividir en escenas** sigue funcionando **sin clave** (solo corta con FFmpeg): no es un
      fallo, es lo esperado (§0.1, fila 2).
- [ ] **Ojo**: quitar la clave **no borra los scores ya guardados**, así que «Generar
      automático» sigue activo y no es un fallo. El estado deshabilitado y su motivo
      (**«Necesitas al menos 5 clips con score y duración medida para usar el automático; hay
      N.»**) se comprueban con una galería que tenga menos de 5 clips puntuados: al final de la
      sesión, tras el paso 13, o subiendo clips nuevos a una galería limpia.

**12b. Proveedor caído**

1. Guarda una clave inválida (por ejemplo `sk-ant-invalida`) y elige ese proveedor.
2. Galería → **Puntuar galería** → **Todos los clips** → **Puntuar N clips**.
3. Lee el informe y mira `library.json`.

**Esperado**

- [ ] El trabajo falla con mensaje legible y, si hubo varios clips, **«No se pudieron puntuar
      N clips:»** con el motivo de cada uno.
- [ ] **No hay scores inventados**: los clips siguen sin `score` en `library.json`.
- [ ] La galería y el montaje no cambian.
- [ ] Al terminar, restaura la clave real.

**Si falla, mira**: un score heurístico de respaldo sería un fallo grave de RF-18; el cliente
LLM se prueba contra un servidor local en `tests/test_extract_ai.py`.

---

### Paso 13 — Cierre: «Borrar videos utilizados» · RF-14, RF-20.5 · Modo: ambos

**Acciones**

1. Con el ranking del paso 11, pulsa **Borrar videos utilizados** y **Cancelar**.
2. Vuelve a pulsarlo y **Aceptar**.
3. Cuenta clips en la galería y archivos en `library/`, y comprueba la descarga.

**Esperado**

- [ ] Cancelar no borra nada ni vacía casillas.
- [ ] Al aceptar desaparecen **solo los clips usados en ese ranking** (los de la propuesta
      automática), no los demás.
- [ ] Las casillas quedan vacías y el `ranking.mp4` sigue descargándose.
- [ ] Los clips de otras extracciones y otros trabajos no se tocan.

**Si falla, mira**: que se borre un clip no usado apunta a un id de galería perdido en la
importación; anótalo con el nombre del clip.

---

## 5. Tabla de resultados

Estado inicial: **Pendiente** en todos los pasos. Se rellenan durante la sesión (§1).

| # | Paso (RF) | Modo | Resultado | Evidencia | Notas | Fecha |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Abrir el panel (RF-16) | Ambos | Pendiente | | | |
| 2 | Enlace sin casilla (RF-16) | Enlace | Pendiente | | | |
| 3 | Casilla y sin `yt-dlp` (RF-16) | Enlace | Pendiente | | | |
| 4 | Descargar/subir y dividir (RF-16, RF-17) | Enlace o local | Pendiente | | | |
| 5 | Cancelar a mitad (RF-16.5) | Ambos | Pendiente | | | |
| 6 | Parrilla: aprobar 6 y aterrizar (RF-17, RF-20) | Ambos | Pendiente | | | |
| 7 | Cerrar la revisión (RF-20.4) | Ambos | Pendiente | | | |
| 8 | Reextraer y reutilizar (RF-20.3) | Ambos | Pendiente | | | |
| 9 | Galería: filtro, selección y generación (RF-12, RF-20) | Ambos | Pendiente | | | |
| 10 | Puntuar y automático (RF-18, RF-19) | Ambos | Pendiente | | | |
| 11 | Montar y orden (RF-19, RF-20) | Ambos | Pendiente | | | |
| 12 | Sin clave o proveedor caído (RF-18, RF-22) | Ambos | Pendiente | | | |
| 13 | Cierre: borrar usados (RF-14, RF-20.5) | Ambos | Pendiente | | | |

**Datos de la sesión**

| Campo | Valor |
| --- | --- |
| Fecha y hora | |
| Navegador y versión | |
| Sistema | |
| Commit | `d3cef77` |
| `yt-dlp` instalado | sí / no (versión) |
| Clave de IA configurada | sí / no (proveedor) |
| Clips iniciales en la galería | |
| Resultado global | Pendiente |

---

## 6. Registro de defectos

| # | Paso | Severidad | Qué pasó | Evidencia | Estado |
| --- | --- | --- | --- | --- | --- |
| — | — | — | Sin defectos registrados todavía | — | — |

No hay observaciones de alcance pendientes: la procedencia se retiró del alcance el
19-nov-2026 y la parrilla no enseña score por diseño (§0.1).

---

## 7. Criterio de cierre de la fase

1. Los 12 pasos (más el cierre del 13) en **Pasa**, o en **Falla** con defecto registrado y
   aceptado por escrito.
2. Ningún **Bloqueado** sin motivo documentado (por ejemplo, `yt-dlp` sin instalar: los pasos
   de enlace quedan bloqueados, pero el flujo se pasa entero en modo local).
3. Evidencia adjunta de los pasos 6, 7, 8 y 11 (aterrizaje, temporal borrado, reutilización y
   orden del vídeo).
4. Al pasar el checklist, actualizar:
   - `docs/plan/openRanks-plan.md` §13.4: marcar el checklist como pasado y con fecha.
   - La cabecera del plan y el estado de la Fase 3: quitar «checklist E2E pendiente».
   - `docs/rpd/openRanks-rpd.md` §4.4 y §5.5, solo si la sesión revela una decisión distinta
     (por ejemplo, la retención del temporal).
5. Si algo falla, no se cierra la fase: se corrige, se repite el paso y se re-ejecutan los
   pasos que dependan de él.

---

## 8. Anexo — verificación en disco

Con el panel parado o sin tocar archivos mientras corre, desde la raíz:

```bash
# Trabajos de extracción: no debe quedar ninguno tras cerrar la revisión
ls web/.jobs/extract/ 2>/dev/null

# Galería: conteo y entradas
ls web/.jobs/library/*.mp4 2>/dev/null | wc -l
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('web/.jobs/library.json','utf8'));console.log('items:',d.items.length);console.log('con score:',d.items.filter(i=>typeof i.score==='number').length)"

# Duplicados por SHA-256 (debe estar vacío)
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('web/.jobs/library.json','utf8'));const m=new Map();for(const i of d.items){if(!i.sha256)continue;m.set(i.sha256,(m.get(i.sha256)||0)+1)};console.log([...m].filter(([,n])=>n>1))"

# Reproducir el análisis del material (sin panel)
python -m openranks analyze --input demo/e2e-extract/compilado.mp4 \
  --out /tmp/f3-check --json --quiet \
  --ffmpeg "$(node -p "require('./web/node_modules/ffmpeg-static')")" \
  --ffprobe "$(node -p "require('./web/node_modules/ffprobe-static').path")"

# El ranking descargado
FP=$(node -p "require('./web/node_modules/ffprobe-static').path")
"$FP" -v error -show_entries stream=codec_type,width,height,pix_fmt,r_frame_rate \
  -of default=noprint_wrappers=1 web/.jobs/<id-del-trabajo>/render/ranking.mp4
```

El `id` del trabajo no se enseña en la interfaz (RF-9): usa la carpeta más reciente de
`web/.jobs/` o la que contenga `render/ranking.mp4`.

Si se hizo el respaldo de §2.4, al terminar:

```bash
mv web/.jobs web/.jobs.f3-e2e
mv web/.jobs.bak-2026-11-17 web/.jobs
```
