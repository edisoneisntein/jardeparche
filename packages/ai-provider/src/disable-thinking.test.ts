import { describe, expect, it, vi, afterEach } from "vitest";
import { NvidiaNimProvider } from "./nim-provider.js";

const BASE = "https://integrate.api.nvidia.com/v1";

function provider(): NvidiaNimProvider {
  return new NvidiaNimProvider({
    apiKey: "nvapi-test",
    baseUrl: BASE,
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    visionModel: "v",
    embeddingModel: "e",
    timeoutMs: 5000,
    maxTokens: 512,
    temperature: 0.2,
    streaming: "auto",
    maxRetries: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("turno sin razonamiento", () => {
  it("envía chat_template_kwargs.enable_thinking=false cuando se pide", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provider().chat({ messages: [{ role: "user", content: "hola" }], disableThinking: true });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("no lo envía en un turno normal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provider().chat({ messages: [{ role: "user", content: "hola" }] });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.chat_template_kwargs).toBeUndefined();
  });
});
