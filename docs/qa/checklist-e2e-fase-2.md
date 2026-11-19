# Checklist E2E — Fase 2 (galería y navegación)

| Campo | Valor |
| --- | --- |
| **Qué es** | Guía operativa del checklist E2E de §13.3 del plan, paso a paso y con el registro de resultados |
| **Fase** | Fase 2 — galería, selección ordenada, generación manual/automática, arrastre y borrado de usados |
| **Requisitos que cubre** | RF-10, RF-11, RF-12, RF-13, RF-14 y RF-15 |
| **Dónde vive el checklist original** | `docs/plan/openRanks-plan.md` §13.3 (esta guía no lo cambia: lo hace ejecutable) |
| **Estado del registro** | **Pendiente de ejecución** (ver §0) |
| **Fecha de preparación** | 17-nov-2026 |
| **Commit bajo prueba** | `d3cef77` (`fix api key`), rama `master` (esta guía no toca código: solo añade este documento) |

---

## 0. Estado del registro

**Todavía no hay resultados de la sesión de navegador.** Los 12 pasos requieren interacción
real con el panel y este entorno no tiene navegador disponible, así que la tabla de §5 llega
con todas las filas en **Pendiente**. No se anota ningún «Pasa» que no se haya observado.

Lo que **sí** está medido antes de la sesión (apoyo automático de §13.3):

| Comprobación | Comando | Resultado (17-nov-2026) |
| --- | --- | --- |
| Pruebas de la lógica pura y del contrato de la galería | `npm test` | **103/103 pasan**, 0 fallos (≈4,3 s) |
| Tipos del panel | `npm run typecheck` | **Sin errores** (`tsc --noEmit`, exit 0) |
| `pytest` y `npm run build` | — | **No ejecutados** en esta preparación |

Esas pruebas automáticas cubren la lógica (orden, renumeración, límites 5-10, intercambio de
puestos, contrato de la API), no la interfaz: el checklist de abajo es lo único que no se
puede automatizar.

---

## 1. Cómo se registra la sesión

1. **Una sola sesión de navegador**, de principio a fin: los pasos comparten estado (galería,
   montaje, selección). Si hay que reiniciar el panel, se anota en el paso donde ocurrió.
2. Cada paso se cierra con **un** estado: `Pasa`, `Falla`, `Bloqueado` (no se pudo ejecutar:
   falta clave, `yt-dlp`, material…) o `Pendiente`.
3. **Evidencia obligatoria** en `Falla` y recomendable en el resto: mensaje exacto en pantalla,
   texto del error de la consola/Red, o captura (`paso-08-intercambio.png`).
4. En **Notas** se apunta cualquier desviación del texto esperado, aunque el resultado sea el
   correcto (por ejemplo, un mensaje con otra redacción).
5. **No se arregla nada a mitad del checklist**: si un paso falla, se registra, se sigue con el
   siguiente si es posible, y se anota en §6.
6. Al terminar, se rellena §6 (defectos) y §7 (cierre) y se actualiza el estado en el plan.

Formato de la tabla de §5:

```
| # | Resultado | Evidencia | Notas | Fecha |
| 4 | Pasa      | —         | El tick del #1 tardó ~20 s | 17-nov-2026 |
```

---

## 2. Requisitos previos

### 2.1 Entorno

- **Node** y **Python 3.11+**. No hace falta venv: el panel resuelve el intérprete solo
  (§12.1 del plan).
- **FFmpeg**: lo aporta npm (`ffmpeg-static` + `ffprobe-static`); no hace falta en el `PATH`.
- Arranque:

```bash
npm run dev      # desde la raíz del repo
# → http://localhost:3000
```

- Si el panel ya estaba corriendo, reinícialo antes de empezar para que el estado inicial sea
  conocido.

### 2.2 Material de prueba

Hacen falta **11 clips** para poder tocar el máximo de 10 y quedarse con uno de sobra:

