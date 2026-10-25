#!/usr/bin/env python3
"""Recorta una pieza del reactor sobre fondo blanco y le pone alfa real.

El fondo blanco se convierte en transparencia usando la luminancia: lo oscuro
(opaco) se queda, lo blanco (el fondo) desaparece. El resultado es un PNG que
se puede superponer y girar como una capa del núcleo.

    python3 scripts/ui-sensei/recortar-pieza.py <entrada> <salida.png> [--recorte x,y,w,h]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagen import a_rgba_con_alfa, decodificar, escribir_png  # noqa: E402


def principal() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("entrada", type=Path)
    parser.add_argument("salida", type=Path)
    parser.add_argument("--recorte", default="", help="x,y,w,h en píxeles")
    parser.add_argument("--umbral", type=float, default=0.86, help="luminosidad a partir de la cual es fondo")
    args = parser.parse_args()

    rgb = decodificar(args.entrada).astype(np.float32)
    if args.recorte:
        x, y, w, h = (int(v) for v in args.recorte.split(","))
        rgb = rgb[y : y + h, x : x + w]
    luma = rgb.mean(axis=2) / 255.0
    alfa = np.clip((args.umbral - luma) / max(1e-6, args.umbral - 0.05), 0, 1)
    # Se recorta elbox exterior transparente.
    ys, xs = np.where(alfa > 0.02)
    if ys.size:
        rgb = rgb[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
        alfa = alfa[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    escribir_png(a_rgba_con_alfa(rgb.astype(np.uint8), alfa), args.salida)
    print(f"{args.salida} · {rgb.shape[1]}x{rgb.shape[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
