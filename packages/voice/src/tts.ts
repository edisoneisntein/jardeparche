import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Motor de síntesis de voz del lado del SERVIDOR.
 *
 * Por qué en el servidor y no en el navegador:
 *  · el `speechSynthesis` del navegador no expone el instante en que suena el
 *    primer_sample (no hay TTFA medible), no permite cancelar con precisión y
 *    depende de las voces instaladas en cada máquina;
 *  · en el servidor la latencia de síntesis es una métrica real, se puede
 *    cachear, y la voz es la misma para todos los clientes.
 *
 * Implementación local de macOS: `say`, que produce WAV PCM sin coste ni
 * claves. Cada frase se sintetiza por separado para poder empezar a hablar
 * antes de tener la respuesta completa.
 */

export interface TtsResult {
  /** WAV PCM 16 bits mono. */
  audio: Buffer;
  mimeType: string;
  sampleRate: number;
  /** Duración estimada del audio en ms. */
  durationMs: number;
}

export interface TtsEngine {
  readonly name: string;
  /** Comprueba si el motor puede sintetizar ahora mismo. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  synthesize(text: string): Promise<TtsResult>;
  /** Describe la voz en uso (opcional: no todos los motores la fijan). */
  describe?(): VoiceDescription;
}

const SAMPLE_RATE = 22_050;
const DEFAULT_VOICE = "Jorge";

/**
 * Voces candidatas en español, por orden de preferencia.
 *
 * JARVIS habla con voz de hombre maduro y serio, no con una voz femenina.
 * Las dos primeras (`Jorge` y `Juan`) son las voces realistas de español de
 * España; no vienen instaladas de fábrica en macOS, se descargan en Ajustes
 * del Sistema → Accesibilidad → Contenido hablado → Voces del sistema →
 * Español → «Jorge». Mientras no estén, la lista cae en las voces de
 * carácter que sí existen (Reed, Rocko, Grandpa, Eddy) antes que en una voz
 * femenina: una voz de hombre aunque sea de novelty, antes que una de mujer.
 */
const VOICE_CANDIDATES = [
  "Jorge",
  "Juan",
  "Diego",
  "Carlos",
  "Reed",
  "Rocko",
  "Grandpa",
  "Eddy",
  "Mónica",
  "Monica",
  "Paulina",
];

/**
 * Voces de "character" de macOS: suenan amusing, no como una persona seria.
 * JARVIS es un hombre maduro: si no hay una voz realista, mejor decirlo que
 * fingir que la que suena es la adecuada.
 */
const NOVELTY_VOICES = new Set(["Reed", "Rocko", "Grandpa", "Eddy", "Flo", "Sandy", "Shelley", "Grandma"]);

/** Voces realistas (hombre o mujer) disponibles en macOS. */
const REALISTIC_VOICES = new Set(["Jorge", "Juan", "Diego", "Carlos", "Monica", "Mónica", "Paulina", "Helena", "Laura"]);

export interface VoiceDescription {
  /** Voz que se va a usar realmente. */
  voice: string | null;
  /** true si es una voz realista (no de las de "character"). */
  realistic: boolean;
  /** Qué hacer si no se quiere esa voz. */
  hint: string;
}

export interface MacSayOptions {
  voice?: string;
  /** Carpeta de caché de síntesis (evita repetir frases idénticas). */
  cacheDir?: string;
  maxCacheEntries?: number;
}

export class MacSayTts implements TtsEngine {
  readonly name = "macos-say";
  private readonly voice: string;
  private readonly cacheDir: string | null;
  private readonly maxCacheEntries: number;
  private resolvedVoice: string | null = null;
  /** LRU order of cache keys (oldest first). */
  private cacheOrder: string[] = [];

