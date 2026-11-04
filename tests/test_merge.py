"""Fusión de la galería (2–4 clips): orden, lienzo común y audio continuo."""

from __future__ import annotations

import subprocess

import pytest

from openranks.merge import MergeError, merge_clips


def _clip(ffmpeg_bin, destination, *, color: str, seconds: float, size: str = "320x240", audio: bool = True):
    """Un clip sintético de color plano, con o sin audio."""
    argv = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c={color}:s={size}:r=30:d={seconds}",
    ]
    if audio:
        argv += [
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate=44100:duration={seconds}",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
        ]
    else:
        argv += ["-an"]
    argv += ["-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio:
        argv += ["-c:a", "aac", "-b:a", "64k"]
    argv += [str(destination)]
    subprocess.run(argv, check=True, capture_output=True)
    return destination


def _pixel(ffmpeg_bin, path, at_s: float) -> tuple[int, int, int]:
    """Color medio del fotograma de `at_s`, reducido a un píxel RGB."""
    completed = subprocess.run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{at_s:.3f}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    red, green, blue = completed.stdout[:3]
    return red, green, blue


def test_merge_respeta_el_orden_y_completa_el_silencio(tmp_path, ffmpeg_bin, ffprobe_bin):
    red = _clip(ffmpeg_bin, tmp_path / "rojo.mp4", color="red", seconds=1.5)
    # El segundo va en otro tamaño y sin audio: se centra en el lienzo y entra en silencio.
    blue = _clip(
        ffmpeg_bin,
        tmp_path / "azul.mp4",
        color="blue",
        seconds=1.0,
        size="640x360",
        audio=False,
    )

    result = merge_clips([red, blue], tmp_path / "fusion.mp4", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    assert abs(result.info.usable_duration_s - 2.5) <= 0.2
    assert result.info.has_audio, "el clip mudo entra con silencio"
    # El lienzo es el mayor de los dos: nada se recorta.
    assert (result.info.width, result.info.height) == (640, 360)

    first = _pixel(ffmpeg_bin, result.output, 0.5)
    second = _pixel(ffmpeg_bin, result.output, 2.0)
    assert first[0] > first[2], f"el primer tramo es el rojo: {first}"
    assert second[2] > second[0], f"el segundo tramo es el azul: {second}"


def test_merge_necesita_al_menos_dos_clips(tmp_path, ffmpeg_bin, ffprobe_bin):
    only = _clip(ffmpeg_bin, tmp_path / "uno.mp4", color="red", seconds=1)

    with pytest.raises(MergeError):
        merge_clips([only], tmp_path / "fusion.mp4", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)
