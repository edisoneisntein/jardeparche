import { describe, expect, it, vi, afterEach } from "vitest";
import { createWebSearchTool, filterByRelevance, isFetchableUrl, sanitizeText, significantTerms } from "./builtin/web-search.js";
import { MemoryService } from "@jarvis/memory";
import { MemoryStore } from "@jarvis/memory";
import type { ToolContext } from "@jarvis/shared";

const memory = new MemoryService({ store: new MemoryStore() });

function tool(config: {
  provider?: "brave" | "tavily" | "endless";
  apiKey?: string;
  endlessBaseUrl?: string;
  endlessApiKey?: string;
  engines?: string[];
}) {
  return createWebSearchTool({
    memory,
    config: {
      documentsRoots: [],
      webSearch: {
        provider: config.provider,
        apiKey: config.apiKey,
        endlessBaseUrl: config.endlessBaseUrl ?? "https://api.endless.sbs",
        endlessApiKey: config.endlessApiKey,
        engines: config.engines ?? [],
      },
      maxResultBytes: 256 * 1024,
    },
  });
}

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "task",
  correlationId: "corr",
  now: () => new Date(),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isFetchableUrl", () => {
  it("acepta http y https", () => {
    expect(isFetchableUrl("https://example.com/a")).toBe(true);
    expect(isFetchableUrl("http://example.com/a")).toBe(true);
  });

  it("rechaza esquemas peligrosos o inválidos", () => {
    expect(isFetchableUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableUrl("data:text/html,<script>")).toBe(false);
    expect(isFetchableUrl("no-es-una-url")).toBe(false);
  });
});

describe("sanitizeText", () => {
  it("elimina caracteres de control y colapsa espacios", () => {
    expect(sanitizeText("hola\u0000\u0007\n  mundo")).toBe("hola mundo");
  });
});

describe("filtro de relevancia", () => {
  it("extrae términos significativos y descarta las vacías", () => {
    const terms = significantTerms("¿Quién creó el protocolo MCP para los asistentes?");
    expect(terms).toContain("protocolo");
    expect(terms).toContain("mcp");
    expect(terms).not.toContain("para");
    expect(terms).not.toContain("los");
  });

  it("descarta el ruido que no comparte términos con la consulta", () => {
    const results = [
      { title: "Ohio State Buckeyes - Wikipedia", url: "https://a.com/1", snippet: "equipo de fútbol" },
      { title: "Model Context Protocol - Wikipedia", url: "https://b.com/2", snippet: "protocolo de código abierto" },
    ];
    const outcome = filterByRelevance("Model Context Protocol", results);
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.kept[0]?.url).toBe("https://b.com/2");
    expect(outcome.discarded).toBe(1);
  });

  it("no filtra cuando la consulta tiene menos de dos términos", () => {
    const results = [{ title: "X", url: "https://a.com/1", snippet: "y" }];
    expect(filterByRelevance("clima", results).kept).toHaveLength(1);
  });
});

describe("availability", () => {
  it("sin proveedor: no disponible con motivo", () => {
    const availability = tool({}).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("WEB_SEARCH_PROVIDER");
  });

  it("brave o tavily sin clave: no disponible con motivo", () => {
    const availability = tool({ provider: "brave" }).availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("WEB_SEARCH_API_KEY");
  });

  it("endless sin clave: disponible (las instancias públicas no la exigen)", () => {
    const availability = tool({ provider: "endless" }).availability();
    expect(availability.available).toBe(true);
  });
});

describe("adaptadores", () => {
  it("brave mapea description a snippet", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://a.com", description: "D" }] } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool({ provider: "brave", apiKey: "k" }).execute({ query: "q", count: 5 }, ctx);
    const data = result.data as { results: Array<{ snippet: string; url: string }> };
    expect(data.results[0]?.snippet).toBe("D");
    expect(data.results[0]?.url).toBe("https://a.com");
  });

  it("tavily mapea content a snippet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [{ title: "T", url: "https://a.com", content: "C" }] }), { status: 200 })),
    );
    const result = await tool({ provider: "tavily", apiKey: "k" }).execute({ query: "q", count: 5 }, ctx);
    expect((result.data as { results: Array<{ snippet: string }> }).results[0]?.snippet).toBe("C");
  });

  it("endless consulta /search con format=json y la clave opcional", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: "q",
          number_of_results: 42,
          results: [{ title: "T", url: "https://a.com", content: "C", engine: "bing" }],
          unresponsive_engines: [{ engine: "google", error: "too many requests" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await tool({ provider: "endless", endlessApiKey: "endless_sk_x" }).execute({ query: "q", count: 5 }, ctx);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/search?");
    expect(url).toContain("format=json");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("endless_sk_x");
    const data = result.data as { results: Array<{ engine?: string }>; degraded: boolean; unresponsive_engines: string[]; total_available: number };
    expect(data.results[0]?.engine).toBe("bing");
    expect(data.degraded).toBe(true);
    expect(data.unresponsive_engines).toEqual(["google"]);
    expect(data.total_available).toBe(42);
  });

  it("endless propaga los motores configurados", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await tool({ provider: "endless", engines: ["brave", "wikipedia"] }).execute({ query: "q", count: 5 }, ctx);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("engines=brave%2Cwikipedia");
  });

  it("descarta resultados con URL no publicable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              { title: "malo", url: "javascript:alert(1)", content: "x" },
              { title: "bueno", url: "https://a.com", content: "y" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await tool({ provider: "endless" }).execute({ query: "q", count: 5 }, ctx);
    const results = (result.data as { results: Array<{ url: string }> }).results;
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://a.com");
  });

  it("rechaza una respuesta con forma inesperada", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: "no-es-un-array" }), { status: 200 })));
    const result = await tool({ provider: "endless" }).execute({ query: "q", count: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("search_failed");
  });

  it("informa del error HTTP del proveedor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    const result = await tool({ provider: "endless" }).execute({ query: "q", count: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("503");
  });

  it("propaga la señal de cancelación al fetch", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await tool({ provider: "endless" }).execute({ query: "q", count: 5 }, { ...ctx, signal: controller.signal });
    expect(fetchMock).toHaveBeenCalled();
  });
});
