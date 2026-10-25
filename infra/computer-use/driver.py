#!/usr/bin/env python3
"""
Driver real de control de interfaz para la tool `computer.use` (macOS).

Implementa las acciones sobre CoreGraphics mediante ctypes (biblioteca del
sistema, sin dependencias externas):

  get_screen_info  -> tamaño de pantalla y posición real del cursor
  move_cursor      -> CGEventCreateMouseEvent(kCGEventMouseMoved) + CGEventPost
  mouse_click      -> kCGEventMouseDown + kCGEventMouseUp
  type_text        -> CGEventKeyboardSetUnicodeString + CGEventPost
  press_key        -> CGEventCreateKeyboardEvent + CGEventPost (con modificadores)
  wait             -> espera real

Contrato:
  argv[1] = JSON con la acción y sus argumentos.
  stdout   = JSON con el resultado: {"ok": true, ...} | {"ok": false, "error": "..."}
  exit     = 0 si la acción se ejecutó, 1 si falló.

Las coordenadas llegan NORMALIZADAS (0-1000) en el eje vertical, igual que
declara el contrato de la tool, y se convierten a píxeles de la pantalla
principal. El origen (0,0) es la esquina superior izquierda.
"""

import ctypes
import ctypes.util
import json
import sys
import time

# ── Constantes de CoreGraphics ──────────────────────────────────────────────
CG_EVENT_MOUSE_MOVED = 5
CG_EVENT_LEFT_MOUSE_DOWN = 1
CG_EVENT_LEFT_MOUSE_UP = 2
CG_EVENT_RIGHT_MOUSE_DOWN = 3
CG_EVENT_RIGHT_MOUSE_UP = 4
CG_EVENT_KEY_DOWN = 10
CG_EVENT_KEY_UP = 11
CG_HID_EVENT_TAP = 0
CG_EVENT_FLAG_MASK_SHIFT = 0x00020000
CG_EVENT_FLAG_MASK_CONTROL = 0x00040000
CG_EVENT_FLAG_MASK_ALT = 0x00080000
CG_EVENT_FLAG_MASK_COMMAND = 0x00100000

MOUSE_BUTTONS = {
    "left": (CG_EVENT_LEFT_MOUSE_DOWN, CG_EVENT_LEFT_MOUSE_UP),
    "right": (CG_EVENT_RIGHT_MOUSE_DOWN, CG_EVENT_RIGHT_MOUSE_UP),
}

KEY_CODES = {
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
}

MODIFIERS = {
    "shift": CG_EVENT_FLAG_MASK_SHIFT,
    "control": CG_EVENT_FLAG_MASK_CONTROL,
    "ctrl": CG_EVENT_FLAG_MASK_CONTROL,
    "alt": CG_EVENT_FLAG_MASK_ALT,
    "option": CG_EVENT_FLAG_MASK_ALT,
    "command": CG_EVENT_FLAG_MASK_COMMAND,
    "cmd": CG_EVENT_FLAG_MASK_COMMAND,
    "meta": CG_EVENT_FLAG_MASK_COMMAND,
}


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double),
                ("width", ctypes.c_double), ("height", ctypes.c_double)]


def load_core_graphics():
    path = ctypes.util.find_library("CoreGraphics")
    if not path:
        raise RuntimeError("CoreGraphics no está disponible en este sistema")
    cg = ctypes.cdll.LoadLibrary(path)

    cg.CGEventCreate.restype = ctypes.c_void_p
    cg.CGEventCreate.argtypes = [ctypes.c_void_p]

    cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]

    cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
    cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]

    cg.CGEventSetFlags.restype = ctypes.c_void_p
    cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]

    cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]

    cg.CGEventKeyboardSetUnicodeString.restype = None
    cg.CGEventKeyboardSetUnicodeString.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_char_p, ctypes.c_int32,
    ]

    cg.CGEventGetLocation.restype = CGPoint
    cg.CGEventGetLocation.argtypes = [ctypes.c_void_p]

    cg.CGMainDisplayID.restype = ctypes.c_uint32
    cg.CGMainDisplayID.argtypes = []

    cg.CGDisplayBounds.restype = CGRect
    cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]

    return cg


CG = load_core_graphics()


def screen_rect():
    return CG.CGDisplayBounds(CG.CGMainDisplayID())


def cursor_position():
    event = CG.CGEventCreate(None)
    if not event:
        raise RuntimeError("no se pudo crear el evento de ratón")
    point = CG.CGEventGetLocation(event)
    return point.x, point.y


