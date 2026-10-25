import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { normalizeForSpeech } from "@jarvis/shared";
import type { TtsEngine, TtsResult } from "./tts.js";

/**
 * Banco de frases pre-renderizadas.
 *
 * El problema: una voz clonada (Qwen3-TTS) es lentísima en CPU — medido en
 * esta máquina: 2 s de audio por cada 116 s de proceso, o sea 0,04x tiempo
 * real. Eso no sirve para hablar, pero SÍ sirve para **pregrabar**: la
 * clonación se hace una vez (offline, de noche) y en tiempo de ejecución la
 * frase se reproduce al instante, con la voz clonada exacta.
 *
 * El banco es un directorio de WAV con un índice JSON. La clave es el texto
 * NORMALIZADO (el mismo que se sintetiza), así que da igual si la frase
 * lleva comas o distinta puntuación.
 *
 * En ejecución, el motor consulta el banco ANTES de sintetizar: si la frase
 * está, se reproduce el audio; si no, se sintetiza con el motor normal.
 */
export interface PhraseBankEntry {
  /** Texto tal y como se escribió (para poder re-sintetizarlo). */
  text: string;
  /** Texto normalizado: la clave de búsqueda. */
  key: string;
  /** Fichero WAV dentro del directorio del banco. */
  file: string;
  /** Duración en ms. */
  durationMs: number;
}

export interface PhraseBankIndex {
  version: 1;
  /** De dónde salió la voz (para poder saber qué motor la grabó). */
  source?: string;
  entries: PhraseBankEntry[];
}

export interface PhraseBankOptions {
  /** Directorio del banco. */
  directory: string;
  /**
   * Coincidencia por similitud cuando el texto no está exacto. "a" = solo
   * exacto; "b" = prefijo; "c" = similitud. Requiere `similarity` ≥ 0.8.
   */
  similarity?: number;
}

/**
 * Clave de búsqueda: el texto normalizado, en minúsculas y sin puntuación
 * final. "Entendido.", "entendido" y "¡Entendido!" son la MISMA frase: la
 * puntuación con la que el modelo se despide no debe decidir si la frase
 * está en el banco.
 */
export function phraseKey(text: string): string {
  return normalizeForSpeech(text)
    .toLowerCase()
    .replace(/[.!?;:…]+$/g, "")
    .replace(/^[¿¡]+|[¿¡]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class PhraseBank {
  private readonly options: PhraseBankOptions;
  private index: PhraseBankIndex = { version: 1, entries: [] };
  private loaded = false;

  constructor(options: PhraseBankOptions) {
    this.options = options;
  }

  /** Carga el índice del banco (si existe). */
  async load(): Promise<void> {
    this.loaded = true;
    try {
      const raw = await readFile(join(this.options.directory, "index.json"), "utf8");
      const parsed = JSON.parse(raw) as PhraseBankIndex;
      if (parsed && Array.isArray(parsed.entries)) this.index = parsed;
    } catch {
      this.index = { version: 1, entries: [] };
    }
  }

  get size(): number {
    return this.index.entries.length;
  }

  get source(): string | undefined {
    return this.index.source;
  }

  /** ¿Hay alguna frase en el banco? */
  async available(): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded();
    if (this.index.entries.length === 0) {
      return { ok: false, reason: "el banco de frases está vacío" };
    }
    return { ok: true };
  }

  /**
   * Busca la frase en el banco.
   *
   * Primero el texto exacto; si no, la frase másparecida por encima del
   * umbral de similitud (y solo si la diferencia es pequeña: "sí" no debe
   * responder "no").
   */
  async find(text: string): Promise<{ audio: Buffer; entry: PhraseBankEntry } | null> {
    await this.ensureLoaded();
    if (this.index.entries.length === 0) return null;
    const key = phraseKey(text);
    if (!key) return null;

    const exact = this.index.entries.find((entry) => entry.key === key);
    const entry = exact ?? this.bestMatch(key);
    if (!entry) return null;
    try {
      const audio = await readFile(join(this.options.directory, entry.file));
      return { audio, entry };
    } catch {
      return null;
    }
  }

  /** Graba una frase en el banco (offline). */
  async render(text: string, engine: TtsEngine): Promise<PhraseBankEntry> {
    const result: TtsResult = await engine.synthesize(text);
    await mkdir(this.options.directory, { recursive: true });
    const key = phraseKey(text);
    const file = `${createHash("sha1").update(key).digest("hex")}.wav`;
    await writeFile(join(this.options.directory, file), result.audio);
    const entry: PhraseBankEntry = {
      text,
      key,
      file,
      durationMs: result.durationMs,
    };
    const entries = this.index.entries.filter((item) => item.key !== key);
    entries.push(entry);
    this.index.entries = entries;
    await writeFile(join(this.options.directory, "index.json"), JSON.stringify(this.index, null, 2), "utf8");
    return entry;
  }

  private bestMatch(key: string): PhraseBankEntry | undefined {
    const threshold = this.options.similarity ?? 0;
    if (threshold <= 0) return undefined;
    let best: PhraseBankEntry | undefined;
    let bestScore = threshold;
    for (const entry of this.index.entries) {
      if (Math.abs(entry.key.length - key.length) > 12) continue;
      const score = similarity(entry.key, key);
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }
}

/** Similitud de trigramas (0..1). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const grams = new Map<string, number>();
  for (let index = 0; index <= a.length - 3; index += 1) {
    const gram = a.slice(index, index + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let common = 0;
  for (let index = 0; index <= b.length - 3; index += 1) {
    const gram = b.slice(index, index + 3);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      common += 1;
      grams.set(gram, count - 1);
    }
  }
  return (2 * common) / (a.length + b.length - 4);
}

/** Motor que sirve el banco cuando puede y delega en el motor real si no. */
export class PhraseBankEngine implements TtsEngine {
  readonly name = "phrase-bank";
  private readonly bank: PhraseBank;
  private readonly fallback: TtsEngine;
  /** Cuántas frases se han servido desde el banco (telemetría). */
  private hits = 0;
  private misses = 0;

  constructor(bank: PhraseBank, fallback: TtsEngine) {
    this.bank = bank;
    this.fallback = fallback;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const status = await this.bank.available();
    if (!status.ok) return this.fallback.available();
    return { ok: true };
  }

  describe(): { voice: string | null; realistic: boolean; hint: string } {
    const described = this.fallback.describe?.();
    if (this.hits === 0 && this.misses === 0) {
      return {
        voice: `voz clonada (${this.bank.size} frases pregrabadas)`,
        realistic: true,
        hint: "",
      };
    }
    return {
      voice: `voz clonada (${this.hits} frases del banco, ${this.misses} sintéticas)`,
      realistic: described?.realistic ?? true,
      hint: described?.hint ?? "",
    };
  }

  async synthesize(text: string): Promise<TtsResult> {
    const hit = await this.bank.find(text);
    if (hit) {
      this.hits += 1;
      return {
        audio: hit.audio,
        mimeType: "audio/wav",
        sampleRate: 24_000,
        durationMs: hit.entry.durationMs,
      };
    }
    this.misses += 1;
    return this.fallback.synthesize(text);
  }
}
