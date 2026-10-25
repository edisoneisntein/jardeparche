import { z } from "zod";
import type { ToolDefinition, ToolServices } from "../types.js";
import type { ToolContext, ToolResult } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";

const FindSkillsInputSchema = z.object({
  query: z.string().optional().describe("Término de búsqueda para filtrar skills (ej: 'pdf', 'github', 'slack')"),
  category: z.string().optional().describe("Categoría de skills a buscar"),
  refresh: z.boolean().default(false).describe("Forzar actualización del catálogo"),
});

type FindSkillsInput = z.infer<typeof FindSkillsInputSchema>;

export function createFindSkillsTool(services: ToolServices): ToolDefinition<FindSkillsInput> {
  return {
    name: "skills.find",
    title: "Find Available Skills",
    description: "Busca y lista skills disponibles en el ecosistema de Composio usando el skill find-skills. Útil para descubrir nuevas capacidades (PDF, Slack, GitHub, Notion, etc.) que pueden integrarse como tools.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Término de búsqueda para filtrar skills (ej: 'pdf', 'github', 'slack')" },
        category: { type: "string", description: "Categoría de skills a buscar" },
        refresh: { type: "boolean", description: "Forzar actualización del catálogo", default: false },
      },
      additionalProperties: false,
    },
    parse: (raw) => FindSkillsInputSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input: FindSkillsInput, ctx: ToolContext): Promise<ToolResult> => {
      const args = ["find-skills"];
      if (input.query) args.push("--query", input.query);
      if (input.category) args.push("--category", input.category);
      if (input.refresh) args.push("--refresh");

      const result = await runSanitizedProcess("skills", args, {
        cwd: process.cwd(),
        timeoutMs: 50_000,
        signal: ctx.signal,
      });

      const success = result.code === 0 && !result.timedOut && !result.aborted;
      const output = result.stdout || result.stderr;

      const skills = output.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(':');
          const name = parts[0]?.trim() ?? "";
          const description = parts.slice(1).join(':').trim();
          return { name, description };
        });

      return {
        ok: success,
        unavailable: false,
        summary: success
          ? `Encontrados ${skills.length} skills`
          : result.timedOut
            ? "La búsqueda de skills excedió el tiempo previsto"
            : result.aborted
              ? "La búsqueda de skills fue cancelada"
              : "Búsqueda de skills falló",
        data: {
          query: input.query,
          category: input.category,
          skills,
          count: skills.length,
          rawOutput: output.trim(),
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