import { normalizeForSpeech } from "@jarvis/shared";
import { safeCut, splitSentences } from "./sentences.js";
import type { TtsEngine } from "./tts.js";
import { getTracer, VoiceSpanNames, VoiceAttributes, VoiceMetricNames, recordVoiceHistogram, addVoiceEvent } from "@jarvis/shared";

/**
 * Síntesis por frases EN STREAMING con Generation Fencing (P1).
 *
 * Invariante de seguridad: Un fragmento de audio NUNCA se emite si su epoch
 * es menor al epoch actual del streamer. Esto previene condiciones de carrera
 * donde audio de una locución interrumpida se reproduce sobre la nueva.
 *
 * Arquitectura:
 * - Cada locución tiene un epoch monolíticamente creciente (uint32)
 * - Barrera de memoria (emissionFence) garantiza ordenamiento happens-before
 * - Síntesis en PARALELO, emisión en ORDEN (secuencial por índice)
 * - Límite de concurrencia configurable para evitar saturación de CPU
 */

export interface StreamSegment {
  generationId: string;
  index: number;
  text: string;
  audio: Buffer;
  mimeType: string;
  sampleRate: number;
  durationMs: number;
  /** Época del servidor para validación de frescura */
  serverEpoch: number;
}

export interface StreamerOptions {
  tts: TtsEngine;
  /** Publica un segmento de audio ya sintetizado. */
  onSegment: (segment: StreamSegment) => void;
  /** Avisa de que terminó la locución. */
  onEnd: (generationId: string) => void;
  /** Registra un problema (la síntesis falló). */
  onError?: (error: Error) => void;
  /** Longitud máxima de una frase antes de partirla. */
  maxSentenceChars?: number;
  /**
   * Longitud a partir de la cual el texto pendiente se corta aunque no haya
   * cierre de frase. Es el freno de la latencia: sin él, una enumeración sin
   * puntos dejaría al usuario en silencio hasta el final del turno.
   */
  maxPendingChars?: number;
  /**
   * Cuántas frases se sintetizan a la vez. En una CPU de 4 hilos, 2 o 3 es lo
   * que da sin que una synthesis se coma a las demás.
   */
  maxConcurrent?: number;
}

const DEFAULT_MAX_SENTENCE_CHARS = 320;
const DEFAULT_MAX_PENDING_CHARS = 160;
const DEFAULT_MAX_CONCURRENT = 3;

export class SentenceStreamer {
  private readonly options: StreamerOptions;
  private readonly maxSentenceChars: number;
  private readonly maxPendingChars: number;
  private readonly maxConcurrent: number;
  private generationId = "";
  private buffer = "";
  private index = 0;
  /** Cadena de EMISIÓN: mantiene el orden de los fragmentos. */
  private emision: Promise<void> = Promise.resolve();
  /** Síntesis en curso (en paralelo). */
  private inflight = 0;
  private readonly espera: Array<() => void> = [];
  private stopped = false;
  /**
   * Época de la locución en curso (monotónicamente creciente, uint32).
   *
   * Cada `start()` y cada `stop()` lo incrementan. El trabajo en vuelo de una
   * locución anterior comprueba su epoch antes de publicar: si la locución ya
   * no es la actual, su audio se descarta.
   */
  private epoch = 0;
  /**
   * Barrera de memoria (Memory Fence) para sincronización happens-before.
   *
   * Cuando se produce una interrupción, `stop()` actualiza esta promesa.
   * Todos los fragmentos en vuelo deben `await` esta barrera ANTES de verificar
   * su epoch. Esto garantiza que el incremento de epoch en `stop()` es visible
   * para todos los workers de síntesis antes de que consulten `this.epoch`.
   */
  private emissionFence: Promise<void> = Promise.resolve();

