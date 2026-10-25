import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolDefinition } from "@jarvis/shared";
import { effectiveToolConfig, type ToolConfig } from "../types.js";

/**
 * Control de interfaz del sistema operativo.
 *
 * Implementación REAL sobre macOS:CoreGraphics vía un driver en Python
 * (`infra/computer-use/driver.py`). No hay simulación: si el driver no puede
 * ejecutarse, la tool se reporta como NO DISPONIBLE; si la acción falla, se
 * devuelve el error real del sistema. Nunca se afirma que una acción se
 * ejecutó si no se ejecutó.
 */

/**
 * Los modelos envían los números como texto con facilidad ("500" en vez de
 * 500) y a veces las coordenadas como "x,y". Rechazar eso convertía una
 * llamada perfectamente válida en un error de esquema, así que el borde es
 * liberal: normaliza en vez de fallar.
 */
const coordinate = z.preprocess((value) => {
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().int().min(0).max(1000));

const coordinates = z
  .object({ x: coordinate, y: coordinate })
  .or(
    z
      .string()
      .transform((value) => {
        const [x, y] = value.split(",").map((part) => Number(part.trim()));
        return { x, y };
      })
      .refine((value) => Number.isFinite(value.x) && Number.isFinite(value.y), { message: "coordenadas 'x,y' inválidas" }),
  );

const InputSchema = z
  .object({
    action: z.preprocess((value) => {
      if (typeof value !== "string") return value;
      const alias: Record<string, string> = {
        click: "mouse_click",
        mouse: "mouse_click",
        left_click: "mouse_click",
        move: "move_cursor",
        move_mouse: "move_cursor",
        cursor: "move_cursor",
        type: "type_text",
        write: "type_text",
        type_text: "type_text",
        key: "press_key",
        press: "press_key",
        press_key: "press_key",
        screen: "get_screen_info",
        screen_info: "get_screen_info",
        get_screen_info: "get_screen_info",
      };
      return alias[value.trim().toLowerCase()] ?? value;
    }, z.enum(["mouse_click", "move_cursor", "type_text", "press_key", "wait", "get_screen_info"])),
    coords: coordinates.optional(),
    text: z.preprocess((value) => (typeof value === "number" ? String(value) : value), z.string().min(1).max(10_000)).optional(),
    key: z.preprocess((value) => (typeof value === "number" ? String(value) : value), z.string().min(1).max(40)).optional(),
    modifiers: z.array(z.string().max(20)).max(4).optional(),
    button: z.enum(["left", "right"]).optional(),
    duration: z.preprocess((value) => {
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    }, z.number().int().min(0).max(120_000)).optional(),
  })
  // Cada acción exige sus propios argumentos: así el fallo se produce en el
  // borde, con un mensaje claro, y no dentro del driver.
  .superRefine((value, ctx) => {
    const require_ = (field: string, message: string) => {
      if (value[field as keyof typeof value] === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
      }
    };
    if (value.action === "mouse_click" || value.action === "move_cursor") require_("coords", "esta acción exige 'coords'");
    if (value.action === "type_text") require_("text", "esta acción exige 'text'");
    if (value.action === "press_key") require_("key", "esta acción exige 'key'");
    if (value.action === "wait") require_("duration", "esta acción exige 'duration'");
  });

const DRIVER_TIMEOUT_MS = 15_000;

function driverPath(config: ToolConfig): string {
  return effectiveToolConfig(config).computerUseDriver;
}

async function runDriver(config: ToolConfig, payload: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown>; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", [driverPath(config), JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: process.env.HOME ?? "/tmp" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, data: {}, error: `el driver no respondió en ${DRIVER_TIMEOUT_MS} ms` });
    }, DRIVER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, data: {}, error: `no se pudo ejecutar el driver: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
          ok?: boolean;
          error?: string;
          [key: string]: unknown;
        };
        if (parsed.ok) {
          const { ok: _ok, ...data } = parsed;
          resolve({ ok: true, data });
        } else {
          resolve({ ok: false, data: {}, error: parsed.error ?? stderr.trim() ?? "error desconocido del driver" });
        }
      } catch {
        resolve({ ok: false, data: {}, error: stderr.trim() || `respuesta ilegible del driver: ${stdout.slice(0, 200)}` });
      }
    });
  });
}

export function createComputerUseTool(rawConfig: ToolConfig): ToolDefinition<z.infer<typeof InputSchema>> {
  const config = effectiveToolConfig(rawConfig);
  return {
    name: "computer.use",
    title: "Control de Interfaz",
    description:
      "Controla el ratón y el teclado del sistema (macOS) mediante CoreGraphics: mueve el cursor, hace clic, escribe texto, pulsa teclas y lee el tamaño de pantalla y la posición real del cursor. Las coordenadas van normalizadas de 0 a 1000 con origen arriba a la izquierda. Requiere que el servidor tenga permiso de accesibilidad.",
    risk: "external_effect",
    requiresApproval: true,
    timeoutMs: 20_000,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["mouse_click", "move_cursor", "type_text", "press_key", "wait", "get_screen_info"],
          description: "Acción motriz a ejecutar.",
        },
        coords: {
          type: "object",
          properties: { x: { type: "integer", minimum: 0, maximum: 1000 }, y: { type: "integer", minimum: 0, maximum: 1000 } },
          description: "Coordenadas normalizadas [0, 1000].",
        },
        text: { type: "string", description: "Texto para escribir." },
        key: { type: "string", description: "Tecla a pulsar (return, tab, escape, flechas, F1-F12 o un carácter)." },
        modifiers: { type: "array", items: { type: "string" }, description: "Modificadores: shift, control, alt, command." },
        button: { type: "string", enum: ["left", "right"], description: "Botón del ratón (por defecto left)." },
        duration: { type: "integer", description: "Tiempo de espera en ms (acción wait)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    parse: (raw) => InputSchema.parse(raw),
    availability: () => {
      // Apagado por defecto (JARVIS_ENABLE_COMPUTER_USE): mover el ratón y
      // teclear en el host del usuario es la capacidad de mayor radio de
      // impacto, y un clic de aprobación es toda la barrera.
      if (!config.enableComputerUse) {
        return { available: false, reason: "control de interfaz desactivado (JARVIS_ENABLE_COMPUTER_USE)" };
      }
      if (process.platform !== "darwin") {
        return { available: false, reason: `el control de interfaz solo está implementado en macOS (platform=${process.platform})` };
      }
      if (!existsSync(driverPath(config))) {
        return { available: false, reason: `no se encuentra el driver de interfaz en ${driverPath(config)}` };
      }
      return { available: true };
    },
    execute: async (input) => {
      if (process.platform !== "darwin" || !existsSync(driverPath(config))) {
        return {
          ok: false,
          summary: "Control de interfaz no disponible en esta plataforma.",
          unavailable: true,
          error: process.platform !== "darwin" ? `solo macOS (platform=${process.platform})` : "falta el driver de interfaz",
        };
      }
      const result = await runDriver(config, {
        action: input.action,
        coords: input.coords,
        text: input.text,
        key: input.key,
        modifiers: input.modifiers,
        button: input.button,
        duration: input.duration,
      });
      if (!result.ok) {
        return {
          ok: false,
          summary: `La acción ${input.action} falló: ${result.error}`,
          unavailable: false,
          error: "driver_error",
          data: { action: input.action, driver_error: result.error },
        };
      }
      return {
        ok: true,
        summary: `Acción ${input.action} ejecutada.`,
        unavailable: false,
        data: { action: input.action, ...result.data },
      };
    },
  };
}
