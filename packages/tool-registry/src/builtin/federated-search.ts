import { z } from "zod";
import { readJsonCapped } from "../http-json.js";
import { isFetchableUrl, sanitizeText, type SearchResult } from "./web-search.js";

/**
 * Meta-buscador federado: consulta en paralelo varias fuentes abiertas que NO
 * exigen registro ni clave y que, a diferencia de los motores generalistas con
 * challenges JS, responden de forma estable desde un servidor.
 *
 * Fuentes y qué cubre cada una:
 *   · `wikipedia`    → conceptos y entidades (incluye Wikidata y artículos técnicos).
 *   · `duckduckgo`   → definiciones (Instant Answer) y temas relacionados.
 *   · `google_news`  → actualidad, anuncios, finanzas y noticias recientes.
 *   · `hackernews`   → lanzamientos, IA y discusiones técnicas.
 *   · `stackexchange`→ preguntas de programación y sus errores.
 *
 * El diseño es *fail-soft*: si una fuente falla, el turno continúa con las
 * demás y la fuente caída se declara en `unresponsive_engines`. Si ninguna
 * responde, se devuelve la verdad: cero resultados y `degraded: true`.
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

/**
 * Cabeceras que DuckDuckGo exige en su endpoint HTML. Sin este conjunto
 * (navegador + cabeceras de navegación) la respuesta es la página de challenge
 * (HTTP 202) en lugar de resultados.
 */
const DDG_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-Ch-Ua": '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

/** DuckDuckGo bloquea el rastreo agresivo: se espacia cada consulta. */
const DDG_MIN_INTERVAL_MS = 1_200;
let lastDdgQueryAt = 0;

/** Tope por fuente: menor que el presupuesto de la tool (12 s). */
const SOURCE_TIMEOUT_MS = 8_000;
/** Tope de caracteres por snippet: evita saturar la ventana de contexto. */
const SNIPPET_MAX = 300;

export interface FederatedOptions {
  limit?: number;
  lang?: string;
  signal?: AbortSignal;
  /** Fuentes a consultar. Vacío = todas. */
  sources?: string[];
}

export interface FederatedOutcome {
  results: SearchResult[];
  unresponsiveEngines: string[];
  degraded: boolean;
  discarded: number;
  totalAvailable: number;
  /** Pistas para el agente cuando no hay nada que devolver. */
  hint?: string;
  /** Variantes de consulta que se han intentado, en orden. */
  variantsTried: string[];
  /** Variante que produjo los resultados. */
  variantUsed?: string;
}

const WikipediaResponseSchema = z.object({
  pages: z
    .array(
      z.object({
        key: z.string().nullish(),
        title: z.string().nullish(),
        excerpt: z.string().nullish(),
        description: z.string().nullish(),
      }),
    )
    .optional(),
});

const DuckResponseSchema = z.object({
  AbstractText: z.string().nullish(),
  AbstractURL: z.string().nullish(),
  Heading: z.string().nullish(),
  RelatedTopics: z
    .array(z.object({ Text: z.string().nullish(), FirstURL: z.string().nullish() }).passthrough())
    .optional(),
  Results: z.array(z.object({ Result: z.string().nullish(), FirstURL: z.string().nullish() }).passthrough()).optional(),
});

const HnResponseSchema = z.object({
  hits: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string().nullish(),
        story_text: z.string().nullish(),
        objectID: z.string().nullish(),
        created_at: z.string().nullish(),
      }),
    )
    .optional(),
});

const StackExchangeResponseSchema = z.object({
  items: z
    .array(z.object({ title: z.string().nullish(), link: z.string().nullish(), score: z.number().optional(), is_answered: z.boolean().optional() }))
    .optional(),
});

/** Quita etiquetas HTML y decodifica entidades básicas. */
export function htmlToText(value: string): string {
  return sanitizeText(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16))),
  );
}

/** Compacta un snippet y le antepone la procedencia. */
function compact(snippet: string, provenance: string): string {
  const text = htmlToText(snippet);
  const prefix = `[${provenance}] `;
  const room = Math.max(0, SNIPPET_MAX - prefix.length);
  return prefix + (text.length > room ? `${text.slice(0, room).trimEnd()}…` : text);
}

function titleOf(text: string): string {
  const clean = htmlToText(text);
  const separator = clean.indexOf(" - ");
  return separator > 0 ? clean.slice(0, separator) : clean;
}

async function fetchWithTimeout(url: string, signal: AbortSignal | undefined, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("source timeout")), SOURCE_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function fetchWikipedia(query: string, lang: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=3`;
  const response = await fetchWithTimeout(url, signal, "application/json");
  const parsed = WikipediaResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`wikipedia: ${parsed.error.message.slice(0, 80)}`);
  const pages: SearchResult[] = [];
  for (const page of parsed.data.pages ?? []) {
    const key = page.key ?? "";
    if (!key) continue;
    const snippet = [page.description, page.excerpt].filter(Boolean).join(". ");
    pages.push({
      title: sanitizeText(page.title ?? key),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(key)}`,
      snippet: compact(snippet, "Wikipedia"),
      engine: "wikipedia",
    });
  }
  return pages;
}

