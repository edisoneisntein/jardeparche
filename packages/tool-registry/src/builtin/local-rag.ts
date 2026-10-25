import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";

const SearchSchema = z.object({
  query: z.string().min(1).max(400),
  top_k: z.number().int().min(1).max(20).default(5),
});

/**
 * Recuperación de conocimiento desde los registros reales del usuario.
 *
 * Este tool reemplaza a la anterior versión que devolvía un fragmento
 * SIMULADO con `score: 0.95` fijo: esa implementación contradecía el
 * principio de "no simula capacidades" (README) y podía inducir al modelo a
 * afirmar que había consultado documentos que nunca existieron.
 *
 * Ahora devuelve únicamente filas persistidas, con su marca de tiempo real.
 */
export function createLocalRagTool(services: ToolServices): ToolDefinition<z.infer<typeof SearchSchema>> {
  const { memory } = services;

  return {
    name: "rag.local_search",
    title: "Búsqueda en la memoria local",
    description:
      "Busca en las memorias reales del usuario (hechos autorizados y episodios) usando coincidencia léxica y, si existen, embeddings. Devuelve únicamente registros persistidos con su fecha. Si no hay coincidencias, devuelve una lista vacía.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 10_000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta de búsqueda." },
        top_k: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Número máximo de resultados." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse: (raw) => SearchSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      try {
        const [semantic, episodic] = await Promise.all([
          memory.raw.searchSemantic(ctx.userId, input.query, input.top_k),
          memory.raw.searchEpisodic(ctx.userId, input.query, input.top_k),
        ]);

        const results = [
          ...semantic.map((record) => ({
            kind: "semantic" as const,
            key: record.key,
            text: record.value,
            source: record.source,
            createdAt: record.createdAt,
          })),
          ...episodic.map((record) => ({
            kind: "episodic" as const,
            key: record.outcome,
            text: record.summary,
            source: "episode",
            createdAt: record.createdAt,
          })),
        ];

        return {
          ok: true,
          data: { query: input.query, count: results.length, results },
          summary: results.length
            ? `${results.length} registro(s) encontrado(s) para «${input.query}».`
            : `Sin registros para «${input.query}».`,
          unavailable: false,
        };
      } catch (error) {
        return {
          ok: false,
          summary: `La búsqueda local falló: ${(error as Error).message}`,
          unavailable: false,
          error: "local_search_failed",
        };
      }
    },
  };
}
