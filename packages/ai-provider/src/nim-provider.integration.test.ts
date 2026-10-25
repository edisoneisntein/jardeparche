import { describe, expect, it } from "vitest";
import { hasNvidiaApiKey, loadNvidiaConfig } from "../src/config.js";
import { NvidiaNimProvider } from "../src/nim-provider.js";

const hasKey = hasNvidiaApiKey();
const suite = hasKey ? describe : describe.skip;

/**
 * Real integration test. Skipped automatically when NVIDIA_API_KEY is absent so
 * the unit suite always runs without credentials.
 */
suite("NVIDIA NIM live integration", () => {
  const provider = () => new NvidiaNimProvider(loadNvidiaConfig());

  it("reports health up", async () => {
    const health = await provider().health();
    expect(health.ok).toBe(true);
  });

  it("answers a plain chat completion", async () => {
    const result = await provider().chat({
      messages: [{ role: "user", content: "Respond with exactly the word: ready" }],
      maxTokens: 512,
      temperature: 0,
    });
    expect(result.content.toLowerCase()).toContain("ready");
  });

  it("streams content", async () => {
    const chunks: string[] = [];
    const result = await provider().stream(
      { messages: [{ role: "user", content: "Count from one to three." }], maxTokens: 512, temperature: 0 },
      (chunk) => {
        if (chunk.type === "delta") chunks.push(chunk.text);
      },
    );
    expect(result.streamed).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("emits a tool call when asked", async () => {
    const result = await provider().chat({
      messages: [{ role: "user", content: "Call the tool get_time now." }],
      tools: [
        { type: "function", function: { name: "get_time", description: "Get the current time", parameters: { type: "object", properties: {} } } },
      ],
      toolChoice: "auto",
      maxTokens: 1024,
      temperature: 0,
    });
    expect(result.toolCalls.some((call) => call.name === "get_time")).toBe(true);
  });

  it("produces embeddings", async () => {
    const result = await provider().embed(["the reactor is online"], "query");
    expect(result.dimensions).toBeGreaterThan(0);
  });
});