| Regla del motor | Valor | Por qué afecta al checklist |
| --- | --- | --- |
| Duración por clip | 1–30 s (`OPENRANKS_MIN/MAX_CLIP_SECONDS`) | Fuera de banda, el puesto no se prepara y no enciende el tick |
| Duración total del ranking | 30–58 s | Con 5 clips de 7 s salen 35 s: dentro de la banda |
| Lado corto mínimo | 240 px | Por debajo, el clip no llena el marco vertical |
| Audio | recomendable | Un clip sin audio recibe silencio; el ranking debe llevar pista |

**Recomendación: 11 clips de 7 s, verticales (720x1280), con audio.** 5 puestos = 35 s;
8 puestos = 56 s; el automático podrá elegir entre 5 y 8 sin pasarse de 58 s.

### 2.3 Estado limpio (opcional, con respaldo)

La galería y los trabajos viven en `web/.jobs/` (o en `OPENRANKS_JOBS_DIR`). Para que los
contadores de los pasos 2-6 sean fiables conviene empezar con la galería vacía:

```bash
mv web/.jobs web/.jobs.bak-2026-11-17     # con el panel parado
```

> **No borres `web/.jobs`**: contiene trabajos y clips reales. Al terminar la sesión, restaura
> con `mv web/.jobs.bak-2026-11-17 web/.jobs`. Si prefieres no tocar nada, ejecuta el checklist
> con la galería que haya y anota el conteo inicial en el paso 2.

### 2.4 Clave de IA (solo para el paso 12)

El paso 12 necesita **score**, y el score solo lo produce el LLM (P3-11). Antes de empezar:

- Menú → **Configuración** → guardar la clave de Claude o la de Gemini → **Guardar**.
- Sin clave, el paso 12 se registra como `Bloqueado` con el motivo, y el resto del checklist
  (pasos 1-11) no depende de ella.
- Si la clave está puesta pero el proveedor está caído, el paso 12b comprueba justamente el
  comportamiento sin score.

---

## 3. Preparar el material (una vez)

Genera los 11 clips con el FFmpeg que ya trae el panel:

```bash
FF=$(node -p "require('./web/node_modules/ffmpeg-static')")
mkdir -p demo/e2e-clips
for i in 01 02 03 04 05 06 07 08 09 10 11; do
  "$FF" -y \
    -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=7" \
    -f lavfi -i "sine=frequency=$((300 + 10#$i * 40))" \
    -t 7 -shortest \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
    "demo/e2e-clips/clip$i.mp4"
done
```

Comprobación rápida de uno de ellos:

```bash
FP=$(node -p "require('./web/node_modules/ffprobe-static').path")
"$FP" -v error -show_entries format=duration -of csv=p=0 demo/e2e-clips/clip01.mp4   # → 7.0
```

`demo/e2e-clips/` es material desechable de la sesión; no forma parte del producto.

---

## 4. Los 12 pasos

### Paso 1 — Menú lateral y navegación · RF-10

**Acciones**

1. Arranca el panel y abre `http://localhost:3000`.
2. Mira el menú lateral: **Montar ranking**, **Galería de videos**, **Divisor de escenas** y
   **Configuración**.
3. Comprueba que la sección activa está marcada (estilo y `aria-current="page"`).
4. Pulsa **Ocultar el menú lateral**: debe quedar una barra estrecha con el control **Menú**
   (etiquetado, no un icono mudo). Vuelve a desplegarlo.
5. Recorre el menú **solo con teclado**: `Tab` hasta cada sección y `Enter` para entrar.
6. Entra en Galería y vuelve a Montar.

**Esperado**

- [ ] Las cuatro secciones están a un clic y la activa está marcada.
- [ ] Retraído deja una barra con un control etiquetado que lo reabre.
- [ ] Todas las secciones se alcanzan y activan con teclado, con foco visible.
- [ ] Ir a la galería y volver no pierde el montaje (se confirma en el paso 7).

**Si falla, mira**: si el menú no aparece en pantalla estrecha, el control «Secciones · …»
debe desplegarlo; que la sección activa no se marque suele ser `aria-current` ausente.

---

### Paso 2 — Subir 3 clips, categoría y persistencia · RF-11

**Acciones**

