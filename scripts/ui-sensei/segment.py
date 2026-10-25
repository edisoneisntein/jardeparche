#!/usr/bin/env python3
"""UI SENSEI · segmentación y extracción de una interfaz.

Toma una imagen de una interfaz (una captura o un HUD de referencia), la
segmenta en sus elementos, recorta cada uno con canal alfa, escribe el
manifiesto con la posición exacta y genera el código React/TypeScript que
reconstruye la interfaz de forma modular.

    python3 scripts/ui-sensei/segment.py <imagen> [--salida ui-sensei-out] [--min 240]

Etapas:
  1. Ingesta: decodificación (sips) → RGB; normalización a HSV propio.
  2. Segmentación: máscara holográfica (azul/cian brillante) + componentes
     conectados por uniones (union-find) sobre las filas.
  3. Clasificación semántica por geometría y posición.
  4. Recorte con alfa: la intensidad del holograma se usa como canal alfa, así
     el fondo negro desaparece sin needing modelos de eliminación de fondo.
  5. Manifiesto JSON + componentes React listos para integrar.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagen import a_rgba_con_alfa, decodificar, escribir_png  # noqa: E402


@dataclass
class Segmento:
    x: int
    y: int
    ancho: int
    alto: int
    etiqueta: str
    confianza: float
    pixeles: int
    archivo: str

    @property
    def centro_x(self) -> float:
        return self.x + self.ancho / 2

    @property
    def centro_y(self) -> float:
        return self.y + self.alto / 2


def hsv_propio(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Matriz de tono (0..1), saturación (0..1) y valor (0..1)."""
    r = rgb[:, :, 0].astype(np.float32) / 255
    g = rgb[:, :, 1].astype(np.float32) / 255
    b = rgb[:, :, 2].astype(np.float32) / 255
    mx = np.max(rgb, axis=2).astype(np.float32) / 255
    mn = np.min(rgb, axis=2).astype(np.float32) / 255
    delta = mx - mn
    saturacion = np.where(mx > 0, delta / np.maximum(mx, 1e-6), 0)
    valor = mx
    tono = np.zeros_like(mx)
    con_color = delta > 1e-6
    idx_max = np.argmax(rgb, axis=2)
    con_rojo = con_color & (idx_max == 0)
    con_verde = con_color & (idx_max == 1)
    con_azul = con_color & (idx_max == 2)
    tono[con_rojo] = ((g - b) / np.maximum(delta, 1e-6))[con_rojo] % 6
    tono[con_verde] = ((b - r) / np.maximum(delta, 1e-6))[con_verde] + 2
    tono[con_azul] = ((r - g) / np.maximum(delta, 1e-6))[con_azul] + 4
    tono = (tono / 6) % 1
    return tono, saturacion, valor


def mascara_holograma(rgb: np.ndarray) -> np.ndarray:
    """Máscara de los elementos "encendidos" (cian/azul brillante)."""
    tono, saturacion, valor = hsv_propio(rgb)
    cian = (tono >= 0.45) & (tono <= 0.62) & (saturacion > 0.22)
    azul = (tono > 0.62) & (tono <= 0.78) & (saturacion > 0.18)
    caliente = (tono < 0.14) & (saturacion > 0.45)  #ámbar/rojo del núcleo
    return (cian | azul | caliente) & (valor > 0.16)