  constructor(options: MacSayOptions = {}) {
    // Una variable de entorno vacía significa "elige tú": la lista de
    // candidatos decide, no una voz en blanco que rompería la síntesis.
    const configured = (options.voice ?? process.env.VOICE_TTS_NAME ?? "").trim();
    this.voice = configured || DEFAULT_VOICE;
    this.cacheDir = options.cacheDir ?? null;
    this.maxCacheEntries = options.maxCacheEntries ?? 128;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== "darwin") {
      return { ok: false, reason: `la síntesis local requiere macOS (platform=${process.platform})` };
    }
    try {
      const voices = await listVoices();
      if (voices.length === 0) return { ok: false, reason: "no hay voces instaladas en el sistema" };
      this.resolvedVoice = await this.resolveVoice(voices);
      if (!this.resolvedVoice) return { ok: false, reason: "no hay ninguna voz en español disponible" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `no se pudo consultar el sintetizador: ${(error as Error).message}` };
    }
  }

  /** Voz realmente elegida, con la advertencia si no es la adecuada. */
  describe(): VoiceDescription {
    const voice = this.resolvedVoice ?? this.voice;
    const base = voice.replace(/\s*\(.*\)$/, "");
    const realistic = REALISTIC_VOICES.has(base);
    const novelty = NOVELTY_VOICES.has(base);
    return {
      voice,
      realistic,
      hint: realistic
        ? ""
        : novelty
          ? `La voz "${voice}" es una voz de carácter de macOS (suena a personaje, no a persona seria). Para la voz de hombre maduro de JARVIS, instala "Jorge": Ajustes del Sistema → Accesibilidad → Contenido hablado → Voces del sistema → Español → Jorge.`
          : `La voz "${voice}" no es la de hombre maduro que pide JARVIS. Instala "Jorge" (Ajustes del Sistema → Accesibilidad → Contenido hablado → Voces del sistema → Español) y quita VOICE_TTS_NAME del .env.`,
    };
  }

  private async resolveVoice(voices: string[]): Promise<string | null> {
    if (this.voice) {
      const exact = voices.includes(this.voice);
      const prefixed = pickVariant(voices, this.voice);
      if (exact) return this.voice;
      if (prefixed) return prefixed;
    }
    for (const candidate of VOICE_CANDIDATES) {
      if (voices.includes(candidate)) return candidate;
      // Las voces de carácter se listan con el idioma entre paréntesis
      // («Reed (Español (España))»): se aceptan por prefijo.
      const prefixed = pickVariant(voices, candidate);
      if (prefixed) return prefixed;
    }
    // Cualquier voz en español (es_*) sirve antes que la predeterminada del
    // sistema, que sería en inglés.
    const spanish = voices.find((voice) => voice.includes("es_ES") || voice.includes("español") || voice.includes("Mónica"));
    return spanish ?? null;
  }

  async synthesize(text: string): Promise<TtsResult> {
    const clean = text.trim();
    if (!clean) throw new Error("texto vacío para sintetizar");
    // Si nadie llamó a `available()` antes, se resuelve la voz ahora: sin esto
    // el sintetizador recibiría el nombre configurado ("Jorge") aunque no
    // esté instalado y fallaría con "Voice not found".
    if (!this.resolvedVoice) {
      const voices = await listVoices();
      this.resolvedVoice = await this.resolveVoice(voices);
    }
    if (!this.resolvedVoice) throw new Error("no hay ninguna voz en español disponible para sintetizar");

    const cacheKey = createHash("sha1").update(`${this.resolvedVoice}|${clean}`).digest("hex");
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const dir = await mkdtemp(join(tmpdir(), "jarvis-tts-"));
    const file = join(dir, "out.wav");
    try {
      await runSay(this.resolvedVoice, clean, file);
      const audio = await readFile(file);
      const result: TtsResult = {
        audio,
        mimeType: "audio/wav",
        sampleRate: SAMPLE_RATE,
        durationMs: estimateDurationMs(audio),
      };
      await this.writeCache(cacheKey, result);
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readCache(key: string): Promise<TtsResult | null> {
    if (!this.cacheDir) return null;
    try {
      const path = join(this.cacheDir, `${key}.wav`);
      const audio = await readFile(path);
      // update LRU
      const idx = this.cacheOrder.indexOf(key);
      if (idx !== -1) this.cacheOrder.splice(idx, 1);
      this.cacheOrder.push(key);
      return { audio, mimeType: "audio/wav", sampleRate: SAMPLE_RATE, durationMs: estimateDurationMs(audio) };
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, result: TtsResult): Promise<void> {
    if (!this.cacheDir) return;
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(join(this.cacheDir, `${key}.wav`), result.audio);
      // LRU update
      const idx = this.cacheOrder.indexOf(key);
      if (idx !== -1) this.cacheOrder.splice(idx, 1);
      this.cacheOrder.push(key);
      // evict oldest
      while (this.cacheOrder.length > this.maxCacheEntries) {
        const oldest = this.cacheOrder.shift();
        if (oldest) {
          await rm(join(this.cacheDir, `${oldest}.wav`), { force: true }).catch(() => undefined);
        }
      }
    } catch {
      /* la caché es una optimización: si falla, se sigue sintetizando */
    }
  }
}

/**
 * Elige la variante de una voz entre las instalada.
 *
 * macOS instala la misma voz en varios idiomas: "Reed (Inglés (RU))",
 * "Reed (Español (España))", "Reed (Español (México))". Coger la primera que
 * empieza por el nombre es un sorteo: habíaSynthesis leyendo la voz RUSA de
 * Reed. Se prefieren las variantes de español, y dentro de ellas la de
 * España.
 */
export function pickVariant(voices: string[], name: string): string | undefined {
  const candidates = voices.filter((voice) => voice === name || voice.startsWith(`${name} (`));
  if (candidates.length === 0) return undefined;
  const exact = candidates.find((voice) => voice === name);
  if (exact) return exact;
  const spanishSpain = candidates.find((voice) => /es_ES|Español \(España\)/.test(voice));
  if (spanishSpain) return spanishSpain;
  const spanish = candidates.find((voice) => /es_[A-Z]{2}|Español/i.test(voice));
  if (spanish) return spanish;
  return candidates[0];
}

/** Lista de voces instaladas (`say -v '?'`). */
export async function listVoices(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      // El separador entre la voz y su código de idioma es de UNO o más
      // espacios: con los nombres largos ("Reed (Español (España))") macOS no
      // rellena a la ancho de columna, y exigir dos espacios dejaba fuera
      // JUSTO las voces de español con nombre compuesto.
      const voices = out
        .split("\n")
        .map((line) => line.match(/^(\S.*?)\s+[a-z]{2}_[A-Z]{2}\s+#/)?.[1]?.trim())
        .filter((name): name is string => Boolean(name));
      resolve(voices);
    });
  });
}

function runSay(voice: string, text: string, outputFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "say",
      ["-v", voice, "-o", outputFile, "--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`, text],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(new Error(`no se pudo ejecutar el sintetizador: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`el sintetizador terminó con código ${code}: ${stderr.trim().slice(0, 160)}`));
    });
  });
}

/**
 * Duración de un WAV PCM 16 bits mono. Se busca el chunk `data` real: la
 * cabecera que produce `say` ocupa 4 096 bytes, no los 44 del WAV mínimo, y
 * usar el tamaño total sobrestimaba la duración.
 */
export function estimateDurationMs(wav: Buffer): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.slice(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return Math.round((size / 2 / SAMPLE_RATE) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  const dataBytes = Math.max(0, wav.length - 44);
  return Math.round((dataBytes / 2 / SAMPLE_RATE) * 1000);
}