def normalized_to_pixels(x, y):
    """Coordenadas normalizadas (0-1000) -> píxeles de la pantalla principal."""
    rect = screen_rect()
    px = rect.x + (x / 1000.0) * rect.width
    py = rect.y + (y / 1000.0) * rect.height
    return px, py


def post_mouse(event_type, point, button=0):
    event = CG.CGEventCreateMouseEvent(None, event_type, CGPoint(point[0], point[1]), button)
    if not event:
        raise RuntimeError("no se pudo crear el evento de ratón")
    CG.CGEventPost(CG_HID_EVENT_TAP, event)


def type_unicode(text):
    encoded = text.encode("utf-16-le")
    chunk_size = 20  # límite de CGEventKeyboardSetUnicodeString
    for index in range(0, len(encoded), chunk_size * 2):
        piece = encoded[index:index + chunk_size * 2]
        down = CG.CGEventCreateKeyboardEvent(None, 0, True)
        CG.CGEventKeyboardSetUnicodeString(down, len(piece), piece, len(piece) // 2)
        CG.CGEventPost(CG_HID_EVENT_TAP, down)
        up = CG.CGEventCreateKeyboardEvent(None, 0, False)
        CG.CGEventPost(CG_HID_EVENT_TAP, up)
        time.sleep(0.005)


def press_key(key, modifiers):
    lowered = key.lower()
    if lowered in KEY_CODES:
        code = KEY_CODES[lowered]
    elif len(lowered) == 1:
        # Tecla de un solo carácter: se envía como unicode.
        type_unicode(key)
        return
    else:
        raise RuntimeError("tecla no soportada: %s" % key)

    flags = 0
    for modifier in modifiers or []:
        flag = MODIFIERS.get(str(modifier).lower())
        if flag:
            flags |= flag

    down = CG.CGEventCreateKeyboardEvent(None, code, True)
    if flags:
        CG.CGEventSetFlags(down, flags)
    CG.CGEventPost(CG_HID_EVENT_TAP, down)
    up = CG.CGEventCreateKeyboardEvent(None, code, False)
    if flags:
        CG.CGEventSetFlags(up, flags)
    CG.CGEventPost(CG_HID_EVENT_TAP, up)


def run(request):
    action = request.get("action")
    if action == "get_screen_info":
        rect = screen_rect()
        cx, cy = cursor_position()
        return {
            "screen": {"width": rect.width, "height": rect.height, "x": rect.x, "y": rect.y},
            "cursor": {"x": cx, "y": cy},
        }
    if action == "move_cursor":
        coords = request.get("coords") or {}
        px, py = normalized_to_pixels(float(coords.get("x", 0)), float(coords.get("y", 0)))
        post_mouse(CG_EVENT_MOUSE_MOVED, (px, py))
        return {"moved_to": {"x": px, "y": py}}
    if action == "mouse_click":
        coords = request.get("coords") or {}
        button = str(request.get("button", "left")).lower()
        if button not in MOUSE_BUTTONS:
            raise RuntimeError("botón no soportado: %s" % button)
        px, py = normalized_to_pixels(float(coords.get("x", 0)), float(coords.get("y", 0)))
        down, up = MOUSE_BUTTONS[button]
        post_mouse(down, (px, py))
        post_mouse(up, (px, py))
        return {"clicked": {"x": px, "y": py}, "button": button}
    if action == "type_text":
        text = request.get("text") or ""
        if not text:
            raise RuntimeError("type_text requiere 'text'")
        type_unicode(text)
        return {"typed": len(text)}
    if action == "press_key":
        key = request.get("key") or ""
        if not key:
            raise RuntimeError("press_key requiere 'key'")
        press_key(key, request.get("modifiers") or [])
        return {"pressed": key}
    if action == "wait":
        duration = int(request.get("duration", 1000))
        time.sleep(max(0, duration) / 1000.0)
        return {"waited_ms": duration}
    raise RuntimeError("acción no soportada: %s" % action)


def main():
    if sys.platform != "darwin":
        print(json.dumps({"ok": False, "error": "el driver solo soporta macOS (platform=%s)" % sys.platform}))
        return 1
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "falta el payload JSON"}))
        return 1
    try:
        request = json.loads(sys.argv[1])
    except json.JSONDecodeError as error:
        print(json.dumps({"ok": False, "error": "payload JSON inválido: %s" % error}))
        return 1
    try:
        result = run(request)
    except Exception as error:  # noqa: BLE001 - se reporta al agente como dato
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, error)}))
        return 1
    print(json.dumps({"ok": True, **result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
