"""Configuración de L1, toda por entorno con prefijo ``OPENRANKS_`` (§17.1 del RPD)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return default if raw in (None, "") else int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return default if raw in (None, "") else float(raw)


def _env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return default if raw in (None, "") else raw


@dataclass(frozen=True)
class Config:
    """Parámetros del ensamblado.

    Los valores de formato son los del criterio de salida de L1 (§12):
    1080x1920, 30 fps, yuv420p, audio a −14 LUFS.
    """

    # Cuántos puestos tiene el ranking. El formato va del TOP 5 al TOP 10 y el panel
    # lo fija por trabajo (`OPENRANKS_ITEMS`); el defecto es el TOP 5 de siempre.
    items: int = 5
    items_min: int = 5
    items_max: int = 10

    # Formato de salida.
    target_width: int = 1080
    target_height: int = 1920
    fps: int = 30
    # Cómo encaja un clip en el marco vertical. `auto` (por defecto) detecta el área
    # útil de un clip horizontal con fondo borroso y la recorta; si no hay evidencia,
    # rellena con negro. `band` agranda hasta llenar una banda central de 1080x1184
    # (~62 % del alto) recortando **laterales** y nunca arriba/abajo; `contain` no
    # recorta nada y `cover` recorta para llenar los 1080x1920 enteros.
    fit: str = "auto"
    video_codec: str = "libx264"
    crf: int = 19
    preset: str = "medium"
    pix_fmt: str = "yuv420p"

    # Audio.
    audio_codec: str = "aac"
    audio_bitrate: str = "192k"
    sample_rate: int = 48000
    channels: int = 2
    loudness_lufs: float = -14.0
    true_peak_db: float = -1.0
    loudness_range: float = 11.0

    # Bandas de duración (§RF-2 y criterio de L1).
    min_clip_seconds: float = 1.0
    max_clip_seconds: float = 30.0
    min_total_seconds: float = 30.0
    max_total_seconds: float = 58.0
    # Techo duro de plataforma: por encima de esto se aborta en vez de avisar.
    hard_max_total_seconds: float = 60.0

    # Límites del texto editable (§9.5). Si el texto no cabe, el que falla es el input.
    title_layer_chars: int = 40
    # Renglones en los que `fit_title` puede repartir el título (no "capas" de texto:
    # el título es una sola cadena con marcas de color).
    title_lines_max: int = 3
    label_chars: int = 24

    # Un clip por debajo de este lado corto no puede llenar el marco con calidad.
    min_short_side_px: int = 240

    @property
    def total(self) -> tuple[int, int]:
        return (self.target_width, self.target_height)

    def to_manifest(self) -> dict:
        """Solo lo que afecta al resultado (para poder reproducirlo)."""
        return {
            "items": self.items,
            "target": f"{self.target_width}x{self.target_height}",
            "fit": self.fit,
            "fps": self.fps,
            "video": {"codec": self.video_codec, "crf": self.crf, "preset": self.preset, "pix_fmt": self.pix_fmt},
            "audio": {
                "codec": self.audio_codec,
                "bitrate": self.audio_bitrate,
                "sample_rate": self.sample_rate,
                "channels": self.channels,
                "loudness_lufs": self.loudness_lufs,
                "true_peak_db": self.true_peak_db,
                "loudness_range": self.loudness_range,
            },
            "bands": {
                "clip_seconds": [self.min_clip_seconds, self.max_clip_seconds],
                "total_seconds": [self.min_total_seconds, self.max_total_seconds],
            },
        }

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            items=_env_int("OPENRANKS_ITEMS", cls.items),
            target_width=_env_int("OPENRANKS_WIDTH", cls.target_width),
            target_height=_env_int("OPENRANKS_HEIGHT", cls.target_height),
            fps=_env_int("OPENRANKS_FPS", cls.fps),
            fit=_env_str("OPENRANKS_FIT", cls.fit),
            crf=_env_int("OPENRANKS_CRF", cls.crf),
            preset=_env_str("OPENRANKS_PRESET", cls.preset),
            audio_bitrate=_env_str("OPENRANKS_AUDIO_BITRATE", cls.audio_bitrate),
            sample_rate=_env_int("OPENRANKS_SAMPLE_RATE", cls.sample_rate),
            loudness_lufs=_env_float("OPENRANKS_LOUDNESS_LUFS", cls.loudness_lufs),
            min_clip_seconds=_env_float("OPENRANKS_MIN_CLIP_SECONDS", cls.min_clip_seconds),
            max_clip_seconds=_env_float("OPENRANKS_MAX_CLIP_SECONDS", cls.max_clip_seconds),
            min_total_seconds=_env_float("OPENRANKS_MIN_TOTAL_SECONDS", cls.min_total_seconds),
            max_total_seconds=_env_float("OPENRANKS_MAX_TOTAL_SECONDS", cls.max_total_seconds),
        )
