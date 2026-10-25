import { describe, expect, it } from "vitest";
import { MemoryService, hashPrompt, normalizePrompt } from "./memory-service.js";
import { MemoryStore } from "./memory-store.js";

async function servicio(conEmbedder = false) {
  const store = new MemoryStore();
  await store.init();
  const embedder = conEmbedder
    ? {
        embed: async (texts: string[]) => ({
          vectors: texts.map(() => [1, 0, 0]),
          dimensions: 3,
        }),
      }
    : undefined;
  return { store, memory: new MemoryService({ store, embedder }) };
}

describe("PERF-002 · caché de respuestas", () => {
  it("el prompt normalizado ignora mayúsculas, espacios y puntuación final", () => {
    expect(normalizePrompt("  ¿Qué   HORA es? ")).toBe("¿qué hora es");
    expect(normalizePrompt("¿Qué hora es?")).toBe(normalizePrompt("¿qué hora es"));
    expect(hashPrompt("a")).toBe(hashPrompt("a"));
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });

  it("una respuesta cacheada se encuentra por coincidencia exacta", async () => {
    const { memory } = await servicio();
    await memory.cacheResponse("alice", "¿Qué hora es?", "Son las 10.");
    const found = await memory.findSemanticMatch("alice", "¿qué hora es?");
    expect(found?.response).toBe("Son las 10.");
  });

  it("un prompt distinto NO encuentra la respuesta cacheada", async () => {
    const { memory } = await servicio();
    await memory.cacheResponse("alice", "¿Qué hora es?", "Son las 10.");
    const found = await memory.findSemanticMatch("alice", "¿Qué día es hoy?");
    expect(found).toBeUndefined();
  });

  it("la caché está aislada por usuario", async () => {
    const { memory } = await servicio();
    await memory.cacheResponse("alice", "secreto", "respuesta de alice");
    expect(await memory.findSemanticMatch("bob", "secreto")).toBeUndefined();
  });

  it("sin embedder, la coincidencia semántica no se intenta", async () => {
    const { memory } = await servicio(false);
    await memory.cacheResponse("alice", "pregunta", "respuesta");
    // Sin embedder solo hay coincidencia exacta: el prompt es distinto.
    expect(await memory.findSemanticMatch("alice", "pregunta totalmente distinta")).toBeUndefined();
  });

  it("con embedder, la coincidencia semántica encuentra el prompt parecido", async () => {
    const { memory } = await servicio(true);
    await memory.cacheResponse("alice", "¿qué hora es?", "Son las 10.");
    const found = await memory.findSemanticMatch("alice", "¿qué hora es ahora?", 0.98);
    expect(found?.response).toBe("Son las 10.");
  });

  it("no cachea una respuesta vacía", async () => {
    const { memory } = await servicio();
    await memory.cacheResponse("alice", "pregunta", "   ");
    expect(await memory.findSemanticMatch("alice", "pregunta")).toBeUndefined();
  });
});