async function fetchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  // DuckDuckGo responde 202 con el cuerpo correcto: no es un rechazo.
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal });
  const parsed = DuckResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`duckduckgo: ${parsed.error.message.slice(0, 80)}`);

  const results: SearchResult[] = [];
  if (parsed.data.AbstractText && parsed.data.AbstractURL) {
    results.push({
      title: sanitizeText(parsed.data.Heading ?? query),
      url: parsed.data.AbstractURL,
      snippet: compact(parsed.data.AbstractText, "DuckDuckGo"),
      engine: "duckduckgo",
    });
  }
  for (const topic of (parsed.data.RelatedTopics ?? []).slice(0, 3)) {
    if (!topic.Text || !topic.FirstURL) continue;
    results.push({
      title: titleOf(topic.Text) || sanitizeText(topic.Text),
      url: topic.FirstURL,
      snippet: compact(topic.Text, "DuckDuckGo"),
      engine: "duckduckgo",
    });
  }
  for (const entry of (parsed.data.Results ?? []).slice(0, 2)) {
    if (!entry.Result || !entry.FirstURL) continue;
    results.push({
      title: titleOf(entry.Result) || sanitizeText(entry.Result),
      url: entry.FirstURL,
      snippet: compact(entry.Result, "DuckDuckGo"),
      engine: "duckduckgo",
    });
  }
  return results;
}

