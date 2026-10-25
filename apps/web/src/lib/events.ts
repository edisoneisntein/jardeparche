import { z } from "zod";
import {
  AGENT_STATES,
  COMPONENT_STATUS,
  RISK_LEVELS,
  ClientCommandSchema,
  ServerEventSchema,
} from "@jarvis/shared";

/**
 * Contrato del cliente.
 *
 * Antes el cliente mantenía una COPIA manual de la unión de eventos del
 * servidor: cualquier campo nuevo (epoch, reason, pong…) podía divergir en
 * silencio. Ahora los tipos se derivan del esquema zod de `@jarvis/shared`,
 * que es la única fuente de verdad, y el cliente valida con el mismo esquema
 * que usa el servidor.
 */

export const AGENT_STATES_LIST = AGENT_STATES;
export const RISK_LEVELS_LIST = RISK_LEVELS;
export const COMPONENT_STATUSES = COMPONENT_STATUS;

export type AgentState = (typeof AGENT_STATES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ComponentStatus = (typeof COMPONENT_STATUS)[number];

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent["type"];
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  detail?: string;
  checkedAt: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: ComponentStatus;
  components: ComponentHealth[];
  checkedAt: string;
}

export interface ModelCapabilities {
  model: string;
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  embeddings: boolean;
  source: string;
  checkedAt: string;
  notes?: string;
}

export interface ToolCapability {
  name: string;
  title: string;
  description: string;
  risk: RiskLevel;
  requiresApproval: boolean;
  available: boolean;
  reason?: string;
}

export interface VoiceProviderInfo {
  stt: string;
  tts: string;
  browserSupported: boolean;
  notes: string;
}

export interface CapabilitiesResponse {
  provider: string;
  models: {
    chat: string;
    vision: string;
    embedding: string;
  };
  capabilities: ModelCapabilities;
  tools: ToolCapability[];
  /** Proveedores de voz publicados por el servidor. */
  voice: VoiceProviderInfo;
}

export interface SessionRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  userId: string;
  kind: string;
  role: "system" | "user" | "assistant" | "tool" | string;
  text: string;
  createdAt: string;
  toolCallId?: string;
  name?: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  sessionId: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
}

export interface MemoryFact {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
}

export interface MemoryEpisode {
  id: string;
  userId: string;
  summary: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  createdAt: string;
}

export interface PerceptionAnalyzeResponse {
  text: string;
}

/** Identificador de sesión de un evento, si lo lleva (los globales no). */
export function eventSessionId(event: ServerEvent): string | undefined {
  return "sessionId" in event && typeof event.sessionId === "string" ? event.sessionId : undefined;
}

export function eventDedupeKey(event: ServerEvent): string {
  const taskId = "taskId" in event ? event.taskId ?? "" : "";
  const toolCallId = "toolCallId" in event ? event.toolCallId ?? "" : "";
  return `${event.type}|${taskId}|${toolCallId}|${event.ts}`;
}

/**
 * Valida con el MISMO esquema zod que el servidor: un evento desconocido o
 * malformado se descarta en el borde, no llega al store.
 */
export function isServerEvent(value: unknown): value is ServerEvent {
  return ServerEventSchema.safeParse(value).success;
}

export function isRiskLevel(value: string): value is RiskLevel {
  return (RISK_LEVELS as readonly string[]).includes(value);
}
