import { z } from "zod";
import { lookup } from "node:dns/promises";
import http, { type RequestOptions } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { ToolContext, ToolDefinition } from "@jarvis/shared";
import type { ToolServices } from "../types.js";

/**
 * Lectura del contenido de una URL.
 *
 * `web.search` devuelve titulares y extractos; para responder con precisión
 * (autores, fechas, cifras) el agente necesita el texto de la página. Esta tool
 * lo aporta, con las protecciones propias de una petición saliente:
 *
 *  · Solo `http`/`https`.
 *  · Guarda SSRF: se resuelve el host y se rechaza cualquier dirección
 *    privada, de loopback, link-local, multicast o reservada. La comprobación
 *    cubre IPv4 e IPv6, incluidas las formas que traducen o embeben un IPv4
 *    (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32` y las
 *    variantes IPv4 mapeadas o compatibles) y los rangos ULA/link-local.
 *  · **Sin ventana TOCTOU**: la dirección validada se FIJA en la conexión
 *    (el `lookup` propio devuelve la IP ya comprobada), de modo que un DNS
 *    que responde con una IP pública en la validación y con una interna en
 *    la conexión ya no puede colarse.
 *  · Solo contenido textual; los binarios se rechazan.
 *  · Tope de bytes leídos (comprimidos y descomprimidos) y de caracteres.
 *  · Timeout de petición propio y propagación del `AbortSignal` del turno.
 */

const FetchSchema = z.object({
  url: z.string().min(8).max(2000),
  max_chars: z.number().int().min(500).max(12_000).default(6000),
});

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT = [/^text\/html/i, /^text\/plain/i, /^application\/xhtml/i, /^text\/markdown/i];

/** Direcciones resueltas y validadas de un host. */
export interface ResolvedTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

/** Cliente HTTP inyectable: permite fijar la IP y sustituir el transporte en pruebas. */
export interface WebFetchHttpClient {
  get(
    url: URL,
    options: {
      addresses: Array<{ address: string; family: 4 | 6 }>;
      signal: AbortSignal;
      maxBytes: number;
      timeoutMs: number;
    },
  ): Promise<{ status: number; location?: string; contentType: string; body: Buffer; truncated: boolean }>;
}

const USER_AGENT = "Mozilla/5.0 (compatible; JARVIS-Agent/1.0)";
const ACCEPT = "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5";

/* -------------------------------------------------------------------------- */
/* Clasificación de direcciones                                              */
/* -------------------------------------------------------------------------- */

/** Parsea un IPv4 en sus cuatro octetos; `undefined` si no es válido. */
function parseIPv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** Parsea un IPv6 (con `::`, IPv4 embebido y corchetes) a ocho grupos de 16 bits. */
function parseIPv6(address: string): number[] | undefined {
  let text = address.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (!text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const v4 = parseIPv4(piece);
        if (!v4) return undefined;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const left = toGroups(halves[0] ?? "");
  if (!left) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = toGroups(halves[1] ?? "");
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** ¿El IPv4 es de un rango no público? */
function isPrivateIPv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

/** ¿El IPv6 (ya parseado) es de un rango no público o traduce un IPv4 privado? */
function isPrivateIPv6(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  const embedded = (high: number, low: number): boolean =>
    isPrivateIPv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);

  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) === 1) return true;
  // IPv4 mapeada (::ffff:a.b.c.d) y compatible (::a.b.c.d).
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] ?? 0) === 0xffff) {
    return embedded(groups[6] ?? 0, groups[7] ?? 0);
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return embedded(groups[6] ?? 0, groups[7] ?? 0);
  }
  // NAT64: el prefijo well-known `64:ff9b::/96` embebe el IPv4 en los dos
  // últimos grupos; cualquier otra variante del prefijo es de uso local.
  if (first === 0x0064 && second === 0xff9b) {
    const isWellKnown = groups.slice(2, 6).every((group) => group === 0);
    return isWellKnown ? embedded(groups[6] ?? 0, groups[7] ?? 0) : true;
  }
  // 6to4 (2002::/16): embeben el IPv4 en los grupos 1 y 2.
  if (first === 0x2002) return embedded(groups[1] ?? 0, groups[2] ?? 0);
  // Teredo (2001::/32): el IPv4 del cliente va ofuscado (XOR 0xFFFF) al final.
  if (first === 0x2001 && second === 0x0000) {
    return embedded((groups[6] ?? 0) ^ 0xffff, (groups[7] ?? 0) ^ 0xffff);
  }
  // Link-local (fe80::/10) y site-local (fec0::/10).
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  // ULA (fc00::/7).
  if ((first & 0xfe00) === 0xfc00) return true;
  // Multicast (ff00::/8).
  if ((first & 0xff00) === 0xff00) return true;
  // Documentación (2001:db8::/32) y discard-only (100::/64).
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x0100 && (groups[1] ?? 0) === 0 && (groups[2] ?? 0) === 0 && (groups[3] ?? 0) === 0) return true;
  return false;
}

