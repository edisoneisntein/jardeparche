import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { MemoryService } from "../src/memory-service.js";

function embedder() {
  return {
    async embed(texts: string[]) {
      return {
        vectors: texts.map((text) => {
          const vector = new Array<number>(8).fill(0);
          for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
            vector[token.length % 8] = (vector[token.length % 8] ?? 0) + 1;
          }
          const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
          return vector.map((value) => value / norm);
        }),
        dimensions: 8,
      };
    },
  };
}

async function setup() {
  const store = new MemoryStore();
  await store.init();
  const memory = new MemoryService({ store, embedder: embedder() });
  return { store, memory };
}

describe("MemoryService", () => {
  it("stores and recalls session messages", async () => {
    const { memory, store } = await setup();
    const session = await store.createSession({ id: crypto.randomUUID(), userId: "alice" });
    await memory.recordUserMessage({ userId: "alice", sessionId: session.id, text: "recuérdame comprar café" });
    const recall = await memory.recall("alice", session.id, "café");
    expect(recall.recent.some((message) => message.text.includes("café"))).toBe(true);
  });

  it("keeps users isolated", async () => {
    const { memory, store } = await setup();
    const a = await store.createSession({ id: crypto.randomUUID(), userId: "alice" });
    const b = await store.createSession({ id: crypto.randomUUID(), userId: "bob" });
    await memory.recordUserMessage({ userId: "alice", sessionId: a.id, text: "alice secret project" });
    await memory.recordUserMessage({ userId: "bob", sessionId: b.id, text: "bob notes" });
    const bobRecall = await memory.recall("bob", b.id, "secret project");
    expect(bobRecall.recent.every((message) => message.userId === "bob")).toBe(true);
    const aliceData = await memory.exportUser("alice");
    expect(JSON.stringify(aliceData)).not.toContain("bob notes");
  });

  it("retrieves semantic facts by embedding similarity", async () => {
    const { memory } = await setup();
    await memory.rememberExplicitFact({ userId: "alice", key: "bebida favorita", value: "café con leche" });
    await memory.rememberExplicitFact({ userId: "alice", key: "color favorito", value: "cian eléctrico" });
    const recall = await memory.recall("alice", "no-session", "qué bebida me gusta");
    expect(recall.semantic[0]?.key).toBe("bebida favorita");
  });

  it("records and purges episodic memory", async () => {
    const { memory, store } = await setup();
    await memory.recordEpisode({
      userId: "alice",
      sessionId: "s1",
      taskId: "t1",
      summary: "creó una tarea de compras",
      outcome: "completed",
      toolsUsed: ["task.create"],
    });
    const episodes = await memory.listEpisodes("alice");
    expect(episodes).toHaveLength(1);
    expect((await memory.exportUser("alice")).episodic).toHaveLength(1);
    await store.purgeEpisodicBefore("alice", new Date(Date.now() + 1000).toISOString());
    expect(await memory.listEpisodes("alice")).toHaveLength(0);
  });

  it("deletes all user data on request", async () => {
    const { memory, store } = await setup();
    const session = await store.createSession({ id: crypto.randomUUID(), userId: "alice" });
    await memory.recordUserMessage({ userId: "alice", sessionId: session.id, text: "borrar todo" });
    await memory.deleteUser("alice");
    expect(await memory.exportUser("alice")).toMatchObject({ tasks: [] });
    expect((await memory.exportUser("alice")).sessions).toHaveLength(0);
  });
});