async function fetchGoogleNews(query: string, lang: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const hl = lang === "es" ? "es-419" : "en-US";
  const ceid = `US:${hl}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=US&ceid=${ceid}`;
  const response = await fetchWithTimeout(url, signal, "application/rss+xml");
  const xml = await response.text();
  const items: SearchResult[] = [];
  const pattern = /<item>([\s\S]*?)<\/item>/g;
  let match = pattern.exec(xml);
  while (match && items.length < 4) {
    const block = match[1] ?? "";
    const title = htmlToText((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "");
    const link = htmlToText((block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? "");
    const pubDate = htmlToText((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1] ?? "");
    if (title && link) {
      const item: SearchResult = {
        title,
        url: link,
        snippet: compact(`Noticia publicada: ${pubDate}. ${title}`, "Google News"),
        engine: "google_news",
      };
      if (pubDate) item.publishedDate = pubDate;
      items.push(item);
    }
    match = pattern.exec(xml);
  }
  return items;
}

/**
 * Búsqueda web real de DuckDuckGo (endpoint HTML con POST).
 *
 * Es el único motor generalista que responde sin clave desde un servidor: el
 * GET sobre `?q=` devuelve la página de challenge, pero el POST del formulario
 * con cabeceras de navegador devuelve resultados reales.
 */
async function fetchDuckDuckGoWeb(query: string, lang: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const wait = lastDdgQueryAt + DDG_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastDdgQueryAt = Date.now();

  const body = new URLSearchParams({
    q: query,
    b: "",
    kl: lang === "es" ? "es-es" : "wt-wt",
    kp: "-2",
  });
  const response = await fetch("https://html.duckduckgo.com/html", {
    method: "POST",
    headers: { ...DDG_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  // Página de challenge: no hay resultados y hay que decirlo.
  if (/anomaly|challenge|captcha|unusual traffic/i.test(html) || !html.includes("result__a")) {
    throw new Error("DuckDuckGo devolvió una página de challenge en lugar de resultados");
  }

  const snippets = new Map<string, string>();
  for (const match of html.matchAll(/class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    snippets.set(match[1] ?? "", htmlToText(match[2] ?? ""));
  }

  const results: SearchResult[] = [];
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match = pattern.exec(html);
  while (match && results.length < 8) {
    const url = match[1] ?? "";
    const title = htmlToText(match[2] ?? "");
    if (url && title && isFetchableUrl(url)) {
      results.push({
        title,
        url,
        snippet: compact(snippets.get(url) ?? title, "DuckDuckGo"),
        engine: "duckduckgo_web",
      });
    }
    match = pattern.exec(html);
  }
  return results;
}

async function fetchHackerNews(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=3`;
  const response = await fetchWithTimeout(url, signal, "application/json");
  const parsed = HnResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`hackernews: ${parsed.error.message.slice(0, 80)}`);
  return (parsed.data.hits ?? [])
    .filter((hit) => Boolean(hit.title))
    .map((hit) => {
      const item: SearchResult = {
        title: sanitizeText(hit.title ?? ""),
        url: hit.url && isFetchableUrl(hit.url) ? hit.url : `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
        snippet: compact(hit.story_text ?? `Hilo de HN: ${hit.title ?? ""}`, "Hacker News"),
        engine: "hackernews",
      };
      if (hit.created_at) item.publishedDate = hit.created_at;
      return item;
    });
}

/** Palabras que delatan una pregunta técnica: evita gastar cuota de Stack Exchange. */
const TECH_TERMS = [
  "error", "exception", "traceback", "stacktrace", "typescript", "javascript", "node", "docker", "npm", "pnpm",
  "react", "python", "rust", "golang", "fastify", "postgres", "nginx", "api", "bug", "how to", "compile", "denied",
];

async function fetchStackExchange(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const lowered = query.toLowerCase();
  if (!TECH_TERMS.some((term) => lowered.includes(term))) return [];
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=3`;
  const response = await fetchWithTimeout(url, signal, "application/json");
  const parsed = StackExchangeResponseSchema.safeParse(await readJsonCapped(response));
  if (!parsed.success) throw new Error(`stackexchange: ${parsed.error.message.slice(0, 80)}`);
  return (parsed.data.items ?? [])
    .filter((item) => Boolean(item.link))
    .map((item) => ({
      title: htmlToText(item.title ?? ""),
      url: item.link as string,
      snippet: compact(
        `Stack Overflow (puntuación ${item.score ?? 0}${item.is_answered ? ", resuelta" : ""}): ${htmlToText(item.title ?? "")}`,
        "Stack Overflow",
      ),
      engine: "stackexchange",
    }));
}

/** URL canónica para deduplicar. */
function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * Variantes de consulta para el reintento.
 *
 * Una consulta larga («... creator announcement date Linux Foundation donation»)
 * no casa en ningún índice: Wikipedia y DuckDuckGo esperan una entidad y
 * Hacker News exige TODOS los términos. Se reintenta recortando por los
 * términos iniciales, que son los que nombran la entidad.
 */
export function queryVariants(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((term) => term.replace(/^[."'¿¡]+|[."'¿¡]+$/g, ""))
    .filter((term) => term.length >= 3);
  if (terms.length <= 3) return [query];
  return [query, terms.slice(0, 4).join(" "), terms.slice(0, 2).join(" ")];
}

/**
 * Consulta federada. Cada fuente es independiente: un fallo se aísla y se
 * declara. Los resultados se deduplican, se ordenan por cobertura de términos
 * y se limitan. Si ninguna variante devuelve resultados, se devuelve la
 * verdad: cero resultados y el motivo.
 */
export async function federatedSearch(query: string, options: FederatedOptions = {}): Promise<FederatedOutcome> {
  const limit = options.limit ?? 8;
  const lang = options.lang ?? "es";
  const signal = options.signal;
  const wanted = options.sources && options.sources.length > 0 ? new Set(options.sources) : null;

  const variants = queryVariants(query);
  const variantsTried: string[] = [];
  let last: FederatedOutcome | null = null;

  for (const variant of variants) {
    variantsTried.push(variant);
    const outcome = await federatedOnce(variant, limit, lang, signal, wanted);
    last = outcome;
    if (outcome.results.length > 0) {
      return { ...outcome, variantsTried, variantUsed: variant };
    }
  }
  return { ...(last as FederatedOutcome), variantsTried };
}

async function federatedOnce(
  query: string,
  limit: number,
  lang: string,
  signal: AbortSignal | undefined,
  wanted: Set<string> | null,
): Promise<FederatedOutcome> {

  const sources: Array<{ name: string; run: () => Promise<SearchResult[]> }> = [
    { name: "wikipedia", run: () => fetchWikipedia(query, lang, signal) },
    { name: "duckduckgo", run: () => fetchDuckDuckGo(query, signal) },
    { name: "duckduckgo_web", run: () => fetchDuckDuckGoWeb(query, lang, signal) },
    { name: "google_news", run: () => fetchGoogleNews(query, lang, signal) },
    { name: "hackernews", run: () => fetchHackerNews(query, signal) },
    { name: "stackexchange", run: () => fetchStackExchange(query, signal) },
  ];

  const settled = await Promise.allSettled(
    sources.filter((source) => !wanted || wanted.has(source.name)).map((source) => source.run()),
  );

  const unresponsiveEngines: string[] = [];
  const collected: SearchResult[] = [];
  settled.forEach((outcome, index) => {
    const name = sources[index]?.name ?? "desconocido";
    if (outcome.status === "fulfilled") {
      collected.push(...outcome.value);
    } else {
      unresponsiveEngines.push(`${name}: ${(outcome.reason as Error)?.message ?? "error desconocido"}`);
    }
  });

  // Deduplicación por URL canónica, conservando el primer resultado.
  const seen = new Set<string>();
  const deduplicated = collected.filter((item) => {
    const key = canonicalUrl(item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Orden por cobertura de términos de la consulta (determinista).
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((term) => term.replace(/^[."'¿¡]+|[."'¿¡]+$/g, ""))
    .filter((term) => term.length >= 3);
  const scored = deduplicated
    .map((item) => {
      const haystack = `${item.title} ${item.snippet}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const results = scored.slice(0, limit).map((entry) => entry.item);
  const discarded = deduplicated.length - results.length;
  const degraded = unresponsiveEngines.length > 0 || results.length === 0;

  const hint =
    results.length === 0
      ? "No se han encontrado resultados indexados para esta consulta. No repitas la misma búsqueda: reformula con otros términos o cambia de enfoque."
      : undefined;

  return { results, unresponsiveEngines, degraded, discarded, totalAvailable: deduplicated.length, hint, variantsTried: [] };
}
