import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";

const SearchSchema = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(5) });
const RememberSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(1000),
  confirmedByUser: z.literal(true).describe("Debe ser true: el usuario autorizó explícitamente guardar este dato."),
});
const ForgetSchema = z.object({ id: z.string().min(1) });

export function createMemoryTools(services: ToolServices): ToolDefinition[] {
  const { memory } = services;

  const search: ToolDefinition<z.infer<typeof SearchSchema>> = {
    name: "memory.search",
    title: "Buscar en memoria",
    description:
      "Busca en la memoria personal del usuario (hechos autorizados e interacciones pasadas). Devuelve solo registros almacenados, nunca inferencias.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 5000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto a buscar" },
        limit: { type: "number", description: "Máximo de resultados" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse: (raw) => SearchSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const [facts, episodes] = await Promise.all([
        memory.listFacts(ctx.userId, 200),
        memory.listEpisodes(ctx.userId, 200),
      ]);
      const lowered = input.query.toLowerCase();
      const matchedFacts = facts
        .filter((fact) => `${fact.key} ${fact.value}`.toLowerCase().includes(lowered))
        .slice(0, input.limit);
      const matchedEpisodes = episodes
        .filter((episode) => episode.summary.toLowerCase().includes(lowered))
        .slice(0, input.limit);
      const data = { facts: matchedFacts, episodes: matchedEpisodes };
      const total = matchedFacts.length + matchedEpisodes.length;
      return {
        ok: true,
        data,
        summary: total
          ? `Encontré ${matchedFacts.length} hecho(s) y ${matchedEpisodes.length} recuerdo(s) para «${input.query}».`
          : `No hay recuerdos almacenados que coincidan con «${input.query}».`,
        unavailable: false,
      };
    },
  };

  const remember: ToolDefinition<z.infer<typeof RememberSchema>> = {
    name: "memory.remember",
    title: "Guardar en memoria personal",
    description:
      "Guarda un hecho en la memoria semántica del usuario. Solo debe usarse cuando el usuario haya pedido explícitamente recordar algo.",
    risk: "local_reversible",
    requiresApproval: true,
    timeoutMs: 8000,
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Nombre corto del dato, por ejemplo «bebida favorita»" },
        value: { type: "string", description: "Valor a recordar" },
        confirmedByUser: { type: "boolean", description: "Debe ser true, confirmando autorización explícita" },
      },
      required: ["key", "value", "confirmedByUser"],
      additionalProperties: false,
    },
    parse: (raw) => RememberSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const record = await memory.rememberExplicitFact({ userId: ctx.userId, key: input.key, value: input.value });
      return {
        ok: true,
        data: { id: record.id, key: record.key, value: record.value },
        summary: `Guardado en memoria: ${record.key} = ${record.value}`,
        unavailable: false,
      };
    },
  };

  const forget: ToolDefinition<z.infer<typeof ForgetSchema>> = {
    name: "memory.forget",
    title: "Olvidar dato",
    description: "Elimina un hecho de la memoria personal por su identificador. Requiere confirmación.",
    risk: "destructive",
    requiresApproval: true,
    timeoutMs: 3000,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Identificador del hecho a eliminar" } },
      required: ["id"],
      additionalProperties: false,
    },
    parse: (raw) => ForgetSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx) => {
      const deleted = await memory.forgetFact(ctx.userId, input.id);
      return {
        ok: deleted,
        data: { id: input.id },
        summary: deleted ? "Dato eliminado de la memoria." : "No se encontró el dato indicado.",
        unavailable: false,
        error: deleted ? undefined : "not_found",
      };
    },
  };

  return [search, remember, forget];
}
