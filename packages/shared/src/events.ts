import { z } from "zod";
import { AgentStateSchema } from "./state.js";
import { RiskLevelSchema } from "./tools.js";
import {
  VoiceInterruptRequestSchema,
  VoiceInterruptAckSchema,
} from "./voice-protocol.js";

const VoiceAudioSegmentSchemaLocal = z.object({
  type: z.literal("voice.audio.segment"),
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
  generationId: z.string(),
  /** Índice de la frase dentro de la locución. */
  index: z.number().int().nonnegative(),
  /** Texto de la frase (lo que se ha sintetizado). */
  text: z.string(),
  /** Audio WAV PCM 16 bits mono, en base64. */
  audio: z.string(),
  mimeType: z.string(),
  sampleRate: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  /** Época del servidor para validación de frescura */
  serverEpoch: z.number().int().nonnegative(),
});

const VoiceOutputStoppedSchemaLocal = z.object({
  type: z.literal("voice.output_stopped"),
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
  generationId: z.string(),
  reason: z.enum(["completed", "interrupted"]).default("completed"),
  /** Época del servidor al momento de la parada */
  serverEpoch: z.number().int().nonnegative(),
});

const envelope = {
  sessionId: z.string(),
  taskId: z.string().optional(),
  ts: z.string(),
};

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created"), ...envelope, userId: z.string() }),
  z.object({
    type: z.literal("assistant.state_changed"),
    ...envelope,
    state: AgentStateSchema,
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("assistant.delta"), ...envelope, text: z.string() }),
  z.object({
    type: z.literal("assistant.reasoning"),
    ...envelope,
    /** Razonamiento que el modelo ha hecho público para este turno. */
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant.message_completed"),
    ...envelope,
    text: z.string(),
    usage: z
      .object({
        promptTokens: z.number().optional(),
        completionTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("tool.started"),
    ...envelope,
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
    risk: RiskLevelSchema,
  }),
  z.object({
    type: z.literal("tool.awaiting_approval"),
    ...envelope,
    toolCallId: z.string(),
    name: z.string(),
    arguments: z.unknown(),
    risk: RiskLevelSchema,
    approvalId: z.string(),
    description: z.string(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    ...envelope,
    toolCallId: z.string(),
    name: z.string(),
    summary: z.string(),
    data: z.unknown().optional(),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal("tool.failed"),
    ...envelope,
    toolCallId: z.string(),
    name: z.string(),
    error: z.string(),
    unavailable: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("voice.input_started"),
    ...envelope,
  }),
  z.object({
    type: z.literal("voice.transcript"),
    ...envelope,
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({ type: z.literal("voice.output_started"), ...envelope, generationId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("voice.asr.result"),
    ...envelope,
    text: z.string(),
    /** El ASR del servidor está activo: el cliente no usa el del navegador. */
    serverAsr: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("voice.audio.segment"),
    ...envelope,
    generationId: z.string(),
    /** Índice de la frase dentro de la locución. */
    index: z.number().int().nonnegative(),
    /** Texto de la frase (lo que se ha sintetizado). */
    text: z.string(),
    /** Audio WAV PCM 16 bits mono, en base64. */
    audio: z.string(),
    mimeType: z.string(),
    sampleRate: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("voice.audio.end"),
    ...envelope,
    generationId: z.string(),
  }),
  z.object({
    type: z.literal("voice.output_stopped"),
    ...envelope,
    generationId: z.string(),
    reason: z.enum(["completed", "interrupted"]).default("completed"),
    /** Época del servidor al momento de la parada */
    serverEpoch: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal("voice.speaking.started"),
    sessionId: z.string(),
    taskId: z.string().optional(),
    ts: z.string(),
    generationId: z.string(),
    /** Texto que se va a sintetizar (para registro y respaldo TTS). */
    text: z.string(),
    /** El servidor aporta el audio: el cliente no usa la voz del navegador. */
    serverAudio: z.boolean(),  // required to ensure inference
    /** Época inicial del servidor para esta locución */
    serverEpoch: z.number().int().nonnegative(),
  }),
  VoiceInterruptAckSchema.extend({ ...envelope }),
  z.object({
    type: z.literal("voice.asr.partial"),
    ...envelope,
    text: z.string(),
  }),
  z.object({
    type: z.literal("perception.image_received"),
    ...envelope,
    width: z.number(),
    height: z.number(),
    bytes: z.number(),
    cameraActive: z.boolean(),
  }),
  z.object({
    type: z.literal("perception.camera_state"),
    ...envelope,
    cameraActive: z.boolean(),
  }),
  z.object({
    type: z.literal("system.health_changed"),
    ...envelope,
    component: z.string(),
    status: z.enum(["up", "degraded", "down", "unknown"]),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("pong"),
    ...envelope,
    /** Momento del servidor: el cliente lo usa para medir el RTT real. */
    serverTime: z.string(),
  }),
  z.object({ type: z.literal("task.cancelled"), ...envelope }),
  z.object({
    type: z.literal("agent.error"),
    ...envelope,
    message: z.string(),
    recoverable: z.boolean().default(true),
  }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.send"), sessionId: z.string(), text: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("chat.cancel"), sessionId: z.string(), taskId: z.string().optional() }),
  z.object({ type: z.literal("approval.respond"), sessionId: z.string(), approvalId: z.string(), approve: z.boolean() }),
  z.object({ type: z.literal("voice.transcript"), sessionId: z.string(), text: z.string(), final: z.boolean() }),
  z.object({
    type: z.literal("voice.audio.chunk"),
    sessionId: z.string(),
    /** PCM 16 bits mono a 16 kHz, en base64. */
    pcm: z.string(),
  }),
  z.object({
    type: z.literal("voice.audio.flush"),
    sessionId: z.string(),
  }),
  // Streaming ASR (P3) - Nuevos comandos para pipeline streaming
  z.object({
    type: z.literal("voice.audio.stream.start"),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("voice.audio.stream.chunk"),
    sessionId: z.string(),
    /** PCM 16 bits mono a 16 kHz, en base64. */
    pcm: z.string(),
  }),
  z.object({
    type: z.literal("voice.audio.stream.end"),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal("perception.image"),
    sessionId: z.string(),
    dataUrl: z.string().max(12_000_000),
    prompt: z.string().max(2000).optional(),
    cameraActive: z.boolean(),
  }),
  z.object({ type: z.literal("session.describe"), sessionId: z.string() }),
  z.object({ type: z.literal("ping") }),
  VoiceInterruptRequestSchema,
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;
