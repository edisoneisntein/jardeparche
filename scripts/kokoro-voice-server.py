#!/usr/bin/env python3
"""Servidor de voz de JARVIS con Kokoro (ONNX).

Kokoro son 82 millones de parámetros: una voz masculina en español real
(`em_alex`) que sintetiza en ~1 s por frase en un i5 de 2015, contra los 82 s
que tarda la voz clonada (Qwen3-TTS) en la misma máquina. Aquí el modelo se
carga UNA vez y se queda en memoria: por eso hay un servidor y no un comando.

Se usa con la biblioteca estándar (sin FastAPI) para no añadir dependencias.

    python3 .venv-voice/bin/python scripts/kokoro-voice-server.py --puerto 8788

Y se habla con él por HTTP:

    POST /sintetizar  {"texto": "Hola", "voz": "em_alex"}  →  audio/wav
    GET  /voces                                            →  ["em_alex", ...]
    GET  /salud                                            →  {"ok": true}
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
MODELO = RAIZ / ".voice-models" / "kokoro-v1.0.onnx"
VOCES = RAIZ / ".voice-models" / "voices-v1.0.bin"

# Voces en español de Kokoro: em_alex (hombre), em_santa (hombre), ef_dora (mujer).
VOCES_ES = ("em_alex", "em_santa", "ef_dora")

_modelo = None
_voces = None
_lock = __import__("threading").Lock()


def cargar():
    """Carga perezosa del modelo (tarda ~3 s la primera vez)."""
    global _modelo, _voces
    if _modelo is None:
        from kokoro_onnx import Kokoro

        _modelo = Kokoro(str(MODELO), str(VOCES))
        import numpy as np

        _voces = set(np.load(str(VOCES)).keys())
    return _modelo


def wav_en_bytes(samples, sr: int) -> bytes:
    import numpy as np

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buffer.getvalue()


class Manejador(BaseHTTPRequestHandler):
    def log_message(self, formato, *args):  # silencio: solo queremos los errores
        pass

    def _json(self, codigo: int, cuerpo: dict):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path.startswith("/salud"):
            try:
                cargar()
                self._json(200, {"ok": True, "voces_es": list(VOCES_ES)})
            except Exception as error:  # noqa: BLE001
                self._json(503, {"ok": False, "error": str(error)})
            return
        if self.path.startswith("/voces"):
            try:
                cargar()
            except Exception:  # noqa: BLE001
                pass
            self._json(200, {"voces": sorted(_voces or VOCES_ES), "es": list(VOCES_ES)})
            return
        self._json(404, {"error": "ruta desconocida"})

    def do_POST(self):
        if not self.path.startswith("/sintetizar"):
            self._json(404, {"error": "ruta desconocida"})
            return
        try:
            longitud = int(self.headers.get("Content-Length", "0"))
            datos = json.loads(self.rfile.read(longitud) or b"{}")
        except Exception as error:  # noqa: BLE001
            self._json(400, {"error": f"petición inválida: {error}"})
            return

        texto = str(datos.get("texto", "")).strip()
        if not texto:
            self._json(400, {"error": "falta el texto"})
            return
        voz = str(datos.get("voz", "em_alex"))
        idioma = str(datos.get("idioma", "es"))
        velocidad = float(datos.get("velocidad", 1.0))

        try:
            modelo = cargar()
        except Exception as error:  # noqa: BLE001
            self._json(503, {"error": f"el modelo no cargó: {error}"})
            return

        inicio = time.time()
        with _lock:  # el modelo no es reentrante
            muestras, sr = modelo.create(texto, voice=voz, speed=velocidad, lang=idioma)
        audio = wav_en_bytes(muestras, sr)
        print(f"[{time.time() - inicio:.2f}s] {len(muestras) / sr:.2f}s de audio · {voz}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("X-Voice-Duration-Ms", str(int(len(muestras) / sr * 1000)))
        self.end_headers()
        self.wfile.write(audio)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--puerto", type=int, default=int(os.environ.get("KOKORO_PORT", "8788")))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    if not MODELO.exists() or not VOCES.exists():
        print(f"✗ faltan los modelos en {RAIZ / '.voice-models'}", file=sys.stderr)
        return 1
    try:
        cargar()
    except Exception as error:  # noqa: BLE001
        print(f"✗ no se pudo cargar Kokoro: {error}", file=sys.stderr)
        return 1
    print(f"Kokoro escuchando en http://{args.host}:{args.puerto} · voces es: {', '.join(VOCES_ES)}", flush=True)
    ThreadingHTTPServer((args.host, args.puerto), Manejador).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
