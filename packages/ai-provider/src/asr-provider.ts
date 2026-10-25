import { z } from "zod";

/**
 * Cliente de ASR (reconocimiento de voz) del lado del servidor.
 *
 * Recibe PCM crudo (16 bits, mono, 16 kHz) capturado por el navegador y lo
 * transcribe calling al modelo de ASR de NVIDIA NIM
 * (`POST /v1/audio/transcriptions`, multipart).
 *
 * El endpoint solo está enrutado si el modelo está HABILITADO en la cuenta:
 * por eso `available()` consulta el catálogo real y explica qué hacer si el
 * modelo no está.
 */

export interface AsrResult {
  text: string;
  confidence?: number;
}

export interface AsrProvider {
  readonly name: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** Transcribe PCM 16 bits mono a la frecuencia indicada. */
  transcribe(pcm: Buffer, sampleRate: number): Promise<AsrResult>;
}

export interface AsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  timeoutMs: number;
  /** Modelos alternativos que se consideran válidos. */
  aliases?: string[];
}

/**
 * Modelos "omni" (entienden imagen, vídeo, voz y texto). No usan el endpoint
 * de transcripción: reciben el audio como parte de contenido `audio_url` en una
 * llamada de chat normal. Vienen en la mayoría de las cuentas, así que son la
 * vía de ASR que funciona sin habilitar nada.
 */
export function isOmniAsrModel(model: string): boolean {
  return /omni|voicechat/i.test(model);
}

/**
 * Modo de API de cada familia de modelos de ASR de NVIDIA:
 *  · `file`     → endpoint OpenAI-compatible (`POST /v1/audio/transcriptions`),
 *                  que es el que usa este adaptador.
 *  · `stream`   → websocket de streaming (RNN-T): cada fragmento de audio se
 *                  manda en vivo y se reciben hipótesis parciales. Es mejor para
 *                  latencia, pero es otra integración.
 */
export const ASR_MODEL_MODES: Record<string, "file" | "stream"> = {
  "nvidia/parakeet-ctc-0.6b-es": "file",
  "nvidia/parakeet-ctc-0.6b-asr": "file",
  "nvidia/parakeet-ctc-1.1b-asr": "file",
  "nvidia/parakeet-tdt-0.6b": "file",
  "nvidia/parakeet-tdt-0.6b-v2": "file",
  "nvidia/parakeet-1.1b-rnnt-multilingual-asr": "stream",
  "nvidia/nemotron-asr-streaming": "stream",
  "nvidia/canary-1b-asr": "stream",
  "nvidia/conformer-ctc-asr": "file",
};

/** ¿Este modelo se puede usar con el adaptador de fichero? */
export function asrModeFor(model: string): "file" | "stream" {
  return ASR_MODEL_MODES[model] ?? "file";
}

export class NvidiaAsrProvider implements AsrProvider {
  readonly name = "nvidia-asr";
  private readonly config: AsrConfig;
  private catalog: { at: number; ids: string[] } | null = null;

  constructor(config: AsrConfig) {
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` };
  }

  /**
   * Ejecuta una llamada reintentando ante saturación (503) o límite de tasa
   * (429). Los modelos con más tráfico se saturan a menudo; sin reintento,
   * cada turno de voz caería al reconocedor del navegador.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const message = (error as Error).message ?? "";
        const retryable = /HTTP (429|503)/.test(message);
        if (!retryable || attempt === attempts - 1) throw error;
        const wait = 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const now = Date.now();
    if (!this.catalog || now - this.catalog.at > 5 * 60_000) {
      try {
        const response = await fetch(this.url("/models"), { headers: this.headers() });
        if (!response.ok) return { ok: false, reason: `no se pudo consultar el catálogo (HTTP ${response.status})` };
        const payload = (await response.json()) as { data?: Array<{ id?: string }> };
        this.catalog = { at: now, ids: (payload.data ?? []).map((model) => model.id ?? "").filter(Boolean) };
      } catch (error) {
        return { ok: false, reason: `no se pudo consultar el catálogo: ${(error as Error).message}` };
      }
    }
    const wanted = [this.config.model, ...(this.config.aliases ?? [])];
    const found = wanted.find((model) => this.catalog?.ids.includes(model));
    if (!found) {
      return {
        ok: false,
        reason: `el modelo de ASR «${this.config.model}» no está habilitado en esta cuenta (catálogo: ${this.catalog?.ids.length ?? 0} modelos). Habilítalo en build.nvidia.com o cambia VOICE_ASR_MODEL.`,
      };
    }
    const mode = asrModeFor(found);
    if (mode === "stream") {
      return {
        ok: false,
        reason: `«${found}» se sirve por websocket de streaming, no por el endpoint de fichero que usa este adaptador. Usa un modelo ctc/tdt (p. ej. nvidia/parakeet-tdt-0.6b) o implemento la API de streaming.`,
      };
    }
    return { ok: true };
  }

  /** Envuelve PCM en un WAV (lo que espera el endpoint de transcripción). */
  static toWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcm.length;
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcm]);
  }

  /**
   * Transcripción con un modelo omni: el audio viaja como bloque `audio_url`
   * con un data URL y el modelo devuelve el texto.
   */
  private async transcribeWithOmni(wav: Buffer): Promise<AsrResult> {
    return this.withRetry("asr-omni", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.url("/chat/completions"), {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 256,
          // Transcribir no necesita razonar: medido, el primer token baja de
          // 2 878 ms a 807 ms sin cambiar el texto reconocido.
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Transcribe el audio en el idioma en que se habla. Devuelve SOLO la transcripción: sin comillas, sin prefijos, sin explicaciones.",
                },
                { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${wav.toString("base64")}` } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`el modelo de ASR respondió HTTP ${response.status}: ${detail}`);
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (payload.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("el modelo de ASR no devolvió transcripción");
      return { text };
    } finally {
      clearTimeout(timer);
    }
    });
  }

  async transcribe(pcm: Buffer, sampleRate: number): Promise<AsrResult> {
    if (pcm.length === 0) throw new Error("no hay audio para transcribir");
    const wav = NvidiaAsrProvider.toWav(pcm, sampleRate);
    if (isOmniAsrModel(this.config.model)) {
      return this.transcribeWithOmni(wav);
    }
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", this.config.model);
    if (this.config.language) form.append("language", this.config.language);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.url("/audio/transcriptions"), {
        method: "POST",
        headers: this.headers(),
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`el modelo de ASR respondió HTTP ${response.status}: ${detail}`);
      }
      const payload = (await response.json()) as { text?: string; transcript?: string; confidence?: number };
      const text = (payload.text ?? payload.transcript ?? "").trim();
      const result: AsrResult = { text };
      if (typeof payload.confidence === "number") result.confidence = payload.confidence;
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
