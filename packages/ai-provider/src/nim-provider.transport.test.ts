import { describe, expect, it, vi, afterEach } from "vitest";
import { ProviderError } from "./errors.js";
import { NvidiaNimProvider } from "./nim-provider.js";
import type { NvidiaConfig } from "./config.js";

/**
 * Caracterización del TRANSPORTE de NIM (timeout, reintentos, abort, SSE).
 *
 * Congela el comportamiento observable que debe sobrevivir a la extracción
 * del transporte HTTP compartido (OCP/DRY) hacia `openai-compatible.ts`:
 * NIM y OpenRouter deben seguir fallando igual.
 */

export function nimConfig(overrides: Partial<NvidiaConfig> = {}): NvidiaConfig {
  return {
    apiKey: "nvapi-test",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    visionModel: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    embeddingModel: "nvidia/nemotron-3-embed-1b",
    timeoutMs: 5_000,
    maxTokens: 2_048,
    temperature: 0.2,
    streaming: "auto",
    maxRetries: 0,
    ...overrides,
  };
}

export function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NIM · clasificación de errores HTTP", () => {
  it.each([
    [401, "auth"],
    [404, "unavailable"],
    [410, "unavailable"],
    [429, "rate_limit"],
    [503, "unavailable"],
    [400, "invalid_request"],
  ])("traduce el %i a kind=%s", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));
    await expect(new NvidiaNimProvider(nimConfig()).chat({ messages: [] })).rejects.toMatchObject({ kind });
  });

  it("un 5xx es reintentable y un 401 no", () => {
    expect(new ProviderError("unavailable", "x", { retryable: true }).retryable).toBe(true);
    expect(new ProviderError("auth", "x").retryable).toBe(false);
  });
});

describe("NIM · reintentos", () => {
  it("reintenta un 503 hasta maxRetries y luego propaga el error", async () => {
    // Cada intento necesita una respuesta NUEVA: el cuerpo de un `Response`
    // solo se puede leer una vez, y reutilizar la misma instancia hacía que el
    // segundo intento fallara al leer el cuerpo ya consumido (y el error
    // acabara clasificado como "network" en lugar de "unavailable").
    const fetchMock = vi.fn().mockImplementation(async () => new Response("caído", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NvidiaNimProvider(nimConfig({ maxRetries: 2 }));
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ kind: "unavailable" });
    // 1 intento inicial + 2 reintentos.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("no reintenta un 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("sin credenciales", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NvidiaNimProvider(nimConfig({ maxRetries: 3 }));
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reintenta un 5xx y acaba bien", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("caído", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NvidiaNimProvider(nimConfig({ maxRetries: 1 }));
    const result = await provider.chat({ messages: [{ role: "user", content: "hola" }] });
    expect(result.content).toBe("hola");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("NIM · cancelación y presupuesto de tiempo", () => {
  it("el abort externo gana al timeout interno y no se reintenta", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NvidiaNimProvider(nimConfig({ timeoutMs: 10_000, maxRetries: 3 }));
    const promise = provider.chat({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("el timeout interno se traduce a un ProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("timeout"), { name: "AbortError" })),
          );
        }),
      ),
    );
    const provider = new NvidiaNimProvider(nimConfig({ timeoutMs: 20, maxRetries: 0 }));
    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("NIM · streaming SSE", () => {
  it("normaliza el contenido en deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ho" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "la" } }] }),
        ]),
      ),
    );
    const seen: string[] = [];
    const result = await new NvidiaNimProvider(nimConfig()).stream({ messages: [] }, (chunk) => {
      if (chunk.type === "delta") seen.push(chunk.text);
    });
    expect(seen).toEqual(["ho", "la"]);
    expect(result.content).toBe("hola");
    expect(result.streamed).toBe(true);
  });

  it("acumula tool_calls fragmentados en una sola llamada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "time_now", arguments: "" } }] } }],
          }),
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":"UTC"}' } }] } }],
          }),
        ]),
      ),
    );
    const result = await new NvidiaNimProvider(nimConfig()).stream({ messages: [] }, () => undefined);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("time_now");
    expect(result.toolCalls[0]?.arguments).toBe('{"tz":"UTC"}');
  });

  it("publica el razonamiento como chunk de tipo reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([JSON.stringify({ choices: [{ delta: { reasoning_content: "estoy pensando" } }] })]),
      ),
    );
    const seen: string[] = [];
    const result = await new NvidiaNimProvider(nimConfig()).stream({ messages: [] }, (chunk) => {
      if (chunk.type === "reasoning") seen.push(chunk.text);
    });
    expect(seen).toEqual(["estoy pensando"]);
    expect(result.reasoning).toBe("estoy pensando");
  });

  it("emite el uso de tokens cuando el proveedor lo informa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { content: "hola" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        ]),
      ),
    );
    let usage: { totalTokens?: number } | undefined;
    await new NvidiaNimProvider(nimConfig()).stream({ messages: [] }, (chunk) => {
      if (chunk.type === "usage") usage = chunk.usage;
    });
    expect(usage?.totalTokens).toBe(15);
  });
});
