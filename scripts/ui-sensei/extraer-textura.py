#!/usr/bin/env python3
"""Extrae una pieza del despiece del reactor como textura con alfa.

    python3 scripts/ui-sensei/extraer-textura.py <despiece.jpg> <salida.png> x0,y0,x1,y1 [--recorte-al-contenido]
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
    parser.add_argument("regiona", help="x0,y0,x1,y1")
    parser.add_argument("--umbral", type=float, default=0.10)
    parser.add_argument("--recorte", action="store_true", help="recorta al contenido")
    parser.add_argument("--opaco", action="store_true", help="compone el alfa sobre metal (para mapas)")
    parser.add_argument("--metal", default="#20262e", help="color de fondo al componer")
    args = parser.parse_args()

    rgb = decodificar(args.entrada).astype(np.float32)
    x0, y0, x1, y1 = (int(v) for v in args.regiona.split(","))
    trozo = rgb[y0:y1, x0:x1]
    luma = trozo.mean(axis=2) / 255
    alfa = np.clip((luma - args.umbral) / 0.45, 0, 1)
    if args.recorte:
        ys, xs = np.where(alfa > 0.04)
        if ys.size:
            trozo = trozo[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
            alfa = alfa[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]
    if args.opaco:
        # Para usar como `map` de un material: el alfa se compone sobre el
        # color del metal, así no salen agujeros ni se transparenta la pieza.
        hexa = args.metal.lstrip("#")
        base = np.array([int(hexa[i : i + 2], 16) for i in (0, 2, 4)], np.float32)
        rgb_out = np.clip(trozo * alfa[..., None] + base * (1 - alfa[..., None]), 0, 255).astype(np.uint8)
        escribir_png(np.dstack([rgb_out, np.full(rgb_out.shape[:2], 255, np.uint8)]), args.salida)
    else:
        escribir_png(a_rgba_con_alfa(np.clip(trozo, 0, 255).astype(np.uint8), alfa), args.salida)
    print(f"{args.salida} · {trozo.shape[1]}x{trozo.shape[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(principal())
