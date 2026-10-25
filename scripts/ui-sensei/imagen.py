"""Utilidades de imagen sin dependencias externas (solo numpy + zlib).

macOS trae `sips`, que decodifica JPEG/PNG a BMP; un BMP se lee en numpy sin
librerías. Y un PNG (con canal alfa) se escribe a mano con zlib: así el
recorte de cada elemento sale con el fondo negro del hologramatransparentado.
"""

from __future__ import annotations

import struct
import subprocess
import zlib
from pathlib import Path

import numpy as np


def decodificar(entrada: Path) -> np.ndarray:
    """Devuelve la imagen como un array RGB (alto, ancho, 3) en uint8."""
    salida = Path("/tmp/ui-sensei-decode.bmp")
    subprocess.run(
        ["sips", "-s", "format", "bmp", str(entrada), "--out", str(salida)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return leer_bmp(salida)


def leer_bmp(ruta: Path) -> np.ndarray:
    datos = ruta.read_bytes()
    offset_pixeles = struct.unpack_from("<I", datos, 10)[0]
    ancho = struct.unpack_from("<i", datos, 18)[0]
    alto = struct.unpack_from("<i", datos, 22)[0]
    bits = struct.unpack_from("<H", datos, 28)[0]
    if bits not in (24, 32):
        raise ValueError(f"solo se admiten BMP de 24 o 32 bits (este es de {bits})")
    if alto < 0:  # de abajo arriba
        alto = -alto
        invertida = True
    else:
        invertida = False
    bytes_por_pixel = bits // 8
    fila = (ancho * bytes_por_pixel + 3) & ~3
    cruda = np.frombuffer(datos, dtype=np.uint8, count=fila * alto, offset=offset_pixeles)
    cruda = cruda.reshape(alto, fila)
    rgb = cruda[:, : ancho * bytes_por_pixel].reshape(alto, ancho, bytes_por_pixel)[:, :, :3][:, :, ::-1]
    if invertida:
        rgb = rgb[::-1]
    return np.ascontiguousarray(rgb)


def escribir_png(rgba: np.ndarray, ruta: Path) -> None:
    """Escribe un PNG RGBA (8 bits) sin dependencias."""
    alto, ancho, _ = rgba.shape
    crudo = b"".join(b"\x00" + rgba[y].tobytes() for y in range(alto))

    def bloque(tipo: bytes, carga: bytes) -> bytes:
        return (
            struct.pack(">I", len(carga))
            + tipo
            + carga
            + struct.pack(">I", zlib.crc32(tipo + carga) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += bloque(b"IHDR", struct.pack(">IIBBBBB", ancho, alto, 8, 6, 0, 0, 0))
    png += bloque(b"IDAT", zlib.compress(crudo, 9))
    png += bloque(b"IEND", b"")
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_bytes(png)


def a_rgba_con_alfa(imagen: np.ndarray, mascara: np.ndarray) -> np.ndarray:
    """Convierte RGB + máscara (0..1) en un array RGBA."""
    alfa = np.clip(mascara * 255, 0, 255).astype(np.uint8)
    return np.dstack([imagen, alfa])
