# Set dorado del score (F3 · P3-8)

El set con el que se mide la promesa de RF-18: el score de 0 a 100 **correlaciona con el
orden que le da una persona** (Spearman ≥ 0,6) y el LLM cuesta **≤ 0,002 USD por trabajo de
10 clips**. Sin clave no se puede evaluar: no hay score heurístico de respaldo.

## Cómo se usa

```bash
python scripts/evaluate_score.py --build      # genera los clips que falten (FFmpeg)
python scripts/evaluate_score.py              # informe legible
python scripts/evaluate_score.py --json       # lo mismo, para máquinas
python scripts/evaluate_score.py --min-spearman 0.6   # falla si no llega
```

La evaluación puntúa cada clip con `openranks rate` (el mismo LLM que «Puntuar galería»),
lo compara con `human_rank` y resume Spearman, p95 por clip y coste estimado con los precios
del RPD §7.9. **Necesita una clave de LLM**: desde P3-11 no hay respaldo heurístico y el
script no inventa scores. Sin clave, falla con un mensaje legible antes de llamar al proveedor.

## Qué hay hoy

`golden.json` trae **seis clips generados por el propio proyecto** con FFmpeg (CC0), con
un orden humano fijado antes de medir: el clip con movimiento y audio fuerte arriba, los
planos sin nada abajo. Es el set de partida reproducible: sirve para medir la correlación
del score del LLM y detectar regresiones cuando se cambia de modelo o de prompt.

## Cómo se sustituye por material real

1. Copia los clips a esta carpeta (o a una subcarpeta) con material **propio o
   licenciado**, sin datos personales de terceros (RPD §11.7).
2. Añade una entrada por clip a `golden.json` con `id`, `file` y `human_rank`
   (`1` = el mejor), sin recetas si el archivo ya existe.
3. Fija el orden **antes** de mirar los scores; después se ejecuta el script y se anota el
   resultado en la documentación de la fase.
4. Amplía el set, no lo retoques para subir la correlación: si un cambio de pesos mejora
   el set pero empeora el criterio editorial, se revisa el RPD, no la métrica.

El manifiesto se valida: versión, al menos dos clips, `id` únicos, `human_rank` entero,
positivo y **sin repetir**, y `file` presente. Un error de formato sale con mensaje y
código 2, sin tocar el set.
