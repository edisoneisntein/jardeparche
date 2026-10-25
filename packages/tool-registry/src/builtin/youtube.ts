import { z } from "zod";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";
import type { ToolServices } from "../types.js";

/**
 * YouTube: buscar vídeos y leer lo que se dice en ellos.
 *
 * La búsqueda web normal **no** sirve para esto: la página de un vídeo de
 * YouTube se construye con JavaScript, así que al leerla como texto solo
 * aparece la cáscara (`<!DOCTYPE HTML>`). Sin embargo, las **transcripciones
 * automáticas** sí existen y son texto plano: son la fuente real de lo que se
 * dice en el vídeo.
 *
 * Se usa `yt-dlp` (ya instalado en el Mac) porque no necesita claves de API
 * ni cuota, y porque devuelve metadatos y subtítulos de forma estable.
 *
 * Dos cuidados de seguridad:
 *  · La URL se valida: solo YouTube (`youtube.com`, `youtu.be`). `yt-dlp`
 *    también sabe descargar de cualquier sitio y de ficheros locales, así que
 *    no se le pasa una URL sin comprobar.
 *  · El binario se resuelve a una ruta ABSOLUTA: el entorno del hijo no
 *    hereda el `PATH` del usuario (por diseño, para no filtrar secretos), así
 *    que hay que saber dónde está.
 */

/** Un vídeo de YouTube, ya normalizado. */
export interface YoutubeVideo {
  id: string;
  title: string;
  url: string;
  channel: string;
  durationSeconds?: number;
  description: string;
}

/** Candidatas donde puede estar el binario, en orden de preferencia. */
const YTDLP_CANDIDATES = [
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "/Users/Shared/yt-dlp",
  "yt-dlp",
];

/** Localiza `yt-dlp` sin depender del `PATH` del proceso hijo. */
export function resolveYtDlpBinary(): string | undefined {
  const fromPath = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((dir) => join(dir, "yt-dlp"));
  const candidates = [...fromPath, ...YTDLP_CANDIDATES];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Hosts de YouTube admitidos. */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/**
 * Valida que el destino sea realmente YouTube y devuelve la URL normalizada.
 *
 * `yt-dlp` acepta cualquier URL (incluso `file://`): sin esta comprobación,
 * la tool se convertiría en un modo de leer ficheros locales o de atacar
 * servicios internos.
 */
export function assertYoutubeUrl(candidate: string): string {
  const raw = candidate.trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("URL de YouTube no válida");
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`solo se admiten URLs de YouTube (recibido: ${url.hostname})`);
  }
  return url.toString();
}

/**
 * Normaliza la salida JSON de `yt-dlp --dump-json` (una línea JSON por
 * vídeo) a la forma que consume el agente.
 */
export function parseYoutubeSearchOutput(stdout: string): YoutubeVideo[] {
  const videos: YoutubeVideo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const url = typeof raw.webpage_url === "string" ? raw.webpage_url : typeof raw.url === "string" ? raw.url : "";
    const id = typeof raw.id === "string" ? raw.id : extractVideoId(url);
    if (!url || !id) continue;
    const duration = typeof raw.duration === "number" ? raw.duration : undefined;
    videos.push({
      id,
      title: typeof raw.title === "string" ? raw.title : "(sin título)",
      url,
      channel: typeof raw.uploader === "string" ? raw.uploader : typeof raw.channel === "string" ? raw.channel : "(desconocido)",
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      description: typeof raw.description === "string" ? raw.description.slice(0, 600) : "",
    });
  }
  return videos;
}

/** Saca el identificador del vídeo de una URL de YouTube. */
export function extractVideoId(url: string): string {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    const fromPath = parsed.pathname.match(/\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/)?.[1];
    if (fromPath) return fromPath;
    const fromQuery = parsed.searchParams.get("v");
    if (fromQuery) return fromQuery;
    // Formato corto: youtu.be/<id>
    return parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})/)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Decodifica las entidades HTML que aparecen en las subtítulos. */
function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (match, name: string) => {
    switch (name) {
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
      case "#39":
        return "'";
      default:
        return match;
    }
  });
}

/**
 * Limpia un VTT de subtítulos automáticas de YouTube.
 *
 * Las subtítulos automáticas son "crolling": cada bloque repite la cola del
 * bloque anterior y marca las palabras con etiquetas de karaoke
 * (`<00:00:01.120><c> de</c>`). Sin limpiarlas, el texto sale con cada
 * palabras repetida tres veces y con marcas de tiempo en medio.
 */
export function cleanVttTranscript(vtt: string): string {
  const cues: string[] = [];
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.startsWith("NOTE")) continue;
    if (line.includes("-->")) continue;
    if (/^\d+$/.test(line)) continue;
    const cleaned = decodeEntities(line.replace(/<[^>]*>/g, ""));
    if (cleaned.trim() !== "") cues.push(cleaned.trim());
  }
  return mergeRollingCues(cues);
}

/**
 * Une bloques solapados eliminando la parte repetida.
 *
 * Cada bloque de las subtítulos automáticas empieza por el final del
 * bloque anterior: se busca el solapamiento más largo entre la cola ya
 * acumulada y la cabeza del bloque nuevo, y se conserva sólo lo nuevo.
 */
export function mergeRollingCues(cues: readonly string[]): string {
  let accumulated: string[] = [];
  for (const cue of cues) {
    const words = cue.split(/\s+/).filter(Boolean);
    if (accumulated.length === 0) {
      accumulated = words;
      continue;
    }
    const max = Math.min(accumulated.length, words.length);
    let overlap = 0;
    for (let size = max; size >= 1; size -= 1) {
      const tail = accumulated.slice(accumulated.length - size);
      const head = words.slice(0, size);
      if (tail.every((word, index) => word === head[index])) {
        overlap = size;
        break;
      }
    }
    accumulated = accumulated.concat(words.slice(overlap));
  }
  return accumulated.join(" ").replace(/\s+/g, " ").trim();
}

