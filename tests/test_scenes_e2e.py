"""Integración del divisor de escenas: corte exacto, destellos y fundidos.

Un plano con una pausa de audio en medio sigue siendo **una** escena; un cambio de imagen
crea un corte exacto en el fotograma donde cambia la imagen; un fogonazo no parte la escena
y un fundido a negro no se cuela dentro de un clip.
"""

from __future__ import annotations

import subprocess

from openranks.scenes import analyze


def _two_scenes_with_an_audio_gap(ffmpeg_bin, destination):
    """4 s: plano rojo y plano azul con un corte real en 2 s; el audio tiene un hueco."""
    subprocess.run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=320x240:r=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x240:r=30:d=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=0:enable='between(t,0.5,1.5)'[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-t",
            "4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            str(destination),
        ],
        check=True,
        capture_output=True,
    )
    return destination


def _encode(ffmpeg_bin, destination, inputs, filter_complex):
    """Codifica un vídeo mudo a partir de varias entradas `lavfi` concatenadas."""
    argv = [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y"]
    for lavfi in inputs:
        argv += ["-f", "lavfi", "-i", lavfi]
    argv += [
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        str(destination),
    ]
    subprocess.run(argv, check=True, capture_output=True)
    return destination


def test_the_cut_falls_exactly_on_the_image_change(tmp_path, ffmpeg_bin, ffprobe_bin):
    source = _two_scenes_with_an_audio_gap(ffmpeg_bin, tmp_path / "compilado.mp4")

    result = analyze(source, tmp_path / "analysis", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    assert len(result.candidates) == 2, "un corte de imagen produce dos escenas"
    # Un fotograma de tolerancia (30 fps) y **sin** margen añadido: el corte cae en 2 s.
    assert abs(result.candidates[0].end_s - 2.0) <= 1 / 30
    assert result.candidates[1].start_s == result.candidates[0].end_s
    # Nada de audio en el análisis: `extract.json` guarda imagen, negros y fundidos.
    assert set(result.to_manifest()["detection"]) == {"scene_cuts", "black_spans", "fade_spans"}


def test_a_flash_does_not_split_the_scene(tmp_path, ffmpeg_bin, ffprobe_bin):
    # Un fogonazo de tres fotogramas entre dos planos rojos: son un solo plano.
    source = _encode(
        ffmpeg_bin,
        tmp_path / "destello.mp4",
        [
            "color=c=red:s=320x240:r=30:d=2",
            "color=c=white:s=320x240:r=30:d=0.1",
            "color=c=red:s=320x240:r=30:d=2",
        ],
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    )

    result = analyze(source, tmp_path / "analysis-flash", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    assert len(result.candidates) == 1, "un destello no es una escena"


def test_a_fade_to_black_is_a_boundary_and_not_part_of_a_clip(tmp_path, ffmpeg_bin, ffprobe_bin):
    # 2,5 s de rojo que se funde a negro en los últimos 0,5 s, 0,5 s de negro y 2 s azules.
    source = _encode(
        ffmpeg_bin,
        tmp_path / "fundido.mp4",
        [
            "color=c=red:s=320x240:r=30:d=2.5",
            "color=c=black:s=320x240:r=30:d=0.5",
            "color=c=blue:s=320x240:r=30:d=2",
        ],
        "[0:v]fade=t=out:st=2:d=0.5[v0];[v0][1:v][2:v]concat=n=3:v=1:a=0[v]",
    )

    result = analyze(source, tmp_path / "analysis-fade", ffmpeg=ffmpeg_bin, ffprobe=ffprobe_bin)

    assert len(result.candidates) == 2, "el negro del fundido no es un candidato"
    # El primer clip acaba donde empieza el fundido, no en mitad del negro.
    assert 2.1 <= result.candidates[0].end_s <= 2.6
    # El segundo arranca cuando vuelve la imagen, en 3 s.
    assert abs(result.candidates[1].start_s - 3.0) <= 0.12
    assert result.to_manifest()["detection"]["fade_spans"], "el fundido queda en extract.json"
