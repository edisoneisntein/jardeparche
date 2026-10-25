import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";
import { readJsonCapped } from "../http-json.js";
import { federatedSearch } from "./federated-search.js";

const SearchSchema = z.object({
  query: z.string().min(1).max(400),
  count: z.number().int().min(1).max(10).default(5),
});

/** Esquema canónico de un resultado, común a los tres proveedores. */
export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  snippet: z.string(),
  engine: z.string().optional(),
  publishedDate: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Respuestas de los proveedores externos, validadas antes de tocar el modelo. */
const BraveResponseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().nullish(),
            url: z.string().nullish(),
            description: z.string().nullish(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const TavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string().nullish(),
        content: z.string().nullish(),
        published_date: z.string().nullish(),
      }),
    )
    .optional(),
});

/** Respuesta de una instancia SearXNG (formato JSON nativo). */
export const SearxngResponseSchema = z.object({
  query: z.string().optional(),
  number_of_results: z.number().optional(),
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string().nullish(),
        content: z.string().nullish(),
        engine: z.string().nullish(),
        publishedDate: z.string().nullish(),
      }),
    )
    .optional(),
  answers: z.array(z.unknown()).optional(),
  suggestions: z.array(z.string()).optional(),
  // SearXNG devuelve este campo en tresShapes distintos según versión:
  // array de cadenas, array de pares [motor, error] o array de objetos.
  unresponsive_engines: z
    .array(
      z.union([
        z.string(),
        z.tuple([z.string(), z.string()]),
        z.object({ engine: z.string().nullish(), error: z.string().nullish() }).passthrough(),
      ]),
    )
    .optional(),
});

/** Palabras vacías que no aportan señal de relevancia. */
const STOPWORDS = new Set([
  "para", "con", "por", "del", "las", "los", "las", "que", "como", "donde", "cuando", "este", "esta", "estos",
  "estas", "sobre", "entre", "desde", "hasta", "the", "and", "for", "with", "from", "into", "what", "how", "why",
  "when", "where", "which", "who", "does", "are", "you", "your", "tell", "give", "please",
]);