  constructor(options: StreamerOptions) {
    this.options = options;
    this.maxSentenceChars = options.maxSentenceChars ?? DEFAULT_MAX_SENTENCE_CHARS;
    this.maxPendingChars = options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /** Obtiene la época actual (para ACK de interrupción). */
  getCurrentEpoch(): number {
    return this.epoch;
  }

  /** Comienza una locución nueva: descarta lo que quedara de la anterior. */
  start(generationId: string): void {
    // Incremento atómico de epoch - establece happens-before para todos los workers
    this.epoch = (this.epoch + 1) >>> 0;
    this.generationId = generationId;
    this.buffer = "";
    this.index = 0;
    this.stopped = false;
    // Nueva barrera de emisión: los workers en vuelo deben esperar aquí
    this.emissionFence = this.emision;
    this.emision = Promise.resolve();

    // Telemetry: span para la locución completa
    const tracer = getTracer();
    if (tracer) {
      const span = tracer.startSpan(VoiceSpanNames.TTS_STREAM, {
        attributes: {
          [VoiceAttributes.GENERATION_ID]: generationId,
          [VoiceAttributes.EPOCH]: this.epoch,
        },
      });
      span?.end(); // Span corto para marcar inicio; spans hijos cubren síntesis
    }
  }

  /** Texto parcial recibido. */
  push(text: string): void {
    if (this.stopped) return;
    this.buffer += text;
    this.drain(false);
  }

  /** Fin del turno: encola lo que quede y cierra la locución. */
  flush(): void {
    if (this.stopped) return;
    this.drain(true);
    const currentEpoch = this.epoch;
    this.emision = this.emision.then(async () => {
      // Esperar a que se drene todo lo encolado antes de notificar fin
      if (this.stopped || currentEpoch !== this.epoch) return;
      this.options.onEnd(this.generationId);
    });
  }

  /** Corta la locución en curso (interrupción del usuario). */
  stop(): void {
    this.stopped = true;
    // Invalida lo que esté en vuelo: su audio ya no pertenece a nadie.
    // Incremento atómico con barrera de memoria
    this.epoch = (this.epoch + 1) >>> 0;
    this.buffer = "";
    // Nueva barrera: todos los workers en vuelo deben esperar aquí antes de verificar epoch
    this.emissionFence = this.emision;
  }

  private drain(final: boolean): void {
    const spans = splitSentences(this.buffer, this.maxSentenceChars);
    if (spans.length === 0) {
      if (final) {
        this.emitFragment(this.buffer);
        this.buffer = "";
      }
      return;
    }

    const last = spans[spans.length - 1];
    // La última frase solo está completa si termina en cierre y ya no puede
    // crecer: si no, se queda en el búfer esperando más texto.
    const lastIsComplete = final || /[.!?;]["»')\]]*\s*$/.test(last?.text ?? "");
    const complete = lastIsComplete ? spans : spans.slice(0, -1);
    // El texto pendiente se recupera de la cadena ORIGINAL (con sus espacios):
    // recortándolo se perdían los espacios y dos palabras acababan pegadas.
    let pending = lastIsComplete ? "" : this.buffer.slice(last?.start ?? this.buffer.length);

    for (const span of complete) this.emitFragment(span.text);

    // Freno de latencia: el texto pendiente es largo y no se cierra ninguna
    // frase. Se corta por el último límite natural para que la voz empiece
    // antes, en lugar de esperar a la frase entera.
    if (!final && pending.length >= this.maxPendingChars) {
      const cut = safeCut(pending, this.maxPendingChars);
      const piece = pending.slice(0, cut).trim();
      pending = pending.slice(cut);
      if (piece) this.emitFragment(piece);
    }

    this.buffer = pending;
  }

  /** Encola un fragmento: se sintetiza en paralelo y se emite en orden. */
  private emitFragment(raw: string): void {
    const text = normalizeForSpeech(raw);
    if (!text) return;
    const index = this.index++;
    const fragmentEpoch = this.epoch;
    const generationId = this.generationId;
    const synthesisStartTime = Date.now();

    const sintesis = this.adquirir()
      .then(() => {
        recordVoiceHistogram(VoiceMetricNames.TTS_CHUNK_SYNTHESIZED, 0, {
          [VoiceAttributes.GENERATION_ID]: generationId,
          [VoiceAttributes.EPOCH]: fragmentEpoch,
          [VoiceAttributes.TEXT_LENGTH]: text.length,
        });
        return this.options.tts.synthesize(text);
      })
      .then((result) => {
        const synthesisLatency = Date.now() - synthesisStartTime;
        recordVoiceHistogram(VoiceMetricNames.TTS_CHUNK_SYNTHESIZED, synthesisLatency, {
          [VoiceAttributes.GENERATION_ID]: generationId,
          [VoiceAttributes.EPOCH]: fragmentEpoch,
          [VoiceAttributes.AUDIO_DURATION_MS]: result.durationMs,
          [VoiceAttributes.TEXT_LENGTH]: text.length,
        });
        this.inflight -= 1;
        this.soltar();
        return { fragmentEpoch, generationId, index, text, result, synthesisLatency };
      })
      .catch((error: unknown) => {
        this.inflight -= 1;
        this.soltar();
        this.options.onError?.(error as Error);
        return null;
      });

    // La emisión mantiene el orden: el fragmento N se publica cuando le
    // toca, aunque se sintetizara en paralelo.
    this.emision = this.emision.then(async () => {
      // BARRERA DE MEMORIA: esperar a que cualquier stop() previo sea visible
      await this.emissionFence;
      const salida = await sintesis;
      if (!salida) return;
      // Verificación de frescura: descartar si la época cambió
      if (this.stopped || salida.fragmentEpoch !== this.epoch) return;

      const emitStartTime = Date.now();
      this.options.onSegment({
        generationId: salida.generationId,
        index: salida.index,
        text: salida.text,
        audio: salida.result.audio,
        mimeType: salida.result.mimeType,
        sampleRate: salida.result.sampleRate,
        durationMs: salida.result.durationMs,
        serverEpoch: salida.fragmentEpoch,
      });
      const emitLatency = Date.now() - emitStartTime;
      recordVoiceHistogram(VoiceMetricNames.TTS_CHUNK_EMITTED, emitLatency, {
        [VoiceAttributes.GENERATION_ID]: generationId,
        [VoiceAttributes.EPOCH]: fragmentEpoch,
        [VoiceAttributes.INDEX]: index,
      });

      // TTFA: primer fragmento emitido
      if (index === 0) {
        recordVoiceHistogram(VoiceMetricNames.TTFA, Date.now() - synthesisStartTime, {
          [VoiceAttributes.GENERATION_ID]: generationId,
          [VoiceAttributes.EPOCH]: fragmentEpoch,
        });
      }
    });
  }

  /** Limita cuántas síntesis corren a la vez. */
  private adquirir(): Promise<void> {
    if (this.inflight < this.maxConcurrent) {
      this.inflight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.espera.push(() => {
        this.inflight += 1;
        resolve();
      });
    });
  }

  private soltar(): void {
    const siguiente = this.espera.shift();
    if (siguiente) siguiente();
  }
}