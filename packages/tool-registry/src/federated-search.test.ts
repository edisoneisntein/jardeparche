import { describe, expect, it, vi, afterEach } from "vitest";
import { federatedSearch, htmlToText } from "./builtin/federated-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("htmlToText", () => {
  it("quita etiquetas y decodifica entidades", () => {
    expect(htmlToText("<a href=\"x\">Título</a> &amp; más &#x2F; fin")).toBe("Título & más / fin");
  });
});

describe("federatedSearch", () => {
  it("fusiona varias fuentes, deduplica y ordena por cobertura de términos", async () => {
    const fetchMock = vi.fn((input: string) => {
      const url = String(input);
      if (url.includes("wikipedia.org")) {
        return Promise.resolve(
          jsonResponse({
            pages: [
              { key: "Protocolo_de_Contexto_de_Modelo", title: "Protocolo de Contexto de Modelo", description: "estándar de Anthropic", excerpt: "MCP" },
              { key: "Ajeno", title: "Ajeno", description: "sin relación", excerpt: "" },
            ],
          }),
        );
      }
      if (url.includes("api.duckduckgo.com")) {
        // DuckDuckGo responde 202 con el cuerpo correcto.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              AbstractText: "El Model Context Protocol es un estándar abierto",
              AbstractURL: "https://en.wikipedia.org/wiki/Model_Context_Protocol",
              Heading: "Model Context Protocol",
              RelatedTopics: [],
              Results: [],
            }),
            { status: 202 },
          ),
        );
      }
      if (url.includes("news.google.com")) {
        return Promise.resolve(
          new Response(
            "<rss><channel><item><title>Anthropic publica el protocolo</title><link>https://news.example/a</link><pubDate>Fri, 16 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>",
            { status: 200, headers: { "Content-Type": "application/rss+xml" } },
          ),
        );
      }
      if (url.includes("html.duckduckgo.com")) {
        return Promise.resolve(
          new Response(
            '<a rel="nofollow" class="result__a" href="https://modelcontextprotocol.io/docs">Build an MCP server</a>' +
              '<a class="result__snippet" href="https://modelcontextprotocol.io/docs">Como crear un servidor MCP</a>',
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
        );
      }
      if (url.includes("hn.algolia.com")) {
        return Promise.resolve(
          jsonResponse({ hits: [{ title: "MCP y el ecosistema", url: "https://news.ycombinator.com/item?id=1", objectID: "1", created_at: "2026-10-16" }] }),
        );
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await federatedSearch("model context protocol", { limit: 5, lang: "es" });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.unresponsiveEngines).toHaveLength(0);
    expect(outcome.degraded).toBe(false);
    // La búsqueda web real de DuckDuckGo entra en la fusión.
    expect(outcome.results.some((r) => r.engine === "duckduckgo_web")).toBe(true);
    // Wikipedia y DuckDuckGo apuntan al mismo artículo: se deduplica.
    const urls = outcome.results.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
    // Cada snippet lleva su procedencia y está acotado.
    for (const result of outcome.results) {
      expect(result.snippet.length).toBeLessThanOrEqual(300);
      expect(result.snippet.startsWith("[")).toBe(true);
    }
  });

  it("degrada con honestidad: una fuente caída se declara y las demás siguen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        const url = String(input);
        if (url.includes("wikipedia.org")) return Promise.reject(new Error("HTTP 429"));
        if (url.includes("api.duckduckgo.com")) {
          return Promise.resolve(new Response(JSON.stringify({ AbstractText: "x", AbstractURL: "https://a.com", RelatedTopics: [] }), { status: 202 }));
        }
        if (url.includes("html.duckduckgo.com")) {
          return Promise.resolve(new Response("<html>challenge</html>", { status: 202, headers: { "Content-Type": "text/html" } }));
        }
        return Promise.resolve(jsonResponse({ hits: [], items: [], pages: [] }));
      }),
    );
    const outcome = await federatedSearch("protocolo de contexto de modelo", { limit: 5 });
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.unresponsiveEngines.some((entry) => entry.startsWith("wikipedia"))).toBe(true);
    expect(outcome.unresponsiveEngines.some((entry) => entry.startsWith("duckduckgo_web"))).toBe(true);
    expect(outcome.degraded).toBe(true);
  });

  it("sin resultados entrega una pista para que el agente no se repita", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("<html>sin resultados</html>", { status: 200, headers: { "Content-Type": "text/html" } }))),
    );
    const outcome = await federatedSearch("consulta sin nada", { limit: 5 });
    expect(outcome.results).toHaveLength(0);
    expect(outcome.degraded).toBe(true);
    expect(outcome.hint).toMatch(/No repitas/i);
  });

  it("no consulta Stack Exchange si la consulta no es técnica", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("<html>sin resultados</html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    vi.stubGlobal("fetch", fetchMock);
    await federatedSearch("qué es el amor", { limit: 3 });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("stackexchange"))).toBe(false);
  });

  it("propaga la señal de cancelación a las fuentes", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      expect(init.signal).toBeDefined();
      return Promise.resolve(new Response("<html>sin resultados</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await federatedSearch("consulta", { limit: 3, signal: controller.signal });
    expect(fetchMock).toHaveBeenCalled();
  });
});
