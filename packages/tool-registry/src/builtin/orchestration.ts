import { z } from "zod";
import type { ToolDefinition, ToolServices } from "../types.js";
import type { ToolContext, ToolResult } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";

const OrchestrationInputSchema = z.object({
  pipelinePath: z.string().describe("Ruta al archivo YAML de definición del pipeline (ej: orchestration/voice-pipeline.yaml)"),
  variables: z.record(z.string()).optional().describe("Variables de entorno adicionales para el pipeline"),
  dryRun: z.boolean().default(false).describe("Si true, solo valida el pipeline sin ejecutarlo"),
});

type OrchestrationInput = z.infer<typeof OrchestrationInputSchema>;

export function createOrchestrationTool(services: ToolServices): ToolDefinition<OrchestrationInput> {
  return {
    name: "orchestration.run",
    title: "Run Orchestration Pipeline",
    description: "Ejecuta un pipeline de orquestación definido en YAML usando el skill orchestration. Permite definir y ejecutar flujos multi-paso complejos (STT → Intent → Agent → TTS → Audio → Fallback).",
    risk: "external_effect",
    requiresApproval: false,
    timeoutMs: 300_000,
    parameters: {
      type: "object",
      properties: {
        pipelinePath: { type: "string", description: "Ruta al archivo YAML de definición del pipeline (ej: orchestration/voice-pipeline.yaml)" },
        variables: { type: "object", description: "Variables de entorno adicionales para el pipeline", additionalProperties: { type: "string" } },
        dryRun: { type: "boolean", description: "Si true, solo valida el pipeline sin ejecutarlo", default: false },
      },
      required: ["pipelinePath"],
      additionalProperties: false,
    },
    parse: (raw) => OrchestrationInputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input: OrchestrationInput, ctx: ToolContext): Promise<ToolResult> => {
      const args = ["orchestration", input.pipelinePath];
      if (input.dryRun) args.push("--dry-run");

      const result = await runSanitizedProcess("skills", args, {
        cwd: process.cwd(),
        timeoutMs: 290_000,
        signal: ctx.signal,
        // Las variables del pipeline llegan al hijo de forma explícita; las
        // claves protegidas (PATH, HOME, LANG…) no pueden ser redefinidas.
        extraEnv: input.variables,
      });

      const success = result.code === 0 && !result.timedOut && !result.aborted;
      const output = result.stdout || result.stderr;

      return {
        ok: success,
        unavailable: false,
        summary: success
          ? "Pipeline de orquestación ejecutado"
          : result.timedOut
            ? "El pipeline excedió el tiempo previsto y su grupo de procesos fue terminado"
            : result.aborted
              ? "El pipeline fue cancelado"
              : "Pipeline de orquestación falló",
        data: {
          pipelinePath: input.pipelinePath,
          dryRun: input.dryRun,
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