/** Términos significativos de la consulta (para el filtro de relevancia). */
export function significantTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((term) => term.replace(/^[."'¿¡]+|[."'¿¡]+$/g, ""))
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

/**
 * Filtro de relevancia determinista: un resultado se conserva si comparte al
 * menos un término significativo con la consulta. Sin este filtro, los
 * metasearch degradados devuelven ruido (páginas de terceros que coinciden con
 * una palabra suelta) y el agente se queda sin validación en un bucle.
 * Se declara cuántos resultados se descartaron: el filtrado no se disimula.
 */
export function filterByRelevance(query: string, results: SearchResult[]): { kept: SearchResult[]; discarded: number } {
  const terms = significantTerms(query);
  if (terms.length < 2) return { kept: results, discarded: 0 };
  const kept = results.filter((result) => {
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
  return { kept, discarded: results.length - kept.length };
}

/**
 * Sólo se admiten esquemas http(s): un resultado con `javascript:` o `file:`
 * en la URL es un vector de inyección hacia el cliente.
 */
export function isFetchableUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Elimina caracteres de control que un motor externo pudo inyectar. */
export function sanitizeText(value: string): string {
  // Caracteres de control (incluido NUL) y espacios repetidos.
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Web search mediante un proveedor explícitamente configurado. Sin
 * configuración la herramienta se anuncia como no disponible en lugar de
 * inventar resultados.
 *
 * Proveedores:
 *   · `brave`   → Brave Search API (necesita `WEB_SEARCH_API_KEY`).
 *   · `tavily`  → Tavily Search API (necesita `WEB_SEARCH_API_KEY`).
 *   · `endless` → instancia SearXNG con salida JSON (`ENDLESS_BASE_URL`,
 *     por defecto `https://api.endless.sbs`). La clave es opcional: las
 *     instancias privadas la exigen, las públicas no.
 *   · `federated` → meta-buscador de fuentes abiertas sin clave (Wikipedia,
 *     DuckDuckGo Instant Answer, Google News RSS, Hacker News, Stack
 *     Exchange). No requiere ninguna credencial: es la opción de coste cero.
 */
export function createWebSearchTool(services: ToolServices): ToolDefinition<z.infer<typeof SearchSchema>> {
  const { webSearch } = services.config;

  const keyFor = (): string | undefined =>
    webSearch.provider === "endless" ? webSearch.endlessApiKey ?? webSearch.apiKey : webSearch.apiKey;

  const availability = (): { available: boolean; reason?: string } => {
    if (!webSearch.provider) {
      return { available: false, reason: "WEB_SEARCH_PROVIDER no configurado" };
    }
    // `federated` y `endless` no exigen credencial: son la vía de coste cero.
    if (webSearch.provider !== "endless" && webSearch.provider !== "federated" && !webSearch.apiKey) {
      return { available: false, reason: "WEB_SEARCH_API_KEY no configurado" };
    }
    if (webSearch.provider === "endless" && !webSearch.endlessBaseUrl) {
      return { available: false, reason: "ENDLESS_BASE_URL no configurado" };
    }
    return { available: true };
  };

  return {
    name: "web.search",
    title: "Búsqueda web",
    description:
      "Busca información pública en la web mediante el proveedor configurado y devuelve enlaces y extractos. Usa un motor de búsqueda real, no una base de conocimiento local.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 12_000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Consulta de búsqueda" },
        count: { type: "number", description: "Número de resultados (1-10)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse: (raw) => SearchSchema.parse(raw),
    availability,
    execute: async (input, ctx: ToolContext) => {
      const state = availability();
      if (!state.available) {
        return { ok: false, summary: "La búsqueda web no está configurada.", unavailable: true, error: state.reason };
      }
      const apiKey = keyFor();
      try {
        const outcome =
          webSearch.provider === "brave"
            ? await braveSearch(input.query, input.count, apiKey ?? "", ctx.signal)
            : webSearch.provider === "tavily"
              ? await tavilySearch(input.query, input.count, apiKey ?? "", ctx.signal)
              : webSearch.provider === "federated"
                ? await federatedOutcome(input.query, input.count, ctx.signal)
                : await searxngSearch(input.query, input.count, apiKey, webSearch.endlessBaseUrl ?? "https://api.endless.sbs", webSearch.engines, ctx.signal);
        const relevance = filterByRelevance(input.query, outcome.results);
        const results = relevance.kept;
        const hint = "hint" in outcome ? (outcome as { hint?: string }).hint : undefined;
        const degraded = outcome.unresponsiveEngines.length > 0;
        return {
          ok: true,
          data: {
            query: input.query,
            provider: webSearch.provider,
            results,
            // Estado real del motor: se declara, no se disimula.
            unresponsive_engines: outcome.unresponsiveEngines,
            degraded,
            discarded_irrelevant: relevance.discarded,
            total_available: outcome.totalAvailable,
            ...(hint ? { hint } : {}),
            ...("variantsTried" in outcome
              ? { query_variants_tried: (outcome as { variantsTried: string[] }).variantsTried }
              : {}),
            ...("variantUsed" in outcome && (outcome as { variantUsed?: string }).variantUsed
              ? { query_used: (outcome as { variantUsed: string }).variantUsed }
              : {}),
          },
          summary: results.length
            ? `${results.length} resultado(s) para «${input.query}»: ${results.map((r) => r.title).join("; ")}${relevance.discarded ? ` (${relevance.discarded} descartado(s) por irrelevancia)` : ""}${degraded ? ` (motores con error: ${outcome.unresponsiveEngines.join(", ")})` : ""}`
            : `Sin resultados relevantes para «${input.query}»${relevance.discarded ? ` (${relevance.discarded} descartado(s) por irrelevancia)` : ""}${degraded ? `. Motores con error: ${outcome.unresponsiveEngines.join(", ")}` : ""}.`,
          unavailable: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = /abort/i.test(message);
        return {
          ok: false,
          summary: aborted
            ? `La búsqueda web se canceló: ${message}`
            : `La búsqueda web falló: ${message}`,
          unavailable: false,
          error: aborted ? "search_aborted" : "search_failed",
        };
      }
    },
  };
}

/** Adapta el meta-buscador federado al contrato común de la tool. */
async function federatedOutcome(
  query: string,
  count: number,
  signal?: AbortSignal,
): Promise<SearchOutcome & { hint?: string; variantsTried: string[]; variantUsed?: string }> {
  const outcome = await federatedSearch(query, { limit: count, lang: "es", signal });
  return {
    results: outcome.results,
    unresponsiveEngines: outcome.unresponsiveEngines,
    totalAvailable: outcome.totalAvailable,
    hint: outcome.hint,
    variantsTried: outcome.variantsTried,
    variantUsed: outcome.variantUsed,
  };
}

interface SearchOutcome {
  results: SearchResult[];
  /** Motores del metasearch que respondieron con error en esta consulta. */
  unresponsiveEngines: string[];
  /** Estimación de resultados disponibles en el índice. */
  totalAvailable?: number;
}

async function braveSearch(query: string, count: number, apiKey: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const response = await fetch(url.toString(), { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`Brave respondió ${response.status}`);
  const parsed = BraveResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`respuesta de Brave no válida: ${parsed.error.message.slice(0, 120)}`);
  const results = (parsed.data.web?.results ?? [])
    .map((entry) => toResult({ title: entry.title, url: entry.url, snippet: entry.description }))
    .filter((entry): entry is SearchResult => entry !== null)
    .slice(0, count);
  return { results, unresponsiveEngines: [] };
}

async function tavilySearch(query: string, count: number, apiKey: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count }),
    signal,
  });
  if (!response.ok) throw new Error(`Tavily respondió ${response.status}`);
  const parsed = TavilyResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`respuesta de Tavily no válida: ${parsed.error.message.slice(0, 120)}`);
  const results = (parsed.data.results ?? [])
    .map((entry) => toResult({ title: entry.title, url: entry.url, snippet: entry.content, publishedDate: entry.published_date }))
    .filter((entry): entry is SearchResult => entry !== null)
    .slice(0, count);
  return { results, unresponsiveEngines: [] };
}

/**
 * Instancia SearXNG (formato JSON nativo). `ENDLESS_BASE_URL` por defecto
 * apunta a `https://api.endless.sbs`. La clave es opcional.
 */
async function searxngSearch(
  query: string,
  count: number,
  apiKey: string | undefined,
  baseUrl: string,
  engines: string[] | undefined,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "es");
  if (engines && engines.length > 0) url.searchParams.set("engines", engines.join(","));

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const response = await fetch(url.toString(), { headers, signal });
  if (!response.ok) throw new Error(`el motor de búsqueda respondió ${response.status}`);
  const parsed = SearxngResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`respuesta del motor no válida: ${parsed.error.message.slice(0, 120)}`);

  const results = (parsed.data.results ?? [])
    .map((entry) => toResult({ title: entry.title, url: entry.url, snippet: entry.content, engine: entry.engine, publishedDate: entry.publishedDate }))
    .filter((entry): entry is SearchResult => entry !== null)
    .slice(0, count);

  const unresponsiveEngines = (parsed.data.unresponsive_engines ?? [])
    .map((entry) => {
      if (typeof entry === "string") return entry.split(",")[0]?.trim() || entry;
      if (Array.isArray(entry)) return entry[0]?.trim() || "desconocido";
      return entry?.engine?.trim() || "desconocido";
    })
    .filter((value, index, all) => all.indexOf(value) === index && value.length > 0);

  return { results, unresponsiveEngines, totalAvailable: parsed.data.number_of_results };
}

/** Normaliza y valida un resultado externo. Descarta lo no publicable. */
function toResult(input: {
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  engine?: string | null;
  publishedDate?: string | null;
}): SearchResult | null {
  const url = (input.url ?? "").trim();
  if (!url || !isFetchableUrl(url)) return null;
  const result: SearchResult = {
    title: sanitizeText(input.title ?? "(sin título)").slice(0, 300),
    url,
    snippet: sanitizeText(input.snippet ?? "").slice(0, 2000),
  };
  if (input.engine) result.engine = sanitizeText(input.engine).slice(0, 40);
  if (input.publishedDate) result.publishedDate = sanitizeText(input.publishedDate).slice(0, 40);
  return result;
}
