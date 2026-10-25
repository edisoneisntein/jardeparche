import { z } from "zod";
import type { ToolDefinition, ToolServices } from "../types.js";
import type { ToolContext, ToolResult } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";

const ComputerUseSkillInputSchema = z.object({
  action: z.enum([
    "click", "double_click", "right_click",
    "type", "keypress", "hotkey",
    "screenshot", "ocr", "scroll",
    "move", "drag", "wait",
    "open", "close", "focus"
  ]).describe("Acción a realizar en el escritorio"),
  x: z.number().int().optional().describe("Coordenada X (para click, move, drag)"),
  y: z.number().int().optional().describe("Coordenada Y (para click, move, drag)"),
  text: z.string().optional().describe("Texto a escribir (para type)"),
  key: z.string().optional().describe("Tecla a presionar (para keypress, ej: 'Enter', 'Tab', 'Escape')"),
  keys: z.array(z.string()).optional().describe("Combinación de teclas (para hotkey, ej: ['ctrl', 'c'])"),
  direction: z.enum(["up", "down", "left", "right"]).optional().describe("Dirección para scroll"),
  amount: z.number().int().optional().describe("Cantidad de scroll (píxeles o líneas)"),
  path: z.string().optional().describe("Ruta de aplicación/archivo a abrir (para open)"),
  duration: z.number().int().positive().optional().describe("Duración en ms (para wait)"),
  target: z.string().optional().describe("Selector o texto objetivo (para focus, click en elemento)"),
});

type ComputerUseSkillInput = z.infer<typeof ComputerUseSkillInputSchema>;

export function createComputerUseSkillTool(services: ToolServices): ToolDefinition<ComputerUseSkillInput> {
  return {
    name: "computer.use_skill",
    title: "Computer Use Skill",
    description: "Controla el escritorio del host usando el skill computer-use de Composio. Permite click, type, screenshot, OCR, scroll, hotkeys, abrir/cerrar apps, etc. Más alto nivel que computer.use nativo.",
    risk: "destructive",
    requiresApproval: true,
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "right_click", "type", "keypress", "hotkey", "screenshot", "ocr", "scroll", "move", "drag", "wait", "open", "close", "focus"], description: "Acción a realizar en el escritorio" },
        x: { type: "integer", description: "Coordenada X (para click, move, drag)" },
        y: { type: "integer", description: "Coordenada Y (para click, move, drag)" },
        text: { type: "string", description: "Texto a escribir (para type)" },
        key: { type: "string", description: "Tecla a presionar (para keypress, ej: 'Enter', 'Tab', 'Escape')" },
        keys: { type: "array", items: { type: "string" }, description: "Combinación de teclas (para hotkey, ej: ['ctrl', 'c'])" },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Dirección para scroll" },
        amount: { type: "integer", description: "Cantidad de scroll (píxeles o líneas)" },
        path: { type: "string", description: "Ruta de aplicación/archivo a abrir (para open)" },
        duration: { type: "integer", description: "Duración en ms (para wait)", minimum: 1 },
        target: { type: "string", description: "Selector o texto objetivo (para focus, click en elemento)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    parse: (raw) => ComputerUseSkillInputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input: ComputerUseSkillInput, ctx: ToolContext): Promise<ToolResult> => {
      let actionDesc = input.action;
      if (input.x !== undefined && input.y !== undefined) actionDesc += ` at ${input.x},${input.y}`;
      if (input.text) actionDesc += ` type "${input.text}"`;
      if (input.key) actionDesc += ` key "${input.key}"`;
      if (input.keys?.length) actionDesc += ` hotkey ${input.keys.join("+")}`;
      if (input.direction) actionDesc += ` scroll ${input.direction} ${input.amount ?? 3} lines`;
      if (input.path) actionDesc += ` open "${input.path}"`;
      if (input.duration) actionDesc += ` wait ${input.duration}ms`;
      if (input.target) actionDesc += ` target "${input.target}"`;

      const result = await runSanitizedProcess("skills", ["computer-use", actionDesc], {
        cwd: process.cwd(),
        timeoutMs: 110_000,
        signal: ctx.signal,
      });

      const success = result.code === 0 && !result.timedOut && !result.aborted;
      const output = result.stdout || result.stderr;

      return {
        ok: success,
        unavailable: false,
        summary: success
          ? `Acción ${input.action} completada`
          : result.timedOut
            ? `La acción ${input.action} excedió el tiempo previsto`
            : result.aborted
              ? `La acción ${input.action} fue cancelada`
              : `Acción ${input.action} falló`,
        data: {
          action: input.action,
          params: input,
          output: output.trim(),
          exitCode: result.code,
          truncated: result.truncated,
          durationMs: result.durationMs,
          timestamp: new Date().toISOString(),
        },
        error: success ? undefined : result.stderr || "Skill execution failed",
      };
    },
  };
}