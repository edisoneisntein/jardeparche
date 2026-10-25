import type { ChatMessage, ModelCapabilities, TokenUsage } from "@jarvis/shared";

export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  tools?: ProviderTool[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Override config streaming behavior for this request. */
  stream?: boolean;
  /** Request embedding-ready structured output. */
  responseFormat?: "text" | "json";
  /**
   * Desactiva el razonamiento del modelo (equivale a
   * `chat_template_kwargs.enable_thinking = false` en la API de NIM).
   *
   * Medido en nemotron-3.5-lightning-30b-a3b: el primer token baja de
   * 1 136 ms a 199 ms y el turno completo de 1 681 ms a 606 ms, y la
   * herramienta SIGUE siendo llamada correctamente. Es la palanca de
   * latencia de la vía de voz.
   */
  disableThinking?: boolean;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as returned by the model. */
  arguments: string;
}

export interface ChatResponse {
  model: string;
  content: string;
  /**
   * Razonamiento emitido por el modelo (campo `reasoning_content` /
   * `reasoning` de la API). El runtime lo publica para que el usuario vea
   * cómo ha llegado a la respuesta.
   */
  reasoning?: string;
  toolCalls: ProviderToolCall[];
  finishReason: string | null;
  usage?: TokenUsage;
  firstTokenLatencyMs?: number;
  totalLatencyMs: number;
  /** True when the reply came from a streamed request. */
  streamed: boolean;
}

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_calls"; toolCalls: ProviderToolCall[] }
  | { type: "usage"; usage: TokenUsage; model: string }
  | { type: "done"; finishReason: string | null };

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}

export interface AiProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse>;
  embed(texts: string[], inputType?: "query" | "passage"): Promise<EmbedResult>;
  health(): Promise<{ ok: boolean; detail: string; latencyMs: number }>;
  capabilities(): Promise<ModelCapabilities>;
}
