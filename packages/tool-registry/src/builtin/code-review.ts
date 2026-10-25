import { z } from "zod";
import type { ToolDefinition, ToolServices } from "../types.js";
import type { ToolContext, ToolResult } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";

const CodeReviewInputSchema = z.object({
  baseRef: z.string().default("main").describe("Base git ref to compare against (e.g., main, develop)"),
  headRef: z.string().default("HEAD").describe("Head git ref to review (e.g., feature branch, commit SHA)"),
  includePatterns: z.array(z.string()).optional().describe("File patterns to include in review"),
  excludePatterns: z.array(z.string()).optional().describe("File patterns to exclude from review"),
  severity: z.enum(["all", "high", "medium", "low"]).default("all").describe("Minimum severity level to report"),
});

type CodeReviewInput = z.infer<typeof CodeReviewInputSchema>;

export function createCodeReviewTool(services: ToolServices): ToolDefinition<CodeReviewInput> {
  return {
    name: "code.review",
    title: "Code Review",
    description: "Ejecuta una revisión automática de código usando el skill code-review de Composio. Analiza cambios en un PR o rango de commits y reporta issues de calidad, seguridad, estilo y mejores prácticas.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 120_000,
    parameters: {
      type: "object",
      properties: {
        baseRef: { type: "string", description: "Base git ref to compare against (e.g., main, develop)", default: "main" },
        headRef: { type: "string", description: "Head git ref to review (e.g., feature branch, commit SHA)", default: "HEAD" },
        includePatterns: { type: "array", items: { type: "string" }, description: "File patterns to include in review" },
        excludePatterns: { type: "array", items: { type: "string" }, description: "File patterns to exclude from review" },
        severity: { type: "string", enum: ["all", "high", "medium", "low"], description: "Minimum severity level to report", default: "all" },
      },
      additionalProperties: false,
    },
    parse: (raw) => CodeReviewInputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input: CodeReviewInput, ctx: ToolContext): Promise<ToolResult> => {
      const args = [
        "code-review",
        `${input.baseRef}..${input.headRef}`,
      ];

      if (input.includePatterns?.length) {
        args.push("--include", ...input.includePatterns);
      }
      if (input.excludePatterns?.length) {
        args.push("--exclude", ...input.excludePatterns);
      }
      if (input.severity !== "all") {
        args.push("--severity", input.severity);
      }

      const result = await runSanitizedProcess("skills", args, {
        cwd: process.cwd(),
        timeoutMs: 110_000,
        signal: ctx.signal,
        // El token de GitHub es la única credencial que el skill necesita, y
        // se pasa de forma explícita: el resto del entorno del servidor no
        // llega al hijo.
        extraEnv: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
      });

      const success = result.code === 0 && !result.timedOut && !result.aborted;
      const output = result.stdout || result.stderr;

      return {
        ok: success,
        unavailable: false,
        summary: success
          ? "Revisión de código completada"
          : result.timedOut
            ? "La revisión de código excedió el tiempo previsto y su grupo de procesos fue terminado"
            : result.aborted
              ? "La revisión de código fue cancelada"
              : "Revisión de código falló",
        data: {
          baseRef: input.baseRef,
          headRef: input.headRef,
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
