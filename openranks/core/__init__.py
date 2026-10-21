"""Núcleo de decisiones de openRanks.

Todo este paquete es **stdlib puro**: se testea sin FFmpeg, sin torch y sin red
(§7.6 del RPD). Los comandos de FFmpeg se construyen aquí y se ejecutan fuera.
"""

from __future__ import annotations
