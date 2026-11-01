"""Inspección de medios con ffprobe: parseo puro + validación de "clip ya listo"."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Config


@dataclass(frozen=True)
class Check:
    """Resultado de una validación: errores (abortan) y avisos (se registran)."""

    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.errors


@dataclass(frozen=True)
class MediaInfo:
    """Lo que necesitamos saber de un archivo de vídeo."""

    path: Path
    duration_s: float
    width: int | None
    height: int | None
    fps: float | None
    video_codec: str | None
    pix_fmt: str | None
    audio_codec: str | None
    sample_rate: int | None
    channels: int | None
    size_bytes: int
    video_duration_s: float | None = None
    nb_frames: int | None = None
    nominal_fps: float | None = None
    # Rotación de la matriz de visualización (0, 90, 180, 270) y tamaño que ve el
    # reproductor. `width`/`height` son los codificados: no cambian con la rotación.
    rotation: int = 0
    display_width: int | None = None
    display_height: int | None = None

    @property
    def has_audio(self) -> bool:
        return self.audio_codec is not None

    @property
    def usable_duration_s(self) -> float:
        """Duración del **vídeo**: es la que manda para fotogramas y cortes.

        El contenedor puede ser más largo que el vídeo (cola de audio), y unir por
        duración de contenedor arrastraba ese sobrante a cada corte.
        """
        return self.video_duration_s if self.video_duration_s else self.duration_s

    @property
    def short_side(self) -> int:
        sides = [side for side in (self.width, self.height) if side]
        return min(sides) if len(sides) == 2 else 0

    @property
    def visible_size(self) -> tuple[int | None, int | None]:
        """Tamaño después de aplicar la rotación; es el que ve el reproductor."""
        return (self.display_width or self.width, self.display_height or self.height)

    def to_source_entry(self, *, position: int, sha256: str) -> dict:
        """Entrada del manifiesto. Solo el **nombre** del archivo: regla de repo público."""
        return {
            "position": position,
            "file": self.path.name,
            "sha256": sha256,
            "bytes": self.size_bytes,
            "duration_s": round(self.duration_s, 3),
            "width": self.width,
            "height": self.height,
            "fps": None if self.fps is None else round(self.fps, 3),
            "nominal_fps": None if self.nominal_fps is None else round(self.nominal_fps, 3),
            "nb_frames": self.nb_frames,
            "rotation": self.rotation,
            "display_width": self.display_width or self.width,
            "display_height": self.display_height or self.height,
            "video_codec": self.video_codec,
            "pix_fmt": self.pix_fmt,
            "has_audio": self.has_audio,
        }


def _parse_fraction(raw: str | None) -> float | None:
    """``"30000/1001"`` → 29.97. Devuelve ``None`` si no es interpretable."""
    if not raw:
        return None
    text = raw.strip()
    if "/" in text:
        numerator, _, denominator = text.partition("/")
        try:
            num, den = float(numerator), float(denominator)
        except ValueError:
            return None
        return None if den == 0 else num / den
    try:
        return float(text)
    except ValueError:
        return None


def _parse_float(raw: object) -> float | None:
    try:
        return float(str(raw))
    except (TypeError, ValueError):
        return None


def _parse_int(raw: object) -> int | None:
    try:
        return int(str(raw))
    except (TypeError, ValueError):
        return None


def _parse_rotation(video: dict) -> int:
    """Rotación de visualización, normalizada a 0/90/180/270.

    ffprobe la publica en ``side_data_list[].rotation`` (a veces negativa) y, en
    archivos antiguos, en ``tags.rotate``. Se prefiere la side data.
    """
    raw_values: list[object] = []
    for item in video.get("side_data_list") or []:
        if isinstance(item, dict) and item.get("rotation") is not None:
            raw_values.append(item["rotation"])
    tags = video.get("tags") or {}
    if isinstance(tags, dict) and tags.get("rotate") is not None:
        raw_values.append(tags["rotate"])
    for raw in raw_values:
        try:
            return int(round(float(raw))) % 360
        except (TypeError, ValueError):
            continue
    return 0


def parse_probe(path: Path, payload: dict) -> MediaInfo:
    """Convierte la salida JSON de ffprobe en ``MediaInfo`` (función pura)."""
    fmt = payload.get("format") or {}
    streams = payload.get("streams") or []

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = _parse_float(fmt.get("duration"))
    if duration is None and video is not None:
        duration = _parse_float(video.get("duration"))
    if duration is None:
        # Algunos contenedores solo publican la duración por stream (p. ej. tags).
        duration = _parse_float((fmt.get("tags") or {}).get("DURATION"))

    fps = None
    if video is not None:
        fps = _parse_fraction(video.get("avg_frame_rate")) or _parse_fraction(video.get("r_frame_rate"))

    width = _parse_int(video.get("width")) if video else None
    height = _parse_int(video.get("height")) if video else None
    rotation = _parse_rotation(video) if video else 0
    if width and height and rotation in (90, 270):
        display_width, display_height = height, width
    else:
        display_width, display_height = width, height

    return MediaInfo(
        path=path,
        duration_s=0.0 if duration is None else duration,
        width=width,
        height=height,
        fps=fps,
        video_codec=video.get("codec_name") if video else None,
        pix_fmt=video.get("pix_fmt") if video else None,
        audio_codec=audio.get("codec_name") if audio else None,
        sample_rate=_parse_int(audio.get("sample_rate")) if audio else None,
        channels=_parse_int(audio.get("channels")) if audio else None,
        size_bytes=_parse_int(fmt.get("size")) or 0,
        video_duration_s=_parse_float(video.get("duration")) if video else None,
        nb_frames=_parse_int(video.get("nb_frames")) if video else None,
        nominal_fps=_parse_fraction(video.get("r_frame_rate")) if video else None,
        rotation=rotation,
        display_width=display_width,
        display_height=display_height,
    )


def probe_tool_argv(ffprobe_bin: str, path: Path) -> list[str]:
    return [
        ffprobe_bin,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]


def probe(ffprobe_bin: str, path: Path, *, timeout_s: int = 120) -> MediaInfo:
    """Ejecuta ffprobe y devuelve el ``MediaInfo`` del archivo."""
    completed = subprocess.run(  # noqa: S603 - argv sin shell, binario resuelto por el llamador
        probe_tool_argv(ffprobe_bin, path),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_s,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"ffprobe falló para {path.name}: {completed.stderr.strip()[:400]}")
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:  # pragma: no cover - defensivo
        raise RuntimeError(f"ffprobe no devolvió JSON para {path.name}") from exc
    return parse_probe(path, payload)


def validate_ready_clip(info: MediaInfo, config: Config) -> Check:
    """Valida una fuente de entrada: es un clip publicable tal cual (§12, L1).

    Un clip sin audio **no** se rechaza: se le inyecta silencio en la normalización,
    que es lo que pide el criterio de salida ("audio presente").
    """
    errors: list[str] = []
    warnings: list[str] = []

    if not info.video_codec:
        errors.append("no tiene pista de vídeo")
    if info.duration_s <= 0:
        errors.append("duración desconocida o cero")
    elif info.duration_s < config.min_clip_seconds:
        errors.append(f"dura {info.duration_s:.2f}s; el mínimo por clip es {config.min_clip_seconds}s")
    elif info.duration_s > config.max_clip_seconds:
        errors.append(f"dura {info.duration_s:.2f}s; el máximo por clip es {config.max_clip_seconds}s")

    if info.video_codec and info.short_side < config.min_short_side_px:
        errors.append(
            f"lado corto {info.short_side}px; por debajo de {config.min_short_side_px}px no llena el marco vertical"
        )

    if not info.has_audio:
        warnings.append("sin pista de audio: se inyecta silencio para poder unir")

    return Check(errors=tuple(errors), warnings=tuple(warnings))


def validate_normalized(info: MediaInfo, config: Config, *, fps_tolerance: float = 0.05) -> Check:
    """Valida un clip ya normalizado contra el formato de salida de L1."""
    errors: list[str] = []
    warnings: list[str] = []

    if not info.video_codec:
        errors.append("no tiene pista de vídeo")
    if (info.width, info.height) != config.total:
        errors.append(f"mide {info.width}x{info.height}; se esperaba {config.target_width}x{config.target_height}")

    # El contrato es la tasa **declarada** (CFR). La media puede desviarse cuando el
    # contenedor arrastra padding o cuando la fuente era VFR: eso se avisa, no se rechaza.
    nominal = info.nominal_fps if info.nominal_fps is not None else info.fps
    if nominal is None or abs(nominal - config.fps) > fps_tolerance:
        errors.append(f"va a {nominal} fps; se esperaba {config.fps}")
    elif info.fps is not None and abs(info.fps - nominal) > nominal * 0.01:
        warnings.append(
            f"la tasa media ({info.fps:.3f}) se desvía de la declarada ({nominal:.3f}): "
            "padding del contenedor o flujo VFR"
        )
    if info.pix_fmt != config.pix_fmt:
        errors.append(f"pixel format {info.pix_fmt}; se esperaba {config.pix_fmt}")
    if not info.has_audio:
        errors.append("sin pista de audio")

    return Check(errors=tuple(errors), warnings=tuple(warnings))
