import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TtsEngine, TtsResult } from "./tts.js";

/**
 * Motor de síntesis con una voz CLONADA (Qwen3-TTS en llama.cpp).
 *
 * Es el motor que usa la app "Clonar voz": un modelo Qwen3-TTS (GGUF) más un
 * audio de referencia con la voz que se quiere imitar. La diferencia con
 * `say` es que aquí la voz es la que el usuario ha clonado: no hay que
 * instalarse ninguna voz del sistema.
 *
 * Coste: el modelo son ~1,4 GB y la síntesis va en CPU, así que es MUCHO más
 * lenta que `say` (ver `benchmarks`). Por eso este motor sirve para dos
 * cosas distintas:
 *
 *  · **pre-renderizar** (offline): un banco de frases grabadas con la voz
 *    clonada, que en tiempo de ejecución se reproducen al instante. Ver
 *    `phrase-bank.ts`.
 *  · **voz dinámica**: cuando hay GPU (local o remota) el tiempo baja y se
 *    puede sintetizar cada frase del turno en directo.
 *
 * Opciones:
 *  · `binary`      ruta a `llama-tts` (llama.cpp con soporte de Qwen3-TTS).
 *  · `model`       ruta al .gguf principal.
 *  · `mmproj`      ruta al mmproj .gguf (el proyector de audio).
 *  · `reference`   WAV de referencia con la voz clonada.
 *  · `language`    idioma del texto ("es").
 *  · `device`      id del dispositivo de llama.cpp ("auto" = el que prefiera).
 *  * `maxFrames`   tope de frames (12 frames = 1 s de audio).
 */
export interface QwenTtsOptions {
  binary: string;
  model: string;
  mmproj: string;
  reference?: string;
  language?: string;
  /** "auto" | "cpu" | id del dispositivo. */
  device?: string;
  /** Capas descargadas a la GPU (0 = CPU pura). */
  gpuLayers?: number;
  maxFrames?: number;
  threads?: number;
  /** Timeout de la síntesis (ms). El modelo tarda MUCHO en arrancar. */
  timeoutMs?: number;
  /** Semilla fija: la misma frase suena igual cada vez. */
  seed?: number;
}

const DEFAULT_MAX_FRAMES = 2400;
const DEFAULT_TIMEOUT_MS = 300_000;

export class QwenTts implements TtsEngine {
  readonly name = "qwen3-tts-gguf";
  private readonly options: QwenTtsOptions;

  constructor(options: QwenTtsOptions) {
    this.options = options;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const missing: string[] = [];
    for (const [label, path] of [
      ["binario llama-tts", this.options.binary],
      ["modelo", this.options.model],
      ["mmproj", this.options.mmproj],
    ] as const) {
      if (!path) {
        missing.push(label);
        continue;
      }
      try {
        await stat(path);
      } catch {
        missing.push(`${label} (${path})`);
      }
    }
    if (this.options.reference) {
      try {
        await stat(this.options.reference);
      } catch {
        missing.push(`audio de referencia (${this.options.reference})`);
      }
    }
    if (missing.length > 0) {
      return { ok: false, reason: `faltan: ${missing.join(", ")}` };
    }
    return { ok: true };
  }

  describe(): { voice: string | null; realistic: boolean; hint: string } {
    const reference = this.options.reference;
    return {
      voice: reference ? `voz clonada (${reference.split("/").slice(-2).join("/")})` : "voz clonada (sin referencia)",
      realistic: true,
      hint: "",
    };
  }

  async synthesize(text: string): Promise<TtsResult> {
    const clean = text.trim();
    if (!clean) throw new Error("texto vacío para sintetizar");

    const dir = await mkdtemp(join(tmpdir(), "jarvis-qwen-tts-"));
    const file = join(dir, "out.wav");
    try {
      const cmd = this.buildCommand(clean, file);
      await run(cmd, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const audio = await readFile(file);
      return {
        audio,
        mimeType: "audio/wav",
        sampleRate: 24_000,
        durationMs: estimateWavDurationMs(audio),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private buildCommand(text: string, output: string): string[] {
    const options = this.options;
    const device = options.device ?? "auto";
    const cmd = [
      options.binary,
      "-m",
      options.model,
      "-mm",
      options.mmproj,
      "-p",
      text,
      "-o",
      output,
      "--tts-lang",
      options.language ?? "es",
      "-n",
      String(options.maxFrames ?? DEFAULT_MAX_FRAMES),
    ];
    if (device === "cpu") {
      cmd.push("-ngl", "0", "--device", "none", "--no-mmproj-offload");
    } else if (device !== "auto") {
      cmd.push("-ngl", String(options.gpuLayers ?? 99), "--device", device, "-mmdev", device);
    } else {
      // "auto": que decida llama.cpp. Sin argumentos de dispositivo, porque
      // un "--device" vacío se comería el argumento siguiente.
      cmd.push("-ngl", String(options.gpuLayers ?? 99));
    }
    if (options.threads && options.threads > 0) cmd.push("-t", String(options.threads));
    if (options.seed !== undefined && options.seed >= 0) cmd.push("-s", String(options.seed));
    if (options.reference) cmd.push("--tts-speaker-file", options.reference);
    return cmd;
  }
}

function run(cmd: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`la síntesis del modelo clonado tardó más de ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`no se pudo ejecutar el modelo clonado: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`el modelo clonado terminó con código ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/** Duración de un WAV PCM: se leen la cabecera y el chunk `data` reales. */
export function estimateWavDurationMs(wav: Buffer): number {
  let offset = 12;
  let channels = 1;
  let rate = 24_000;
  while (offset + 8 <= wav.length) {
    const id = wav.slice(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10) || 1;
      rate = wav.readUInt32LE(offset + 12) || rate;
    }
    if (id === "data") {
      const bytesPerSecond = rate * channels * 2;
      return bytesPerSecond > 0 ? Math.round((size / bytesPerSecond) * 1000) : 0;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}
