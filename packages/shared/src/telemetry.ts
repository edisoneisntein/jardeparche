/**
 * OpenTelemetry Instrumentation para Voz (FASE 4).
 *
 * Métricas y trazas distribuidas para observabilidad forense del pipeline de voz.
 * Compatible con OpenTelemetry SDK estándar.
 */

import { context, trace, metrics, SpanStatusCode, type Span, type Tracer, type Meter } from "@opentelemetry/api";

// Nombres de atributos estándar (semantic conventions)
export const VoiceAttributes = {
  SESSION_ID: "voice.session_id",
  GENERATION_ID: "voice.generation_id",
  EPOCH: "voice.epoch",
  MODEL: "voice.model",
  LANGUAGE: "voice.language",
  SAMPLE_RATE: "voice.sample_rate",
  AUDIO_DURATION_MS: "voice.audio_duration_ms",
  TEXT_LENGTH: "voice.text_length",
  IS_FINAL: "voice.is_final",
  SERVER_AUDIO: "voice.server_audio",
  INTERRUPT_REASON: "voice.interrupt_reason",
  ERROR_TYPE: "voice.error_type",
  BUFFERED_AMOUNT: "voice.buffered_amount",
  HIGH_WATER_MARK: "voice.high_water_mark",
  INDEX: "voice.index",
} as const;

export const VoiceMetricNames = {
  VAD_SPEECH_START: "voice.vad.speech_start",
  VAD_SPEECH_END: "voice.vad.speech_end",
  VAD_FALSE_POSITIVE: "voice.vad.false_positive",
  VAD_FALSE_NEGATIVE: "voice.vad.false_negative",
  ASR_START: "voice.asr.start",
  ASR_FIRST_TOKEN: "voice.asr.first_token",
  ASR_COMPLETE: "voice.asr.complete",
  ASR_LATENCY: "voice.asr.latency",
  LLM_FIRST_TOKEN: "voice.llm.first_token",
  LLM_STREAM_CHUNK: "voice.llm.stream_chunk",
  TTS_FIRST_CHUNK: "voice.tts.first_chunk",
  TTS_CHUNK_SYNTHESIZED: "voice.tts.chunk_synthesized",
  TTS_CHUNK_EMITTED: "voice.tts.chunk_emitted",
  NETWORK_SEND: "voice.network.send",
  NETWORK_RECEIVE: "voice.network.receive",
  NETWORK_RTT: "voice.network.rtt",
  INTERRUPT_REQUEST: "voice.interrupt.request",
  INTERRUPT_ACK: "voice.interrupt.ack",
  INTERRUPT_LATENCY: "voice.interrupt.latency",
  TTFA: "voice.ttfa",
  E2E_LATENCY: "voice.e2e_latency",
  BACKPRESSURE_ACTIVE: "voice.backpressure.active",
  BUFFER_SATURATION: "voice.buffer.saturation",
} as const;

// Instancias globales (inicializadas por la app)
let tracer: Tracer | null = null;
let meter: Meter | null = null;

export function initTelemetry(t: Tracer, m: Meter): void {
  tracer = t;
  meter = m;
}

export function getTracer(): Tracer | null {
  return tracer;
}

export function getMeter(): Meter | null {
  return meter;
}

/**
 * Crea un span para una operación de voz con atributos estándar.
 */
export function startVoiceSpan(name: string, attributes: Record<string, unknown> = {}): Span | null {
  if (!tracer) return null;
  return tracer.startSpan(name, {
    attributes: {
      "voice.operation": name,
      ...attributes,
    },
  });
}

/**
 * Registra una métrica de voz.
 */
export function recordVoiceMetric(
  name: string,
  value: number,
  attributes: Record<string, string | number | boolean> = {},
): void {
  if (!meter) return;
  const counter = meter.createCounter(name, { description: `Voice metric: ${name}` });
  counter.add(value, attributes);
}

export function recordVoiceHistogram(
  name: string,
  value: number,
  attributes: Record<string, string | number | boolean> = {},
): void {
  if (!meter) return;
  const histogram = meter.createHistogram(name, { description: `Voice histogram: ${name}`, unit: "ms" });
  histogram.record(value, attributes);
}

/**
 * Span wrapper para operaciones asíncronas con finalización automática.
 */
export async function withVoiceSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const span = startVoiceSpan(name, attributes);
  try {
    const result = await fn(span);
    span?.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span?.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
    span?.recordException(error as Error);
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Helper para medir latencia entre dos timestamps.
 */
export function measureLatency(startTime: number, endTime: number = Date.now()): number {
  return endTime - startTime;
}

/**
 * Eventos de vida del span para correlación.
 */
export function addVoiceEvent(span: Span | null, name: string, attributes: Record<string, unknown> = {}): void {
  if (!span) return;
  span.addEvent(name, {
    "voice.event": name,
    ...attributes,
  });
}

/**
 * Convención de nombres de spans para el pipeline de voz.
 */
export const VoiceSpanNames = {
  VAD_DETECT: "voice.vad.detect",
  VAD_SPEECH_START: "voice.vad.speech_start",
  VAD_SPEECH_END: "voice.vad.speech_end",
  ASR_STREAM: "voice.asr.stream",
  ASR_TRANSCRIBE: "voice.asr.transcribe",
  LLM_GENERATE: "voice.llm.generate",
  LLM_STREAM: "voice.llm.stream",
  TTS_SYNTHESIZE: "voice.tts.synthesize",
  TTS_STREAM: "voice.tts.stream",
  NETWORK_SEND: "voice.network.send",
  NETWORK_RECEIVE: "voice.network.receive",
  INTERRUPT_HANDSHAKE: "voice.interrupt.handshake",
  AUDIO_PLAYBACK: "voice.audio.playback",
} as const;