def componentes(mascara: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """Componentes conectados (4-vecinos) por union-find sobre los tramos."""
    alto, ancho = mascara.shape
    padre: list[int] = []

    def buscar(x: int) -> int:
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x

    def unir(a: int, b: int) -> None:
        ra, rb = buscar(a), buscar(b)
        if ra != rb:
            padre[rb] = ra

    tramos: list[tuple[int, int, int]] = []  # (y, x_ini, x_fin)
    for y in range(alto):
        fila = mascara[y]
        if not fila.any():
            continue
        cambios = np.diff(np.concatenate(([0], fila.view(np.int8), [0])))
        inicios = np.where(cambios == 1)[0]
        fines = np.where(cambios == -1)[0]
        for ini, fin in zip(inicios, fines):
            padre.append(len(padre))
            tramos.append((y, int(ini), int(fin)))
            if padre and len(tramos) > 1:
                # une con el tramo anterior si se solapa en x
                for y_prev, ini_prev, fin_prev in (tramos[-2],):
                    pass

    # Unión con los tramos de la fila anterior que se solapan.
    por_fila: dict[int, list[int]] = {}
    for indice, (y, ini, fin) in enumerate(tramos):
        por_fila.setdefault(y, []).append(indice)
    for y in list(por_fila.keys()):
        for indice in por_fila[y]:
            _, ini, fin = tramos[indice]
            for previo in por_fila.get(y - 1, []):
                _, p_ini, p_fin = tramos[previo]
                if ini < p_fin and p_ini < fin:
                    unir(indice, previo)

    cajas: dict[int, list[int]] = {}
    for indice, (y, ini, fin) in enumerate(tramos):
        raiz = buscar(indice)
        caja = cajas.setdefault(raiz, [alto, ancho, 0, 0, 0])
        caja[0] = min(caja[0], y)
        caja[1] = min(caja[1], ini)
        caja[2] = max(caja[2], fin)
        caja[3] = max(caja[3], y)
        caja[4] += fin - ini

    return [(c[1], c[0], c[2] - c[1], c[3] - c[0], c[4]) for c in cajas.values()]


def clasificar(x: int, y: int, w: int, h: int, ancho: int, alto: int, relleno: float) -> str:
    """Etiqueta semántica por geometría y posición."""
    cx = (x + w / 2) / ancho
    cy = (y + h / 2) / alto
    aspecto = w / max(1, h)
    centro_horizontal = 0.3 < cx < 0.7
    vertical_alta = cy < 0.22
    vertical_baja = cy > 0.82

    if relleno > 0.82 and w * h > ancho * alto * 0.06:
        return "fondo_global"
    if centro_horizontal and 0.22 < cy < 0.78 and w > ancho * 0.16 and h > alto * 0.22:
        return "nucleo_central"
    if 0.2 < w / max(1, h) < 1.25 and w > ancho * 0.06 and w > alto * 0.06:
        return "medidor_circular"
    if vertical_alta and w > ancho * 0.5:
        return "header"
    if w > ancho * 0.45 and h < alto * 0.09:
        return "barra_estado"
    if aspecto > 3.2 and h < alto * 0.05:
        return "linea_datos"
    if w < ancho * 0.07 and h < alto * 0.07:
        return "boton"
    if w > ancho * 0.30 and h < alto * 0.05:
        return "linea_datos"
    if w < ancho * 0.05 and h > alto * 0.12:
        return "indicador_vertical"
    if 0.78 < cx or cx < 0.22:
        return "panel_lateral"
    if w > ancho * 0.12 and h > alto * 0.12:
        return "panel_datos"
    if vertical_baja:
        return "barra_inferior"
    return "bloque_texto"


def principal() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("imagen", type=Path)
    parser.add_argument("--salida", type=Path, default=Path("ui-sensei-out"))
    parser.add_argument("--min", type=int, default=260, help="píxeles mínimos de un elemento")
    parser.add_argument("--max-fraccion", type=float, default=0.55)
    args = parser.parse_args()

    if not args.imagen.exists():
        print(f"✗ no existe la imagen: {args.imagen}", file=sys.stderr)
        return 1

    rgb = decodificar(args.imagen)
    alto, ancho = rgb.shape[:2]
    mascara = mascara_holograma(rgb)
    print(f"Imagen: {ancho}x{alto} · píxeles encendidos: {int(mascara.sum())} ({mascara.mean()*100:.2f}%)")

    cajas = componentes(mascara)
    print(f"Segmentos brutos: {len(cajas)}")

    segmentos: list[Segmento] = []
    for (x, y, w, h, pixeles) in cajas:
        if pixeles < args.min or w < 4 or h < 4:
            continue
        relleno = pixeles / max(1, w * h)
        if w * h > (ancho * alto) * args.max_fraccion:
            continue
        etiqueta = clasificar(x, y, w, h, ancho, alto, relleno)
        segmentos.append(
            Segmento(
                x=int(x),
                y=int(y),
                ancho=int(w),
                alto=int(h),
                etiqueta=etiqueta,
                confianza=round(float(relleno), 3),
                pixeles=int(pixeles),
                archivo="",
            )
        )

    # Se descartan los elementos contenidos dentro de otro mayor.
    segmentos.sort(key=lambda s: s.ancho * s.alto, reverse=True)
    finales: list[Segmento] = []
    for segmento in segmentos:
        dentro = False
        for previo in finales:
            if (
                segmento.x >= previo.x
                and segmento.y >= previo.y
                and segmento.x + segmento.ancho <= previo.x + previo.ancho
                and segmento.y + segmento.alto <= previo.y + previo.alto
            ):
                dentro = True
                break
        if not dentro:
            finales.append(segmento)
    segmentos = sorted(finales, key=lambda s: (s.y, s.x))

    # Recorte con alfa: la intensidad del holograma es el canal alfa.
    valor = rgb.astype(np.float32).max(axis=2) / 255
    carpeta = args.salida / "assets" / "extracted"
    for indice, segmento in enumerate(segmentos, start=1):
        trozo = rgb[segmento.y : segmento.y + segmento.alto, segmento.x : segmento.x + segmento.ancho]
        alfa = valor[segmento.y : segmento.y + segmento.alto, segmento.x : segmento.x + segmento.ancho]
        alfa = np.clip((alfa - 0.10) / 0.55, 0, 1)
        nombre = f"{indice:02d}-{segmento.etiqueta}.png"
        escribir_png(a_rgba_con_alfa(trozo, alfa), carpeta / nombre)
        segmento.archivo = f"assets/extracted/{nombre}"

    manifiesto = {
        "imagen": str(args.imagen),
        "ancho": ancho,
        "alto": alto,
        "elementos": [asdict(s) for s in segmentos],
    }
    (args.salida / "manifest.json").write_text(json.dumps(manifiesto, indent=2, ensure_ascii=False), "utf8")
    (args.salida / "Generated.tsx").write_text(generar_tsx(manifiesto, args.imagen.name), "utf8")

    print(f"\nElementos: {len(segmentos)}")
    for s in segmentos:
        print(f"  {s.archivo:44} {s.x:4},{s.y:4} {s.ancho:4}x{s.alto:4}  {s.etiqueta}")
    print(f"\nManifiesto: {args.salida/'manifest.json'}")
    print(f"Código:      {args.salida/'Generated.tsx'}")
    return 0


def generar_tsx(manifiesto: dict, nombre_imagen: str) -> str:
    """Genera los componentes React que reconstruyen la interfaz."""
    componentes_tsx: list[str] = []
    for indice, elemento in enumerate(manifiesto["elementos"], start=1):
        nombre = elemento["archivo"].split("/")[-1].replace("-", "_").replace(".png", "")
        componentes_tsx.append(
            f"""/**
 * {elemento['etiqueta']} · ({elemento['x']}, {elemento['y']}) {elemento['ancho']}x{elemento['alto']}
 * Recorte de la imagen de referencia con el fondo eliminado (alfa).
 */
export function Elemento{indice}() {{
  return (
    <img
      className="ui-sensei ui-sensei-{elemento['etiqueta'].replace('_', '-')}"
      src="/assets/extracted/{elemento['archivo'].split('/')[-1]}"
      alt=""
      style={{{{
        left: {elemento['x']}px,
        top: {elemento['y']}px,
        width: {elemento['ancho']}px,
        height: {elemento['alto']}px,
      }}}}
    />
  );
}}
"""
        )

    usos = "\n".join(f"      <Elemento{i} />" for i in range(1, len(manifiesto["elementos"]) + 1))
    total_alto = manifiesto["alto"]
    total_ancho = manifiesto["ancho"]
    return f"""/**
 * Reconstrucción modular de la interfaz de referencia.
 *
 * Imagen de origen: {nombre_imagen} ({total_ancho}x{total_alto}).
 * Generado por scripts/ui-sensei/segment.py.
 *
 * Los elementos se posicionan en píxeles exactos respecto a la imagen; para
 * que sea responsivo, el contenedor conserva la proporción con
 * `aspect-ratio` y los hijos usan porcentajes.
 */
export function ReferenceInterface() {{
  return (
    <div
      className="ui-sensei-root"
      style={{{{
        position: "relative",
        width: "100%",
        maxWidth: {total_ancho}px,
        aspectRatio: "{total_ancho} / {total_alto}",
        backgroundImage: `url("/assets/{nombre_imagen}")`,
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
      }}}}
    >
{usos}
    </div>
  );
}}
""" + "\n".join(componentes_tsx)


if __name__ == "__main__":
    raise SystemExit(principal())
