"""Lector y escritor de PNG RGBA de 8 bits sin dependencias externas.

`imagen.py` decodifica a RGB (tira el canal alfa, que es justo lo que
necesita el núcleo: saber dónde está la pieza dentro de su cuadro). Aquí se
decodifica el RGBA entero, que es lo que permite medir el eje óptico de una
pieza: el alfa dice dónde está la geometría y el RGB solo el color.

    from png_rgba import leer_png, escribir_png
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

FIRMA_PNG = b"\x89PNG\r\n\x1a\n"


def leer_png(ruta: Path) -> np.ndarray:
    """Devuelve la imagen como un array RGBA (alto, ancho, 4) en uint8."""
    datos = Path(ruta).read_bytes()
    if datos[:8] != FIRMA_PNG:
        raise ValueError(f"{ruta} no es un PNG")
    pos = 8
    idat = bytearray()
    ancho = alto = None
    while pos < len(datos):
        largo = struct.unpack_from(">I", datos, pos)[0]
        tipo = datos[pos + 4 : pos + 8]
        carga = datos[pos + 8 : pos + 8 + largo]
        pos += 12 + largo
        if tipo == b"IHDR":
            ancho, alto, prof, color, _, _, interlace = struct.unpack(">IIBBBBB", carga)
            if prof != 8 or color != 6 or interlace != 0:
                raise ValueError(f"{ruta}: solo RGBA8 sin entrelazado")
        elif tipo == b"IDAT":
            idat += carga
        elif tipo == b"IEND":
            break
    if ancho is None or alto is None:
        raise ValueError(f"{ruta}: PNG sin cabecera")

    crudo = zlib.decompress(bytes(idat))
    bpp, stride = 4, ancho * 4
    salida = np.zeros((alto, stride), dtype=np.uint8)
    previa = np.zeros(stride, dtype=np.int32)
    p = 0
    for y in range(alto):
        filtro = crudo[p]
        p += 1
        fila = np.frombuffer(crudo[p : p + stride], dtype=np.uint8).astype(np.int32).copy()
        p += stride
        if filtro == 1:
            for x in range(bpp, stride):
                fila[x] = (fila[x] + fila[x - bpp]) & 0xFF
        elif filtro == 2:
            fila = (fila + previa) & 0xFF
        elif filtro == 3:
            for x in range(stride):
                a = fila[x - bpp] if x >= bpp else 0
                fila[x] = (fila[x] + ((a + previa[x]) >> 1)) & 0xFF
        elif filtro == 4:
            for x in range(stride):
                a = fila[x - bpp] if x >= bpp else 0
                b = previa[x]
                c = previa[x - bpp] if x >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                fila[x] = (fila[x] + pred) & 0xFF
        elif filtro != 0:
            raise ValueError(f"{ruta}: filtro {filtro} desconocido")
        salida[y] = fila.astype(np.uint8)
        previa = fila
    return salida.reshape(alto, ancho, 4)


def escribir_png(rgba: np.ndarray, ruta: Path) -> None:
    """Escribe un PNG RGBA de 8 bits."""
    alto, ancho, _ = rgba.shape
    crudo = b"".join(b"\x00" + rgba[y].tobytes() for y in range(alto))

    def bloque(tipo: bytes, carga: bytes) -> bytes:
        return (
            struct.pack(">I", len(carga))
            + tipo
            + carga
            + struct.pack(">I", zlib.crc32(tipo + carga) & 0xFFFFFFFF)
        )

    with open(ruta, "wb") as f:
        f.write(FIRMA_PNG)
        f.write(bloque(b"IHDR", struct.pack(">IIBBBBB", ancho, alto, 8, 6, 0, 0, 0)))
        f.write(bloque(b"IDAT", zlib.compress(crudo, 9)))
        f.write(bloque(b"IEND", b""))
