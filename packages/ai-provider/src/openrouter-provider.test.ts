import { describe, expect, it, vi, afterEach } from "vitest";
import { classifyOpenRouterHttp, loadOpenRouterConfig, OpenRouterProvider, type OpenRouterConfig } from "./openrouter-provider.js";

function config(overrides: Partial<OpenRouterConfig> = {}): OpenRouterConfig {
  return {
    apiKey: "sk-or-test",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "minimax/minimax-m3.1-flash",
    timeoutMs: 5_000,
    maxTokens: 4_096,
    maxRetries: 0,
    appTitle: "JARVIS",
    appUrl: "http://localhost:8787",
    ...overrides,
  };
}

function sse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadOpenRouterConfig", () => {
  it("devuelve null si no hay clave: no es un error, simplemente no hay respaldo", () => {
    expect(loadOpenRouterConfig({})).toBeNull();
    expect(loadOpenRouterConfig({ OPENROUTER_API_KEY: "  " })).toBeNull();
  });

  it("carga la configuración con valores por defecto", () => {
    const loaded = loadOpenRouterConfig({ OPENROUTER_API_KEY: "sk-or-x" });
    expect(loaded?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(loaded?.model).toBe("minimax/minimax-m3.1-flash");
  });

  it("ignora un reasoning_effort inválido en lugar de romper el arranque", () => {
    const loaded = loadOpenRouterConfig({ OPENROUTER_API_KEY: "sk-or-x", OPENROUTER_REASONING_EFFORT: "turbo" });
    expect(loaded?.reasoningEffort).toBeUndefined();
  });

  it("acepta un reasoning_effort válido", () => {
    const loaded = loadOpenRouterConfig({ OPENROUTER_API_KEY: "sk-or-x", OPENROUTER_REASONING_EFFORT: "low" });
    expect(loaded?.reasoningEffort).toBe("low");
  });
});

describe("classifyOpenRouterHttp", () => {
  it("clasifica los códigos relevantes", () => {
    expect(classifyOpenRouterHttp(401, "").kind).toBe("auth");
    expect(classifyOpenRouterHttp(402, "").kind).toBe("unavailable");
    expect(classifyOpenRouterHttp(404, "").kind).toBe("unavailable");
    expect(classifyOpenRouterHttp(429, "").kind).toBe("rate_limit");
    expect(classifyOpenRouterHttp(500, "").kind).toBe("unavailable");
    expect(classifyOpenRouterHttp(400, "").kind).toBe("invalid_request");
  });
});

describe("OpenRouterProvider", () => {
  it("envía las cabeceras de autenticación y atribución", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenRouterProvider(config());
    const result = await provider.chat({ messages: [{ role: "user", content: "hola" }] });
    expect(result.content).toBe("hola");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    expect(headers["X-Title"]).toBe("JARVIS");
    expect(String(init.body)).toContain("minimax/minimax-m3.1-flash");
  });

  it("añade reasoning_effort solo cuando está configurado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new OpenRouterProvider(config({ reasoningEffort: "low" })).chat({ messages: [{ role: "user", content: "hola" }] });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain('"reasoning_effort":"low"');
  });

  it("normaliza reasoning y reasoning_content al chunk de razonamiento", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { reasoning: "pensando" } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: "mas pensar" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "respuesta" } }] }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(chunks)));
    const provider = new OpenRouterProvider(config());
    const seen: string[] = [];
    const result = await provider.stream({ messages: [{ role: "user", content: "hola" }] }, (chunk) => {
      if (chunk.type === "reasoning") seen.push(`razonamiento:${chunk.text}`);
      if (chunk.type === "delta") seen.push(`contenido:${chunk.text}`);
    });
    expect(seen).toEqual(["razonamiento:pensando", "razonamiento:mas pensar", "contenido:respuesta"]);
    expect(result.content).toBe("respuesta");
    expect(result.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("acumula tool_calls fragmentados", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "time_now", arguments: "" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":"UTC"}' } }] } }] }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse(chunks)));
    const provider = new OpenRouterProvider(config());
    const result = await provider.stream({ messages: [{ role: "user", content: "hora" }] }, () => undefined);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("time_now");
    expect(result.toolCalls[0]?.arguments).toBe('{"tz":"UTC"}');
  });

  it("lee las capacidades REALES del catálogo de OpenRouter", async () => {
    const catalog = {
      data: [
        {
          id: "minimax/minimax-m3.1-flash",
          supported_parameters: ["stream", "tools", "tool_choice", "reasoning"],
          architecture: { input_modalities: ["text", "image", "video"] },
        },
        { id: "otro/modelo", supported_parameters: ["stream"], architecture: { input_modalities: ["text"] } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 })));
    const provider = new OpenRouterProvider(config());
    const capabilities = await provider.capabilities();
    expect(capabilities.source).toBe("probe");
    expect(capabilities.model).toBe("minimax/minimax-m3.1-flash");
    expect(capabilities.streaming).toBe(true);
    expect(capabilities.tools).toBe(true);
    expect(capabilities.vision).toBe(true);
  });

  it("reporta un modelo ausente del catálogo como no disponible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const capabilities = await new OpenRouterProvider(config()).capabilities();
    expect(capabilities.chat).toBe(false);
    expect(capabilities.notes).toContain("no figura en el catálogo");
  });

  it("el health distingue alcanzable-con-modelo y alcanzable-sin-modelo", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "minimax/minimax-m3.1-flash" }] }), { status: 200 })));
    const ok = await new OpenRouterProvider(config()).health();
    expect(ok.ok).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "otro" }] }), { status: 200 })));
    const sinModelo = await new OpenRouterProvider(config()).health();
    expect(sinModelo.ok).toBe(false);
    expect(sinModelo.detail).toContain("no figura en el catálogo");
  });

  it("informa con claridad cuando el modelo no expone embeddings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "no embeddings" }), { status: 404 })));
    const provider = new OpenRouterProvider(config());
    await expect(provider.embed(["hola"])).rejects.toThrow(/no ofrece embeddings/);
  });
});
