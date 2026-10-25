#!/usr/bin/env python3
"""Mide el eje óptico de las piezas del núcleo ARC.

El núcleo se monta como un bloque: todas las capas comparten el mismo centro
X,Y. Para que eso sea cierto, el eje de cada pieza (el centro real de su
geometría) tiene que estar MEDIDO, no supuesto.

Dos métodos independientes:

  · `rasgos`  — el centro de los rasgos repetidos y simétricos (LED, módulos).
    Es el método fiable: esos rasgos no dependen de la luz, así que el centro
    de la circunferencia que forman es el eje mecánico de la pieza.
  · `elipse`  — el centro de la elipse que mejor encaja en la silueta opaca.
    Sirve de contraste: si ambos métodos coinciden, la medida es de fiar.

    python3 scripts/ui-sensei/medir-ensamblaje.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from png_rgba import leer_png  # noqa: E402

PIEZAS = (
    Path(__file__).resolve().parent.parent.parent
    / "apps/web/public/assets/jarvis/reactor"
)


# ── Utilidades de máscara ────────────────────────────────────────────────────

def etiquetas(mascara: np.ndarray) -> np.ndarray:
    """Etiquetas conexas por propagación de máximo (sin scipy).

    Cada píxel empieza con su propia etiqueta y se va quedando con la
    mayor de su vecindad: al converger, cada mancha lleva una etiqueta
    única, así que los píxeles que la comparten son conexos.
    """
    alto, ancho = mascara.shape
    mapa = np.zeros((alto, ancho), dtype=np.int32)
    ys, xs = np.nonzero(mascara)
    if ys.size == 0:
        return mapa
    mapa[ys, xs] = np.arange(1, ys.size + 1, dtype=np.int32)

    for _ in range(80):
        anterior = mapa.copy()
        actual = mapa.copy()
        for dy, dx in ((-1, 0), (0, -1), (-1, -1), (-1, 1)):
            lo_y = max(0, -dy)
            hi_y = min(alto, alto - dy)
            lo_x = max(0, -dx)
            hi_x = min(ancho, ancho - dx)
            if hi_y <= lo_y or hi_x <= lo_x:
                continue
            desplazada = np.zeros_like(actual)
            desplazada[lo_y:hi_y, lo_x:hi_x] = mapa[lo_y + dy : hi_y + dy, lo_x + dx : hi_x + dx]
            actual = np.maximum(actual, desplazada)
        mapa = actual
        if np.array_equal(anterior, actual):
            break
    return mapa


def centroides(mascara: np.ndarray, minimo: int = 40) -> np.ndarray:
    """Centro de cada mancha conexa, filtrando las demasiado pequeñas."""
    mapa = etiquetas(mascara)
    ys, xs = np.nonzero(mapa)
    if ys.size == 0:
        return np.empty((0, 2))
    ids = mapa[ys, xs]
    orden = np.argsort(ids, kind="stable")
    ids, ys, xs = ids[orden], ys[orden], xs[orden]
    limites = np.flatnonzero(np.diff(ids)) + 1
    puntos = []
    for grupo in np.split(np.arange(ids.size), limites):
        if grupo.size < minimo:
            continue
        puntos.append([xs[grupo].mean(), ys[grupo].mean()])
    return np.array(puntos) if puntos else np.empty((0, 2))


def azul_electrico(rgba: np.ndarray) -> np.ndarray:
    """LED y módulos: azules, saturados y con alfa."""
    r, g, b, a = (rgba[:, :, i].astype(np.int16) for i in range(4))
    return (a > 60) & (b > 110) & (b - r > 45) & (b - g > 20)


def azul_nucleo(rgba: np.ndarray, brillo: int = 190) -> np.ndarray:
    """El núcleo brillante de un LED: azul claro, casi saturado."""
    r, g, b, a = (rgba[:, :, i].astype(np.int16) for i in range(4))
    return (a > 140) & (b > brillo) & (b - r > 70) & (b - g > 40)


def rasgos_azules(rgba: np.ndarray) -> np.ndarray:
    """Los rasgos repetidos y simétricos: lo único fiable para medir el eje.

    Los renders están en perspectiva y con luz lateral, así que el centroide
    del alfa se desvía. Los LED y los módulos, en cambio, son idénticos y
    están repartidos en corona: su centro es el eje de la pieza.
    """
    return centroides(azul_nucleo(rgba), minimo=25)


def silueta(rgba: np.ndarray) -> np.ndarray:
    """Borde exterior de la pieza (alfa opaco)."""
    alfa = rgba[:, :, 3] > 40
    erosion = alfa.copy()
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        erosion &= np.roll(alfa, (dy, dx), axis=(0, 1))
    return alfa & ~erosion


def anillo_azul(rgba: np.ndarray) -> np.ndarray:
    """El núcleo brillante de los LED y los módulos: azul casi saturado.

    Es el rasgo que no depende de la luz: los LED y los módulos son idénticos
    y están repartidos en corona, así que el centro de esa corona es el eje
    mecánico de la pieza. El centroide del alfa, en cambio, se desvía varios
    píxeles porque el render tiene iluminación lateral.
    """
    r, g, b, a = (rgba[:, :, i].astype(np.int16) for i in range(4))
    mascara = (a > 150) & (b > 185) & (b - r > 70) & (b - g > 40)
    ys, xs = np.nonzero(mascara)
    if ys.size < 30:
        return np.empty((0, 2))
    return np.column_stack([xs.astype(float), ys.astype(float)])


# ── Métodos de medida ────────────────────────────────────────────────────────

def circulo_por_minimos_cuadrados(puntos: np.ndarray) -> np.ndarray:
    """Centro de un círculo que pasa por `puntos` (ajuste algebraico)."""
    x, y = puntos[:, 0], puntos[:, 1]
    a = np.column_stack([x, y, np.ones_like(x)])
    b = x * x + y * y
    (ua, ub, uc), *_ = np.linalg.lstsq(a, b, rcond=None)
    return np.array([ub / (2 * ua), uc / (2 * ua)])


def centro_por_rasgos(rgba: np.ndarray) -> tuple[float, float, float]:
    """Centro y radio de la corona que forman los rasgos repetidos.

    Los LED y los módulos son idénticos y están repartidos en corona. Ajustar
    una circunferencia a TODOS ellos da el eje de la pieza: no depende de la
    iluminación, a diferencia del centroide del alfa.
    """
    puntos = anillo_azul(rgba)
    if len(puntos) < 30:
        raise ValueError(f"solo {len(puntos)} píxeles de LED")
    centro = circulo_por_minimos_cuadrados(puntos)
    radios = np.hypot(puntos[:, 0] - centro[0], puntos[:, 1] - centro[1])
    return float(centro[0]), float(centro[1]), float(radios.mean())


def elipse_de_una_annulatura(mascara: np.ndarray) -> tuple[float, float]:
    """Centro de la elipse que mejor explica una corona (anillo de LED).

    Una corona completa es un conjunto de puntos que NO se puede ajustar con
    una circunferencia (la ecuación es degenerada: el centro no está determinado
    por el radio). Pero sí con una elipse general, que es lo que la corona
    проекa en pantalla.
    """
    ys, xs = np.nonzero(mascara)
    if xs.size < 20:
        raise ValueError("máscara vacía")
    paso = max(1, xs.size // 8000)
    xs = xs[::paso].astype(float)
    ys = ys[::paso].astype(float)
    m = np.column_stack([xs * xs, xs * ys, ys * ys, xs, ys, np.ones_like(xs)])
    _, _, v = np.linalg.svd(m)
    a, b, c, d, e, _ = v[-1]
    det = 4 * a * c - b * b
    if abs(det) < 1e-9:
        return float(xs.mean()), float(ys.mean())
    return float((b * e - 2 * c * d) / det), float((b * d - 2 * a * e) / det)


def centro_por_elipse(rgba: np.ndarray) -> tuple[float, float]:
    """Centro de la elipse que mejor encaja en la silueta."""
    ys, xs = np.nonzero(silueta(rgba))
    if xs.size < 20:
        raise ValueError("silueta vacía")
    paso = max(1, xs.size // 6000)
    xs = xs[::paso].astype(float)
    ys = ys[::paso].astype(float)
    m = np.column_stack([xs * xs, xs * ys, ys * ys, xs, ys, np.ones_like(xs)])
    _, _, v = np.linalg.svd(m)
    a, b, c, d, e, _ = v[-1]
    det = 4 * a * c - b * b
    if abs(det) < 1e-9:
        return float(xs.mean()), float(ys.mean())
    return float((b * e - 2 * c * d) / det), float((b * d - 2 * a * e) / det)


PIEZAS_A_MEDIR = [
    "anillo-1-cuerpo.png",
    "anillo-2-leds.png",
    "anillo-2-metal.png",
    "anillo-2-plasma.png",
    "anillo-2-glow.png",
    "anillo-3-modulos.png",
    "anillo-3-metal.png",
    "anillo-4-estructura.png",
    "anillo-4-leds.png",
    "anillo-4-glow.png",
]


def principal() -> int:
    print(f"{'pieza':26} {'tamaño':>11}  {'corona LED (eje)':>22}  {'elipse silueta':>20}  {'desvío %':>16}")
    for nombre in PIEZAS_A_MEDIR:
        ruta = PIEZAS / nombre
        if not ruta.exists():
            continue
        rgba = leer_png(ruta)
        alto, ancho = rgba.shape[:2]
        # La corona de LED: el rasgo repetido que no depende de la luz.
        try:
            corona = anillo_azul(rgba)
            if len(corona) < 30:
                raise ValueError("sin LED")
            ex, ey = elipse_de_una_annulatura(corona > 0)
            texto_corona = f"({ex:7.2f},{ey:7.2f})"
        except ValueError as error:
            ex = ey = ancho / 2
            texto_corona = f"n/d ({error})"
        try:
            cx, cy = centro_por_elipse(rgba)
            texto_elipse = f"({cx:7.2f},{cy:7.2f})"
        except ValueError:
            cx = cy = ancho / 2
            texto_elipse = "n/d"
        print(
            f"{nombre:26} {ancho:4d}x{alto:<5d}  {texto_corona:>22}  {texto_elipse:>20}  "
            f"({(ex / ancho - 0.5) * 100:+6.3f},{(ey / alto - 0.5) * 100:+6.3f})"
        )
    return 0


if __name__ == "__main__":
    sys.exit(principal())