1. Menú → **Galería de videos**.
2. Arrastra 3 clips al recuadro **«Arrastra los clips aquí»** o pulsa **Subir clips a la
   galería** y elígelos.
3. En **«¿Con qué categoría?»** escribe `Gatos` y pulsa **Subir**.
4. Espera el estado **«Subiendo X de 3…»**.
5. **Recarga la página** (`F5`) y vuelve a Galería.
6. Usa el filtro **«Filtrar la galería por categoría»** → `Gatos`.
7. Abre DevTools → Red y mira la respuesta de `/api/library` (y de la subida).

**Esperado**

- [ ] Aparecen 3 tarjetas con nombre original y duración; no con rutas ni ids internos.
- [ ] Tras recargar, siguen las 3 con la categoría «Gatos».
- [ ] El filtro «Gatos» muestra exactamente esas 3; «Todas las categorías» las muestra todas.
- [ ] Ninguna respuesta de la API contiene rutas del host (`C:\…`, `/home/…`).
- [ ] Anota el **conteo inicial** de clips de la galería: ______.

**Si falla, mira**: un formato no admitido debe fallar con mensaje legible; si la lista queda
vacía tras recargar, el problema está en `library.json`, no en la UI.

---

### Paso 3 — Cuatro seleccionados no bastan · RF-12

**Acciones**

1. Sube clips hasta tener al menos 5 en la galería (recomendado: los 11 de §3).
2. Selecciona **4** tarjetas con un clic.
3. Mira la barra inferior de la galería.

**Esperado**

- [ ] El resumen dice **«4 de 10 seleccionados. Faltan 1 para poder generar.»**
- [ ] **Generar manual** está deshabilitado.
- [ ] No se ha creado ningún trabajo nuevo (opcional: el número de carpetas de `web/.jobs`
      no cambia).

**Si falla, mira**: que el contador y el botón usen el mismo criterio (5-10); un botón activo
con 4 es un fallo de RF-12.2, no de estilo.

---

### Paso 4 — Quinto seleccionado y generación manual · RF-12

**Acciones**

1. Selecciona un 5.º clip.
2. Comprueba el resumen y pulsa **Generar manual**.
3. Si es el primer montaje de la sesión, **no** debe pedir confirmación.
4. Espera **«Preparando los clips…»** y el salto a **Montar ranking**.
5. Mira las casillas: deben ser 5, numeradas **#1…#5** en el orden de selección.
6. Espera a que cada casilla pase de spinner a **tick**.
7. Comprueba que **Montar el ranking** se habilita cuando todas tienen su tick.

**Esperado**

- [ ] El 5.º seleccionado habilita el botón y el resumen dice **«5 de 10 seleccionados. Listo
      para generar.»**
- [ ] Se generan exactamente 5 casillas y el **primer clip seleccionado ocupa el #1**.
- [ ] Cada casilla enciende su tick al prepararse; sin ticks no se puede montar.
- [ ] El selector de puestos sigue disponible después de generar.

**Si falla, mira**: si los ticks no llegan, revisa el detalle técnico del trabajo (FFmpeg,
duración fuera de banda, lado corto < 240 px).

---

### Paso 5 — Tope de 10 · RF-12

**Acciones**

1. Antes de este paso, asegúrate de tener **11 clips** en la galería (sube los que falten).
2. Selecciona tarjetas hasta llegar a **10**.
3. Intenta seleccionar la tarjeta restante (la 11.ª), con ratón y con teclado.

**Esperado**

- [ ] Con 10, el resumen dice **«10 de 10 seleccionados: has llegado al máximo. Para cambiar,
      deselecciona uno.»**
- [ ] La tarjeta 11 está deshabilitada y explica el máximo; el intento no altera la selección.
- [ ] El orden de selección se conserva y el contador no pasa de 10.

**Si falla, mira**: el tope se aplica en `toggleSelection` (lógica pura, ya probada en
`npm test`); si aquí falla, es la UI la que no refleja el estado.

---

### Paso 6 — Deseleccionar un puesto intermedio · RF-12

**Acciones**

