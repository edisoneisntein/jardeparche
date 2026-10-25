import { describe, expect, it } from "vitest";
import { loadNvidiaConfig } from "../src/config.js";
import { classifyHttp, ProviderError } from "../src/errors.js";
import { FakeProvider } from "../src/fake-provider.js";

const baseEnv = {
  NVIDIA_API_KEY: "test-key",
};

describe("loadNvidiaConfig", () => {
  it("rejects a missing API key with an actionable message", () => {
    expect(() => loadNvidiaConfig({})).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it("applies documented defaults", () => {
    const config = loadNvidiaConfig(baseEnv);
    expect(config.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxTokens).toBe(2048);
    expect(config.streaming).toBe("auto");
  });

  it("coerces numeric env strings", () => {
    const config = loadNvidiaConfig({ ...baseEnv, NVIDIA_TIMEOUT_MS: "1234", NVIDIA_TEMPERATURE: "0.7" });
    expect(config.timeoutMs).toBe(1234);
    expect(config.temperature).toBe(0.7);
  });
});

describe("classifyHttp", () => {
  it.each([
    [401, "auth", false],
    [404, "unavailable", false],
    [429, "rate_limit", true],
    [503, "unavailable", true],
    [400, "invalid_request", false],
  ])("maps %i to %s", (status, kind, retryable) => {
    const error = classifyHttp(status, "body");
    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
  });
});

describe("FakeProvider", () => {
  it("streams deterministic tokens and completes", async () => {
    const provider = new FakeProvider([{ content: "hola mundo" }]);
    const chunks: string[] = [];
    const result = await provider.stream({ messages: [{ role: "user", content: "hi" }] }, (chunk) => {
      if (chunk.type === "delta") chunks.push(chunk.text);
    });
    expect(result.content).toBe("hola mundo");
    expect(chunks.join("")).toBe("hola mundo");
    expect(result.streamed).toBe(true);
  });

  it("surfaces tool calls", async () => {
    const provider = new FakeProvider([
      { toolCalls: [{ id: "c1", name: "get_time", arguments: "{}" }] },
    ]);
    const result = await provider.chat({ messages: [] });
    expect(result.toolCalls[0]?.name).toBe("get_time");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("throws retryable ProviderError for simulated network failures", async () => {
    const provider = new FakeProvider([{ error: { kind: "network", message: "boom" } }]);
    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });

  it("produces stable embeddings", async () => {
    const provider = new FakeProvider();
    const first = await provider.embed(["jarvis memory"]);
    const second = await provider.embed(["jarvis memory"]);
    expect(first.vectors[0]).toEqual(second.vectors[0]);
    expect(first.dimensions).toBe(32);
  });
});
