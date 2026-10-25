import { z } from "zod";
import { accessSync, constants } from "node:fs";
import type { ToolDefinition } from "@jarvis/shared";
import { runSanitizedProcess } from "../process-policy.js";
import { parseYoutubeSearchOutput, resolveYtDlpBinary } from "./youtube.js";
import type { ToolServices } from "../types.js";

/**
 * Música y vídeo en el Mac.
 *
 * Es la pieza que le faltaba a este Jarvis para parecerse al de las películas:
 * poner música de fondo o abrir un vídeo con una sola frase.
 *
 * Se apoya en las herramientas del propio macOS:
 *  · `open` abre una URL en la aplicación que corresponda (YouTube en el
 *    navegador, Spotify en su app, un audio local en QuickTime).
 *  · `osascript` controla el reproductor de música del sistema (Music.app)
 *    para pausar, reanudar y parar.
 *
 * Dos cuidados:
 *  · `open` SOLO acepta URLs http/https. Si aceptara `file://` o nombres de
 *    aplicación, la tool sería un lanzador de programas arbitrario.
 *  · Los guiones de AppleScript se pasan como argumento (nunca por una
 *    shell), así que no hay interpretación de metacaracteres.
 *
 * "Ponme algo de X" se resuelve buscando en YouTube con `yt-dlp` y abriendo
 * el primer resultado: así funciona aunque el usuario no diga "en YouTube".
 */

/** Ruta absoluta de `open` (viene con macOS). */
const OPEN_BINARY = "/usr/bin/open";
/** Ruta absoluta de `osascript` (viene con macOS). */
const OSASCRIPT_BINARY = "/usr/bin/osascript";

/** ¿Existe el binario y es ejecutable? */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const MusicSchema = z.object({
  action: z.enum(["play", "pause", "resume", "stop"]).default("play"),
  /** Canción, tema o vídeo que se quiere poner. */
  query: z.string().min(1).max(200).optional(),
  /** URL directa (YouTube, Spotify, audio web). */
  url: z.string().min(8).max(1000).optional(),
});

export type MusicInput = z.infer<typeof MusicSchema>;

/**
 * Valida una URL de medios.
 *
 * Solo `http`/`https`: un `file://` permitiría abrir cualquier fichero del
 * disco y un esquema propio (`smb://`, `ssh://`) convertiría la tool en una
 * vía para tocar la red interna.
 */
export function assertMediaUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    throw new Error("URL no válida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`esquema no permitido: ${url.protocol}`);
  }
  return url.toString();
}

/** Guion de AppleScript para controlar el reproductor del sistema. */
export function musicScript(action: "pause" | "resume" | "stop"): string {
  const command = action === "pause" ? "pause" : action === "stop" ? "stop" : "play";
  return `tell application "Music" to ${command}`;
}

/** Normaliza una consulta de búsqueda. */
function safeQuery(query: string): string {
  return query.replace(/[\r\n\t\0]/g, " ").replace(/\s+/g, " ").trim();
}

/** Herramienta `music.play`: poner, pausar, reanudar o parar la música. */
export function createMusicTool(_services: ToolServices): ToolDefinition<MusicInput> {
  const ytDlp = resolveYtDlpBinary();
  const canOpen = isExecutable(OPEN_BINARY);
  const canScript = isExecutable(OSASCRIPT_BINARY);

  const unavailable = (): { available: boolean; reason?: string } => {
    if (!canOpen) {
      return { available: false, reason: "no se encuentra /usr/bin/open (¿esto es macOS?)" };
    }
    return { available: true };
  };

  return {
    name: "music.play",
    title: "Música y vídeo",
    description:
      "Pone música o un vídeo: «ponme algo de jazz», «abre este vídeo de YouTube», «pausa la música», «para la música». Con una búsqueda encuentra el mejor resultado en YouTube y lo reproduce; con una URL abre esa URL directamente.",
    risk: "local_reversible",
    requiresApproval: true,
    timeoutMs: 45_000,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["play", "pause", "resume", "stop"],
          default: "play",
          description: "Qué hacer: poner, pausar, reanudar o parar.",
        },
        query: { type: "string", description: "Canción, tema o vídeo que se quiere poner." },
        url: { type: "string", description: "URL directa del vídeo o audio (YouTube, Spotify...)." },
      },
      additionalProperties: false,
    },
    parse: (raw) => MusicSchema.parse(raw),
    availability: unavailable,
    execute: async (input) => {
      if (!canOpen) {
        return { ok: false, summary: "En este equipo no se puede abrir la música.", unavailable: true, error: "open_missing" };
      }

      if (input.action !== "play") {
        if (!canScript) {
          return {
            ok: false,
            summary: "No se puede controlar el reproductor del sistema en este equipo.",
            unavailable: false,
            error: "osascript_missing",
          };
        }
        const outcome = await runSanitizedProcess(OSASCRIPT_BINARY, ["-e", musicScript(input.action)], { timeoutMs: 10_000 });
        const done = outcome.code === 0;
        return {
          ok: done,
          summary: done
            ? input.action === "pause"
              ? "Música en pausa."
              : input.action === "resume"
                ? "Música reanudada."
                : "Música parada."
            : `No se pudo ${input.action === "pause" ? "pausar" : input.action === "resume" ? "reanudar" : "parar"} la música: ${outcome.stderr.trim().slice(0, 160)}`,
          unavailable: false,
          error: done ? undefined : "music_control_failed",
          data: { action: input.action },
        };
      }

      // play con URL directa
      if (input.url) {
        let url: string;
        try {
          url = assertMediaUrl(input.url);
        } catch (error) {
          return { ok: false, summary: (error as Error).message, unavailable: false, error: "media_url_rejected" };
        }
        const outcome = await runSanitizedProcess(OPEN_BINARY, [url], { timeoutMs: 15_000 });
        const done = outcome.code === 0;
        return {
          ok: done,
          summary: done ? `Abierto: ${url}` : `No se pudo abrir ${url}: ${outcome.stderr.trim().slice(0, 160)}`,
          unavailable: false,
          error: done ? undefined : "media_open_failed",
          data: { url },
        };
      }

      // play con búsqueda: se resuelve en YouTube
      if (!input.query) {
        return {
          ok: false,
          summary: "Dime qué quieres poner (una búsqueda o una URL).",
          unavailable: false,
          error: "missing_query",
        };
      }
      if (!ytDlp) {
        return {
          ok: false,
          summary: "Para buscar por nombre hace falta yt-dlp (brew install yt-dlp).",
          unavailable: true,
          error: "yt_dlp_missing",
        };
      }
      const target = `ytsearch1:${safeQuery(input.query)}`;
      const search = await runSanitizedProcess(ytDlp, ["--flat-playlist", "--dump-json", "--no-warnings", target], {
        timeoutMs: 25_000,
        maxOutputBytes: 128 * 1024,
      });
      const [video] = parseYoutubeSearchOutput(search.stdout);
      if (!video) {
        return {
          ok: false,
          summary: `No encontré nada para «${input.query}».`,
          unavailable: false,
          error: "nothing_found",
        };
      }
      const outcome = await runSanitizedProcess(OPEN_BINARY, [video.url], { timeoutMs: 15_000 });
      const done = outcome.code === 0;
      return {
        ok: done,
        summary: done
          ? `Pongo «${video.title}» (${video.channel}): ${video.url}`
          : `Encontré «${video.title}» pero no se pudo abrir: ${outcome.stderr.trim().slice(0, 160)}`,
        unavailable: false,
        error: done ? undefined : "media_open_failed",
        data: { query: input.query, title: video.title, channel: video.channel, url: video.url },
      };
    },
  };
}
