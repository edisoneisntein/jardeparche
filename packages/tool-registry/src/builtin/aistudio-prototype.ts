import { z } from "zod";
import type { ToolDefinition, ToolServices } from "../types.js";
import type { ToolContext, ToolResult } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";

const AIStudioPrototypeInputSchema = z.object({
  prototypePath: z.string().describe("Ruta al archivo YAML de prototipo (ej: prototypes/jarvis-voice.yaml)"),
  model: z.string().optional().describe("Modelo específico a usar (override del prototipo)"),
  scenario: z.string().optional().describe("Nombre del escenario de prueba a ejecutar"),
  interactive: z.boolean().default(false).describe("Si true, abre la UI interactiva de AI Studio"),
});

type AIStudioPrototypeInput = z.infer<typeof AIStudioPrototypeInputSchema>;

export function createAIStudioPrototypeTool(services: ToolServices): ToolDefinition<AIStudioPrototypeInput> {
  return {
    name: "prototype.aistudio",
    title: "AI Studio Prototype",
    description: "Lanza un prototipo en AI Studio usando el skill aistudio-prototype. Permite probar system prompts, function-calling schemas y modelos (Nemotron, GPT-4o, Claude) sin recompilar JARVIS.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 180_000,
    parameters: {
      type: "object",
      properties: {
        prototypePath: { type: "string", description: "Ruta al archivo YAML de prototipo (ej: prototypes/jarvis-voice.yaml)" },
        model: { type: "string", description: "Modelo específico a usar (override del prototipo)" },
        scenario: { type: "string", description: "Nombre del escenario de prueba a ejecutar" },
        interactive: { type: "boolean", description: "Si true, abre la UI interactiva de AI Studio", default: false },
      },
      required: ["prototypePath"],
      additionalProperties: false,
    },
    parse: (raw) => AIStudioPrototypeInputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input: AIStudioPrototypeInput, ctx: ToolContext): Promise<ToolResult> => {
      const args = ["aistudio-prototype", input.prototypePath];
      if (input.model) args.push("--model", input.model);
      if (input.scenario) args.push("--scenario", input.scenario);
      if (input.interactive) args.push("--interactive");

      const result = await runSanitizedProcess("skills", args, {
        cwd: process.cwd(),
        timeoutMs: 110_000,
        signal: ctx.signal,
      });

      const success = result.code === 0 && !result.timedOut && !result.aborted;
      const output = result.stdout || result.stderr;

      const urlMatch = output.match(/(https?:\/\/[^\s]+)/);
      const studioUrl = urlMatch ? urlMatch[0] : null;

      return {
        ok: success,
        unavailable: false,
        summary: success
          ? "Prototipo AI Studio lanzado"
          : result.timedOut
            ? "El prototipo excedió el tiempo previsto"
            : result.aborted
              ? "El prototipo fue cancelado"
              : "Lanzamiento de prototipo falló",
        data: {
          prototypePath: input.prototypePath,
          model: input.model,
          scenario: input.scenario,
          interactive: input.interactive,
          studioUrl,
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