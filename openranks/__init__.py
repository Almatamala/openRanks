"""openRanks — ensamblador de L1 y editor de L2 (§12 del plan).

L1 entrega, a partir de 5 a 10 clips ya listos:

* los clips normalizados (1080x1920, 30 fps, yuv420p, audio a −14 LUFS), y
* su unión en un solo vídeo vertical ``union.mp4``.

L2 compone encima la edición del estándar y deja ``ranking.mp4``.

Regla dura del producto (ADR-8): lo único editable es texto (título del vídeo,
subtítulo opcional y nombre de cada puesto) y el render es siempre automático.
"""

from __future__ import annotations

TOOL_VERSION = "0.1.0"

__all__ = ["TOOL_VERSION"]
