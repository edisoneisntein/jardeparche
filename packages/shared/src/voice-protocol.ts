import { z } from "zod";

/**
 * Protocolo de Handshake Atómico de Interrupción (P1)
 *
 * Invariante: Un segmento de audio NUNCA debe emitirse después de que su generación
 * haya sido cancelada. Esto requiere sincronización atómica entre cliente y servidor
 * mediante epoch compartido y barreras de memoria.
 */

export const VoiceInterruptRequestSchema = z.object({
  type: z.literal("voice.interrupt.request"),
  sessionId: z.string(),
  /** Época del servidor que el cliente solicita cancelar */
  serverEpoch: z.number().int().nonnegative(),
  /** Generación del cliente (monotónicamente creciente) */
  clientGeneration: z.number().int().nonnegative(),
  /** Timestamp del cliente para medición de RTT */
  clientTimestamp: z.number().int().positive(),
});

export const VoiceInterruptAckSchema = z.object({
  type: z.literal("voice.interrupt.ack"),
  sessionId: z.string(),
  /** Época confirmada como cancelada por el servidor */
  confirmedEpoch: z.number().int().nonnegative(),
  /** Bytes de audio drenados/descartados en el servidor */
  flushedBytes: z.number().int().nonnegative(),
  /** Timestamp del servidor para medición de RTT */
  serverTimestamp: z.number().int().positive(),
  /** Nueva época activa en el servidor (para sincronización) */
  newServerEpoch: z.number().int().nonnegative(),
});

export const VoiceAudioSegmentSchema = z.object({
  type: z.literal("voice.audio.segment"),
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
  generationId: z.string(),
  /** Índice de la frase dentro de la locución */
  index: z.number().int().nonnegative(),
  /** Texto de la frase (lo que se ha sintetizado) */
  text: z.string(),
  /** Audio WAV PCM 16 bits mono, en base64 */
  audio: z.string(),
  mimeType: z.string(),
  sampleRate: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  /** Época del servidor para validación de frescura */
  serverEpoch: z.number().int().nonnegative(),
});

export const VoiceSpeakingStartedSchema = z.object({
  type: z.literal("voice.speaking.started"),
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
  generationId: z.string(),
  /** El servidor aporta el audio: el cliente no usa la voz del navegador */
  serverAudio: z.boolean().optional(),
  /** Época inicial del servidor para esta locución */
  serverEpoch: z.number().int().nonnegative(),
});

export const VoiceOutputStoppedSchema = z.object({
  type: z.literal("voice.output_stopped"),
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
  generationId: z.string(),
  reason: z.enum(["completed", "interrupted"]).default("completed"),
  /** Época del servidor al momento de la parada */
  serverEpoch: z.number().int().nonnegative(),
});

export type VoiceInterruptRequest = z.infer<typeof VoiceInterruptRequestSchema>;
export type VoiceInterruptAck = z.infer<typeof VoiceInterruptAckSchema>;
export type VoiceAudioSegment = z.infer<typeof VoiceAudioSegmentSchema>;
export type VoiceSpeakingStarted = z.infer<typeof VoiceSpeakingStartedSchema>;
export type VoiceOutputStopped = z.infer<typeof VoiceOutputStoppedSchema>;

/**
 * Estados de la máquina de estados de interrupción (lado cliente)
 */
export enum InterruptState {
  IDLE = "idle",
  REQUEST_SENT = "request_sent",
  ACK_RECEIVED = "ack_received",
}

/**
 * Configuración del VAD Adaptativo (P2)
 */
export const VadConfigSchema = z.object({
  /** Umbral de ataque (inicio de habla) - ratio sobre noise floor */
  attackThresholdRatio: z.number().positive().default(2.5),
  /** Umbral de caída (fin de habla) - ratio sobre noise floor */
  releaseThresholdRatio: z.number().positive().default(1.8),
  /** Silencio mínimo en ms para confirmar fin de habla */
  minSilenceMs: z.number().int().positive().default(600),
  /** Factor de suavizado EMA para noise floor (0-1) */
  noiseFloorAlpha: z.number().min(0).max(1).default(0.001),
  /** Factor de suavizado EMA para señal pico (0-1) */
  signalPeakAlpha: z.number().min(0).max(1).default(0.1),
  /** Duración mínima de habla válida en ms */
  minSpeechDurationMs: z.number().int().positive().default(250),
  /** Calentamiento inicial en ms antes de activar VAD */
  warmupMs: z.number().int().positive().default(200),
  /** Umbral absoluto mínimo */
  absoluteMinThreshold: z.number().positive().default(0.006),
  /** Umbral absoluto máximo */
  absoluteMaxThreshold: z.number().positive().default(0.08),
});

export type VadConfig = z.infer<typeof VadConfigSchema>;

export const DEFAULT_VAD_CONFIG: VadConfig = VadConfigSchema.parse({});

/**
 * Mensajes del AudioWorklet hacia el hilo principal
 */
export const WorkletToMainSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("level"), level: z.number().min(0).max(1) }),
  z.object({ type: z.literal("chunk"), pcm: z.instanceof(Int16Array) }),
  z.object({ type: z.literal("speechStart") }),
  z.object({ type: z.literal("speechEnd") }),
  z.object({ type: z.literal("vadState"), threshold: z.number(), noiseFloor: z.number(), isSpeech: z.boolean() }),
]);

export const MainToWorkletSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("config"), config: VadConfigSchema }),
  z.object({ type: z.literal("reset") }),
]);

export type WorkletToMainMessage = z.infer<typeof WorkletToMainSchema>;
export type MainToWorkletMessage = z.infer<typeof MainToWorkletSchema>;

/**
 * Eventos de métricas de voz para OpenTelemetry (FASE 4)
 */
export enum VoiceMetricEventType {
  VAD_SPEECH_START = "vad_speech_start",
  VAD_SPEECH_END = "vad_speech_end",
  VAD_FALSE_POSITIVE = "vad_false_positive",
  VAD_FALSE_NEGATIVE = "vad_false_negative",
  ASR_START = "asr_start",
  ASR_FIRST_TOKEN = "asr_first_token",
  ASR_COMPLETE = "asr_complete",
  LLM_FIRST_TOKEN = "llm_first_token",
  LLM_STREAM_CHUNK = "llm_stream_chunk",
  TTS_FIRST_CHUNK = "tts_first_chunk",
  TTS_CHUNK_SYNTHESIZED = "tts_chunk_synthesized",
  NETWORK_SEND = "network_send",
  NETWORK_RECEIVE = "network_receive",
  INTERRUPT_REQUEST = "interrupt_request",
  INTERRUPT_ACK = "interrupt_ack",
  TTFA = "ttfa",
  E2E_LATENCY = "e2e_latency",
}

export interface VoiceMetricEvent {
  type: VoiceMetricEventType;
  sessionId: string;
  generationId?: string;
  epoch?: number;
  timestamp: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}