/** ¿La dirección es de ámbito no público? Una dirección no clasificable se rechaza. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(address);
  if (!v6) return true;
  return isPrivateIPv6(v6);
}

/* -------------------------------------------------------------------------- */
/* Resolución y validación del destino                                      */
/* -------------------------------------------------------------------------- */

/** Resuelve el host y comprueba que TODAS sus direcciones son públicas. */
export async function resolvePublicTarget(candidate: string): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`esquema no permitido: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: (isIP(host) === 4 ? 4 : 6) as 4 | 6 }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error(`no se pudo resolver el host: ${host}`);
      });
  if (addresses.length === 0) throw new Error(`el host no resuelve: ${host}`);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`destino en rango no público (${entry.address}); bloqueado por protección SSRF`);
    }
  }
  return {
    url,
    addresses: addresses.map((entry) => ({
      address: entry.address,
      family: (entry.family === 6 ? 6 : 4) as 4 | 6,
    })),
  };
}

/** Valida el destino antes de salir a la red. */
export async function assertPublicUrl(candidate: string): Promise<URL> {
  return (await resolvePublicTarget(candidate)).url;
}

/* -------------------------------------------------------------------------- */
/* Extracción de texto                                                       */
/* -------------------------------------------------------------------------- */

const NOISE_ELEMENTS = new Set(["script", "style", "noscript", "nav", "footer", "header"]);
const REGION_PRIORITY: Record<string, number> = { article: 3, main: 2, body: 1 };
const MAX_SCAN_CHARS = 512 * 1024;
const ENTITY_PATTERN = /&(nbsp|amp|lt|gt|quot|apos|#39|#\d+|#x[0-9a-f]+);/gi;

/** Decodifica las entidades HTML más comunes en una sola pasada. */
function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (match, entity: string) => {
    const lower = entity.toLowerCase();
    switch (lower) {
      case "nbsp":
        return " ";
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "#39":
        return "'";
      default:
        break;
    }
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Texto legible de un HTML.
 *
 * Se recorre el documento **una sola vez**: se descartan los elementos de
 * ruido (`script`, `style`, `noscript`, `nav`, `footer`, `header`) y se
 * registra el contenido de `article`, `main` o `body` según prioridad. Antes
 * se ejecutaban doce expresiones regulares sobre el documento completo; con
 * dos megabytes de HTML eso bloqueaba el event loop durante decenas de
 * milisegundos en cada lectura.
 */
export function extractReadableText(html: string): string {
  const source = html.length > MAX_SCAN_CHARS ? html.slice(0, MAX_SCAN_CHARS) : html;
  const tagPattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  const regionStarts = new Map<string, number>();
  const regionEnds = new Map<string, number>();
  let preferred: string | undefined;
  let text = "";
  let cursor = 0;
  let skipTag: string | undefined;
  let skipDepth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(source)) !== null) {
    const tag = match[1]?.toLowerCase();
    if (!tag) {
      if (!skipTag) text += source.slice(cursor, match.index);
      cursor = tagPattern.lastIndex;
      continue;
    }
    const isClosing = match[0].startsWith("</");
    if (skipTag) {
      if (tag === skipTag) {
        skipDepth += isClosing ? -1 : 1;
        if (skipDepth <= 0) skipTag = undefined;
      }
      cursor = tagPattern.lastIndex;
      continue;
    }
    text += source.slice(cursor, match.index);
    cursor = tagPattern.lastIndex;
    text += " ";
    if (REGION_PRIORITY[tag] !== undefined) {
      if (isClosing) {
        regionEnds.set(tag, text.length);
      } else if (!preferred || (REGION_PRIORITY[tag] ?? 0) > (REGION_PRIORITY[preferred] ?? 0)) {
        preferred = tag;
        regionStarts.set(tag, text.length);
      }
    }
    if (!isClosing && NOISE_ELEMENTS.has(tag) && !match[0].endsWith("/>")) {
      skipTag = tag;
      skipDepth = 1;
    }
  }
  if (!skipTag) text += source.slice(cursor);

  let chosen = text;
  if (preferred) {
    const start = regionStarts.get(preferred);
    const end = regionEnds.get(preferred);
    if (start !== undefined && end !== undefined && end > start) chosen = text.slice(start, end);
  }
  return decodeEntities(chosen).replace(/\s+/g, " ").trim();
}

/** Título de la página, si lo hay. */
export function extractTitle(html: string): string | undefined {
  const title = html.slice(0, MAX_SCAN_CHARS).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!title) return undefined;
  const clean = decodeEntities(title.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean.slice(0, 200) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Transporte HTTP                                                            */
/* -------------------------------------------------------------------------- */

/** Cliente HTTP sobre `node:http`/`node:https` que fija la IP validada. */
export function createPinnedHttpClient(): WebFetchHttpClient {
  return {
    get(url, options) {
      const transport = url.protocol === "https:" ? https : http;
      const address = options.addresses[0];
      if (!address) return Promise.reject(new Error("sin dirección validada para el host"));
      return new Promise((resolve, reject) => {
        const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
          method: "GET",
          headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
          signal: options.signal,
          autoSelectFamily: false,
          // El DNS se resuelve UNA vez, en `resolvePublicTarget`; aquí se
          // entrega esa misma IP, de modo que no existe ventana de
          // rebinding entre la comprobación y la conexión.
          lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: never[]) => void) => {
            if (lookupOptions?.all) {
              (callback as unknown as (err: Error | null, addresses: Array<{ address: string; family: number }>) => void)(
                null,
                [{ address: address.address, family: address.family }],
              );
              return;
            }
            (callback as unknown as (err: Error | null, ip: string, family: number) => void)(
              null,
              address.address,
              address.family,
            );
          }) as unknown as RequestOptions["lookup"],
        };
        const request = transport.request(url, requestOptions, (response) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let truncated = false;
            response.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > options.maxBytes) {
                truncated = true;
                chunks.push(chunk.subarray(0, Math.max(0, options.maxBytes - (total - chunk.length))));
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              const raw = Buffer.concat(chunks).subarray(0, options.maxBytes);
              resolve({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                contentType: response.headers["content-type"] ?? "",
                body: decompress(raw, response.headers["content-encoding"], options.maxBytes),
                truncated,
              });
            });
            response.on("error", reject);
          });
        request.on("error", reject);
        request.end();
      });
    },
  };
}

/** Descomprime el cuerpo respetando el tope de bytes (evita las bombas de compresión). */
function decompress(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const kind = (encoding ?? "").toLowerCase().trim();
  if (!kind || kind === "identity") return body;
  try {
    if (kind === "gzip" || kind === "x-gzip") return gunzipSync(body, { maxOutputLength: maxBytes });
    if (kind === "deflate") return inflateSync(body, { maxOutputLength: maxBytes });
    if (kind === "br") return brotliDecompressSync(body, { maxOutputLength: maxBytes });
  } catch {
    return body;
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                       */
/* -------------------------------------------------------------------------- */

export function createWebFetchTool(
  _services: ToolServices,
  httpClient: WebFetchHttpClient = createPinnedHttpClient(),
): ToolDefinition<z.infer<typeof FetchSchema>> {
  return {
    name: "web.fetch",
    title: "Lectura de página web",
    description:
      "Descarga el contenido textual de una URL pública y devuelve el texto legible de la página. Úsala DESPUÉS de web.search cuando el resultado encontrado contenga la respuesta (autores, fechas, cifras) y el extracto no baste. Solo admite http/https y rechaza destinos internos.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 12_000,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL pública a leer (http o https)." },
        max_chars: { type: "integer", minimum: 500, maximum: 12000, default: 6000, description: "Máximo de caracteres a devolver." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    parse: (raw) => FetchSchema.parse(raw),
    availability: () => ({ available: true }),
    execute: async (input, ctx: ToolContext) => {
      let current = input.url;
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const target = await resolvePublicTarget(current);
          const signal = AbortSignal.any([
            ctx.signal ?? new AbortController().signal,
            AbortSignal.timeout(TIMEOUT_MS),
          ]);
          const response = await httpClient.get(target.url, {
            addresses: target.addresses,
            signal,
            maxBytes: MAX_BYTES,
            timeoutMs: TIMEOUT_MS,
          });
          if (response.status >= 300 && response.status < 400) {
            if (!response.location) throw new Error(`redirección sin destino (HTTP ${response.status})`);
            current = new URL(response.location, target.url).toString();
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`la página respondió HTTP ${response.status}`);
          }
          if (response.contentType && !ALLOWED_CONTENT.some((pattern) => pattern.test(response.contentType))) {
            throw new Error(`tipo de contenido no textual: ${response.contentType}`);
          }
          const html = response.body.toString("utf8");
          const title = extractTitle(html);
          const text = extractReadableText(html).slice(0, input.max_chars);
          return {
            ok: true,
            summary: `Leídos ${text.length} caracteres de ${target.url.hostname}${title ? ` («${title}»)` : ""}.`,
            unavailable: false,
            data: {
              url: target.url.toString(),
              title,
              chars: text.length,
              truncated: text.length >= input.max_chars || response.truncated,
              text,
            },
          };
        }
        throw new Error("demasiadas redirecciones");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = /abort/i.test(message) || (error as { name?: string })?.name === "AbortError";
        const timedOut = /timeout/i.test(message);
        return {
          ok: false,
          summary: aborted
            ? `Lectura cancelada: ${message}`
            : timedOut
              ? `La página no respondió en ${TIMEOUT_MS} ms: ${message}`
              : `No se pudo leer la página: ${message}`,
          unavailable: false,
          error: aborted ? "fetch_aborted" : timedOut ? "fetch_timeout" : "fetch_failed",
        };
      }
    },
  };
}