1. Con 10 seleccionados, deselecciona el **4.º** de la selección (no el último).
2. Mira los números de las tarjetas y el contador.
3. Compara con el montaje del paso 4 (que sigue abierto con sus 5 puestos).

**Esperado**

- [ ] Los siguientes se renumeran sin huecos (#5 pasa a #4, etc.).
- [ ] El contador vuelve a 9 de 10 y el botón sigue habilitado.
- [ ] El montaje en curso **no cambia**: mismas 5 casillas y mismos ticks (la selección es de
      la galería; el trabajo no se toca hasta generar).

**Si falla, mira**: un hueco en la numeración o un puesto repetido es un fallo de RF-12.1.

---

### Paso 7 — Generar con un montaje en curso · RF-12

**Acciones**

1. Con el montaje del paso 4 abierto, selecciona 5 clips y pulsa **Generar manual**.
2. Lee la confirmación: **«Ya hay un montaje abierto: al generar se reemplazan sus puestos y
   sus clips, y el ranking anterior dejará de estar disponible. ¿Quieres continuar?»**
3. Pulsa **Cancelar**.
4. Vuelve a pulsar **Generar manual** y **Aceptar**.
5. Durante la preparación, ve a **Galería** y vuelve a **Montar ranking**.

**Esperado**

- [ ] Cancelar no crea ni modifica nada: mismas casillas, mismos ticks, misma selección,
      mismo vídeo (si lo había).
- [ ] Aceptar reemplaza las casillas y sus archivos `input/`/`render/` anteriores, prepara de
      nuevo y abre Montar con las casillas en el orden de selección.
- [ ] Ir a la galería y volver no pierde el montaje ni el progreso (RF-10).

**Si falla, mira**: si tras cancelar falta un clip de la galería o cambia un tick, el problema
está en el orden de las operaciones del servidor (`web/lib/library-import.ts`).

---

### Paso 8 — Arrastrar el #5 sobre el #1 · RF-13

**Acciones**

1. En **Montar ranking**, localiza el asa del borde izquierdo de cada casilla
   (`aria-label`: «Mover el puesto #N: arrastra o usa las flechas arriba y abajo»).
2. Arrastra el asa del **#5** y suéltala sobre el **#1** (la casilla destino se resalta:
   «Suelta para intercambiar con el #1»).
3. Repite el intercambio **con teclado**: foco en el asa y flechas `↑`/`↓`.
4. Vuelve a montar y comprueba el orden del vídeo resultante.

**Esperado**

- [ ] El #5 y el #1 intercambian su contenido y los números se actualizan.
- [ ] Los ticks siguen encendidos: los preparados se mueven con su clip, sin recodificar.
- [ ] Las flechas del asa producen el mismo intercambio.
- [ ] La unión/edición anterior deja de valer: no hay ranking descargable hasta volver a montar.
- [ ] El vídeo final sale en el nuevo orden (el #1 cierra).

**Si falla, mira**: si al intercambiar se apaga un tick, se está recodificando de más; si el
vídeo conserva el orden viejo, la unión no se invalidó.

---

### Paso 9 — Montar y descargar · RF-12 y P2-9

**Acciones**

1. Pulsa **Montar el ranking** (habilitado con todos los ticks y sin problemas).
2. Sigue el progreso: fase con nombre humano, porcentaje medido y ETA.
3. Al terminar, mira **Resultado** y reproduce el vídeo.
4. Pulsa **Descargar el ranking (X MB)** y abre el archivo descargado.
5. Pulsa **Descargar sin edición (X MB)** y compáralo con el anterior.
6. Opcional, con `ffprobe`: resolución, fps, `pix_fmt`, pista de audio.

**Esperado**

- [ ] Aviso **«Tu ranking está listo. Se reproduce en 9:16 y ya lleva la edición.»**
- [ ] El vídeo se reproduce en vertical, con título, escalera, rótulos y el #1 al final.
- [ ] El ranking descargado se reproduce igual que el de la vista previa.
- [ ] La descarga sin edición **no** lleva overlay (P2-9) y el ranking sigue siendo el
      entregable principal.
- [ ] `ffprobe`: 1080x1920, 30 fps, `yuv420p`, audio presente.

**Si falla, mira**: si «Montar» está deshabilitado con todos los ticks, revisa el aviso de
problemas (duración total fuera de 30-58 s, clip fuera de banda).

---

### Paso 10 — Borrar usados: cancelar · RF-14

**Acciones**

1. Con el ranking listo, pulsa **Borrar videos utilizados** (rojo difuminado; solo aparece con
   un ranking correcto).
2. Lee la confirmación: **«Se eliminarán N clips de la galería y se vaciarán las casillas. El
   ranking ya montado no se toca. Esta acción no se puede deshacer. ¿Quieres continuar?»**
3. Pulsa **Cancelar**.
4. Vuelve a la galería y cuenta los clips; mira casillas, ticks y descarga.

**Esperado**

- [ ] Cancelar no borra ningún archivo ni limpia ninguna casilla.
- [ ] La galería conserva los mismos clips y la misma selección.
- [ ] El ranking sigue descargándose y reproduciéndose.

**Si falla, mira**: si el botón borra sin confirmar, es un fallo de RF-14 (bloqueante).

---

### Paso 11 — Borrar usados: confirmar · RF-14

**Acciones**

1. Pulsa de nuevo **Borrar videos utilizados** y **Aceptar**.
2. Vuelve a la galería y cuenta los clips restantes.
3. Mira las casillas del montaje y descarga el ranking otra vez.
4. En disco (§8), cuenta los archivos de `library/` y las entradas de `library.json`.

**Esperado**

- [ ] Desaparecen de la galería y del disco **exactamente los N clips usados**; quedan los
      demás (11 − N).
- [ ] Las casillas quedan **vacías** y sin ticks.
- [ ] El `ranking.mp4` sigue disponible y descargable.
- [ ] No se toca ningún otro clip, ningún otro trabajo ni `render/`.

**Si falla, mira**: un clip de más borrado suele ser un puesto que perdió su id de galería tras
el arrastre (paso 8); anótalo con el nombre del clip.

---

### Paso 12 — Generar automático por score · RF-15

**12a. Con clave configurada**

1. Menú → **Configuración** → guarda la clave de Claude o Gemini (si aún no lo hiciste) →
   **Guardar**.
2. Galería → **Puntuar galería**.
3. En el diálogo **Puntuar la galería**, deja **«Solo los no puntuados»**, revisa los
   «Se puntúa»/«Se respeta» y pulsa **Puntuar N clips**.
4. Lee el informe **«Galería puntuada · umbral 55»**: score y título (≤24 caracteres) por
   clip, veredicto «Se queda»/«No pasa». **No borres** nada: cierra con **Cerrar**.
5. Pulsa **Generar automático**.

**Esperado**

- [ ] El informe da score 0-100 y un título corto y editable por clip; no hay razones.
- [ ] «Generar automático» abre **«Propuesta automática · N clips»** con #1…#N, el motivo de
      cada clip y el total de duración.
- [ ] **Descartar** no cambia nada.
- [ ] **Generar con esta selección** importa y prepara con el mismo camino que el manual:
      casillas, orden y ticks
      equivalentes, con el **#1 = mayor score**.
- [ ] La propuesta elige entre **5 y 10**, no repite clip y el total cae en **30-58 s**.
- [ ] En reproducción el vídeo abre con el clip más flojo y cierra con el mejor.

**12b. Sin clave (o proveedor caído)**

- [ ] **Puntuar galería** falla con un mensaje accionable que lleva a **Configuración**.
- [ ] **Generar automático** está deshabilitado y explica el motivo: **«Necesitas al menos 5
      clips con score y duración medida para usar el automático; hay N.»**
- [ ] **Generar manual** sigue funcionando igual.

**Si falla, mira**: si los scores se inventan sin clave, es un fallo grave de RF-18; si el
automático elige más de 10 o menos de 5, es RF-19.

---

## 5. Tabla de resultados

Estado inicial: **Pendiente** en todos los pasos. Se rellenan durante la sesión (§1).

| # | Paso (RF) | Resultado | Evidencia | Notas | Fecha |
| --- | --- | --- | --- | --- | --- |
| 1 | Menú lateral y navegación (RF-10) | Pendiente | | | |
| 2 | Subir 3, categoría y persistencia (RF-11) | Pendiente | | | |
| 3 | Cuatro seleccionados no bastan (RF-12) | Pendiente | | | |
| 4 | Quinto y generación manual (RF-12) | Pendiente | | | |
| 5 | Tope de 10 (RF-12) | Pendiente | | | |
| 6 | Deseleccionar un puesto intermedio (RF-12) | Pendiente | | | |
| 7 | Generar con montaje en curso (RF-12) | Pendiente | | | |
| 8 | Arrastrar #5 sobre #1 (RF-13) | Pendiente | | | |
| 9 | Montar y descargar (RF-12, P2-9) | Pendiente | | | |
| 10 | Borrar usados: cancelar (RF-14) | Pendiente | | | |
| 11 | Borrar usados: confirmar (RF-14) | Pendiente | | | |
| 12 | Generar automático (RF-15) | Pendiente | | | |

**Datos de la sesión**

| Campo | Valor |
| --- | --- |
| Fecha y hora | |
| Navegador y versión | |
| Sistema | |
| Commit | `d3cef77` |
| Clips iniciales en la galería | |
| Clave de IA configurada | sí / no |
| Resultado global | Pendiente |

---

## 6. Registro de defectos

| # | Paso | Severidad | Qué pasó | Evidencia | Estado |
| --- | --- | --- | --- | --- | --- |
| — | — | — | Sin defectos registrados todavía | — | — |

Severidad: **Bloqueante** (impide cerrar la fase), **Mayor** (RF incumplido con rodeo),
**Menor** (texto, foco, estilo).

---

## 7. Criterio de cierre de la fase

1. Los 12 pasos en **Pasa**, o en **Falla** con defecto registrado y aceptado por escrito.
2. Ningún **Bloqueado** sin motivo documentado (por ejemplo, sin clave de IA en el paso 12).
3. Evidencia adjunta de los pasos 8, 9 y 11 (orden, vídeo y borrado exacto).
4. Al pasar el checklist, actualizar:
   - `docs/plan/openRanks-plan.md` §13.3: marcar el checklist como pasado y con fecha.
   - La cabecera del plan y el estado de la Fase 2 / P2-8: quitar «checklist E2E manual
     pendiente».
   - `docs/rpd/openRanks-rpd.md`, solo si la sesión revela que una decisión cambió (no se
     reabre el estilo ni el alcance por un defecto).
5. Si algo falla, **no** se cierra la fase: se corrige, se vuelve a pasar el paso afectado y se
   re-ejecutan los pasos que dependan de él.

---

## 8. Anexo — verificación en disco

Con el panel parado (o con cuidado de no tocar archivos mientras corre), desde la raíz:

```bash
# Cuántos clips hay en la galería y cuántas entradas en el índice
ls web/.jobs/library/*.mp4 2>/dev/null | wc -l
node -e "const fs=require('fs');const p='web/.jobs/library.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));console.log(d.items.length)"

# Archivos del trabajo del ranking
ls web/.jobs/<id-del-trabajo>/
ls web/.jobs/<id-del-trabajo>/render/

# El ranking que se descarga
FP=$(node -p "require('./web/node_modules/ffprobe-static').path")
"$FP" -v error -show_entries stream=codec_type,width,height,pix_fmt,r_frame_rate \
  -of default=noprint_wrappers=1 web/.jobs/<id-del-trabajo>/render/ranking.mp4
```

El `id` del trabajo no se enseña en la interfaz (RF-9): para localizarlo, usa la carpeta más
reciente de `web/.jobs/` o la que contenga `render/ranking.mp4`.

Si se hizo el respaldo de §2.3, al terminar:

```bash
mv web/.jobs web/.jobs.e2e          # guarda la sesión
mv web/.jobs.bak-2026-11-17 web/.jobs
```