const SearchSchema = z.object({
  query: z.string().min(2).max(200),
  count: z.number().int().min(1).max(10).default(5),
});

const TranscriptSchema = z.object({
  url: z.string().min(8).max(500),
  lang: z.string().min(2).max(10).default("es"),
  max_chars: z.number().int().min(500).max(20_000).default(6000),
});

/** Normaliza una consulta para que no rompa la invocación del binario. */
function safeQuery(query: string): string {
  return query.replace(/[\r\n\t\0]/g, " ").replace(/\s+/g, " ").trim();
}

/** Herramienta `youtube.search`: busca vídeos en YouTube. */
export function createYoutubeSearchTool(_services: ToolServices): ToolDefinition<z.infer<typeof SearchSchema>> {
  const binary = resolveYtDlpBinary();
  return {
    name: "youtube.search",
    title: "Buscar en YouTube",
    description:
      "Busca vídeos en YouTube y devuelve título, canal, duración y descripción. Úsala cuando te pidan ver o aprender algo que mejor se explica en vídeo (tutoriales, charlas, demos).",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 30_000,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Qué buscar en YouTube (en el idioma que prefieras)." },
        count: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Cuántos vídeos devolver." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parse: (raw) => SearchSchema.parse(raw),
    availability: () =>
      binary
        ? { available: true }
        : { available: false, reason: "yt-dlp no está instalado (brew install yt-dlp)" },
    execute: async (input) => {
      if (!binary) {
        return { ok: false, summary: "yt-dlp no está instalado en este equipo.", unavailable: true, error: "yt_dlp_missing" };
      }
      const target = `ytsearch${input.count}:${safeQuery(input.query)}`;
      const outcome = await runSanitizedProcess(binary, ["--flat-playlist", "--dump-json", "--no-warnings", target], {
        timeoutMs: 25_000,
        maxOutputBytes: 256 * 1024,
      });
      if (!outcome.stdout.trim()) {
        return {
          ok: false,
          summary: outcome.timedOut
            ? "YouTube tardó demasiado en responder."
            : `No se pudo buscar en YouTube: ${outcome.stderr.trim().slice(0, 200)}`,
          unavailable: false,
          error: outcome.timedOut ? "youtube_timeout" : "youtube_search_failed",
        };
      }
      const videos = parseYoutubeSearchOutput(outcome.stdout).slice(0, input.count);
      return {
        ok: true,
        summary: videos.length
          ? `${videos.length} vídeo(s) en YouTube para «${input.query}»: ${videos.map((video) => video.title).join("; ")}`
          : `Sin resultados en YouTube para «${input.query}».`,
        unavailable: false,
        data: { query: input.query, count: videos.length, results: videos },
      };
    },
  };
}

/** Herramienta `youtube.transcript`: lee lo que se dice en un vídeo. */
export function createYoutubeTranscriptTool(_services: ToolServices): ToolDefinition<z.infer<typeof TranscriptSchema>> {
  const binary = resolveYtDlpBinary();
  return {
    name: "youtube.transcript",
    title: "Leer transcripción de un vídeo",
    description:
      "Lee lo que se dice en un vídeo de YouTube usando su transcripción automática. Úsala DESPUÉS de youtube.search para responder con el contenido real del vídeo en lugar de solo el título.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 60_000,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL del vídeo de YouTube." },
        lang: { type: "string", default: "es", description: "Idioma de la transcripción (por defecto español)." },
        max_chars: { type: "integer", minimum: 500, maximum: 20000, default: 6000, description: "Máximo de caracteres a devolver." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    parse: (raw) => TranscriptSchema.parse(raw),
    availability: () =>
      binary
        ? { available: true }
        : { available: false, reason: "yt-dlp no está instalado (brew install yt-dlp)" },
    execute: async (input) => {
      if (!binary) {
        return { ok: false, summary: "yt-dlp no está instalado en este equipo.", unavailable: true, error: "yt_dlp_missing" };
      }
      let url: string;
      try {
        url = assertYoutubeUrl(input.url);
      } catch (error) {
        return {
          ok: false,
          summary: (error as Error).message,
          unavailable: false,
          error: "not_youtube_url",
        };
      }

      const workdir = mkdtempSync(join(tmpdir(), "jarvis-yt-"));
      try {
        const outcome = await runSanitizedProcess(
          binary,
          [
            "--skip-download",
            "--write-auto-sub",
            "--write-sub",
            "--sub-lang",
            `${input.lang},en`,
            "--sub-format",
            "vtt",
            "--no-warnings",
            "-o",
            join(workdir, "yt.%(id)s"),
            "--",
            url,
          ],
          { timeoutMs: 50_000, maxOutputBytes: 64 * 1024 },
        );
        const files = readdirSync(workdir).filter((name) => name.endsWith(".vtt"));
        const first = files[0];
        if (!first) {
          return {
            ok: false,
            summary:
              "Ese vídeo no tiene transcripción disponible (puede estar desactivada, ser muy reciente o no tener voz).",
            unavailable: false,
            error: "youtube_no_transcript",
          };
        }
        const transcript = cleanVttTranscript(readFileSync(join(workdir, first), "utf8"));
        const truncated = transcript.slice(0, input.max_chars);
        return {
          ok: true,
          summary: `Transcripción leída (${truncated.length} caracteres${transcript.length > input.max_chars ? ", recortada" : ""}).`,
          unavailable: false,
          data: {
            url,
            chars: truncated.length,
            totalChars: transcript.length,
            truncated: transcript.length > input.max_chars,
            transcript: truncated,
          },
        };
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    },
  };
}
