import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TtsEngine, TtsResult } from "./tts.js";

/**
 * Motor de síntesis con Kokoro (ONNX, 82 M parámetros) servido en local.
 *
 * Por qué existe: la voz del sistema (`say`) en macOS no tiene una voz
 * masculina realista, y la voz clonada (Qwen3-TTS) tarda 82 s por frase en
 * una CPU de 4 hilos. Kokoro es el punto intermedio: voz masculina real en
 * español (`em_alex`) a ~1 s por frase, con el modelo cargado en memoria por
 * un proceso aparte (`scripts/kokoro-voice-server.py`).
 *
 * Si el servidor de Kokoro no está en marcha, `available()` lo dice y el
 * llamador puede caer en `say`.
 */
export interface KokoroTtsOptions {
  /** URL base del servidor (http://127.0.0.1:8788). */
  baseUrl: string;
  /** Voz: em_alex (hombre, es), em_santa (hombre, es), ef_dora (mujer, es). */
  voice?: string;
  /** Idioma del texto. */
  language?: string;
  /** Velocidad de la locución. */
  speed?: number;
  /** Timeout de la petición (ms). */
  timeoutMs?: number;
}

export class KokoroTts implements TtsEngine {
  readonly name = "kokoro-onnx";
  private readonly options: KokoroTtsOptions;

  constructor(options: KokoroTtsOptions) {
    this.options = options;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await this.get("/salud", 2500);
      if (response.status !== 200) {
        return { ok: false, reason: `el servidor de voz respondió ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `el servidor de voz no está en marcha (${this.options.baseUrl}): ${(error as Error).message}`,
      };
    }
  }

  describe(): { voice: string | null; realistic: boolean; hint: string } {
    const voice = this.options.voice ?? "em_alex";
    return {
      voice: `Kokoro ${voice}`,
      realistic: true,
      hint: "",
    };
  }

  async synthesize(text: string): Promise<TtsResult> {
    const clean = text.trim();
    if (!clean) throw new Error("texto vacío para sintetizar");
    const body = JSON.stringify({
      texto: clean,
      voz: this.options.voice ?? "em_alex",
      idioma: this.options.language ?? "es",
      velocidad: this.options.speed ?? 1,
    });
    const response = await this.post("/sintetizar", body, this.options.timeoutMs ?? 30_000);
    return {
      audio: response.body,
      mimeType: "audio/wav",
      sampleRate: 24_000,
      durationMs: Number(response.headers["x-voice-duration-ms"] ?? 0),
    };
  }

  private get(path: string, timeoutMs: number): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
    return this.send("GET", path, undefined, timeoutMs);
  }

  private post(path: string, body: string, timeoutMs: number): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
    return this.send("POST", path, body, timeoutMs);
  }

  private send(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> {
    const url = new URL(path, this.options.baseUrl);
    const enviar = url.protocol === "https:" ? httpsRequest : request;
    return new Promise((resolve, reject) => {
      const peticion = enviar(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method,
          headers: body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : undefined,
          timeout: timeoutMs,
        },
        (respuesta) => {
          const trozos: Buffer[] = [];
          respuesta.on("data", (trozo: Buffer) => trozos.push(trozo));
          respuesta.on("end", () =>
            resolve({
              status: respuesta.statusCode ?? 0,
              body: Buffer.concat(trozos),
              headers: respuesta.headers,
            }),
          );
        },
      );
      peticion.on("timeout", () => {
        peticion.destroy();
        reject(new Error(`la síntesis tardó más de ${timeoutMs} ms`));
      });
      peticion.on("error", reject);
      if (body) peticion.write(body);
      peticion.end();
    });
  }
}
