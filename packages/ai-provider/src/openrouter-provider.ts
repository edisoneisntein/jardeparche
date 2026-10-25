import { z } from "zod";
import type { ModelCapabilities, TokenUsage } from "@jarvis/shared";
import { ProviderError } from "./errors.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, ProviderTool, ProviderToolCall, StreamChunk } from "./types.js";

/**
 * Adaptador de OpenRouter.
 *
 * OpenRouter expone una API compatible con OpenAI y, a diferencia de NIM,
 * publica en `/models` las capacidades REALES de cada modelo
 * (`supported_parameters`, `architecture.input_modalities`). Esas capacidades
 * se leen del servicio: no se declaran desde la configuración.
 *
 * Particularidades del protocolo que se respetan aquí:
 *  · El razonamiento puede llegar como `reasoning` (estilo OpenRouter) o como
 *    `reasoning_content` (estilo MiniMax/DeepSeek). Ambos se normalizan al
 *    chunk `reasoning`.
 *  · Los modelos con razonamiento aceptan `reasoning_effort` para ajustar la
 *    profundidad del thinking (en los modelos que lo ignoran, es inocuo).
 *  · `max_tokens` cuenta los tokens de razonamiento: con un techo bajo, el
 *    modelo termina con `finish_reason: "length"` y `content` vacío. Por eso
 *    el mínimo por defecto es holgado.
 */

export const OpenRouterConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
  model: z.string().min(1),
  /** Profundidad del razonamiento: low | medium | high | xhigh | max. */
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
  maxTokens: z.coerce.number().int().positive().default(4096),
  temperature: z.coerce.number().min(0).max(2).optional(),
  maxRetries: z.coerce.number().int().min(0).max(3).default(1),
  /** Etiqueta enviada en X-Title para atribuir el tráfico en el panel de OpenRouter. */
  appTitle: z.string().default("JARVIS"),
  appUrl: z.string().default("http://localhost:8787"),
});

export type OpenRouterConfig = z.infer<typeof OpenRouterConfigSchema>;

export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_REASONING_EFFORT?: string;
  OPENROUTER_TIMEOUT_MS?: string;
  OPENROUTER_MAX_TOKENS?: string;
  OPENROUTER_TEMPERATURE?: string;
  OPENROUTER_MAX_RETRIES?: string;
}

/** Devuelve `null` si OpenRouter no está configurado: no es un error. */
export function loadOpenRouterConfig(env: OpenRouterEnv = process.env as OpenRouterEnv): OpenRouterConfig | null {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const effort = env.OPENROUTER_REASONING_EFFORT?.trim();
  return OpenRouterConfigSchema.parse({
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL ?? "minimax/minimax-m3.1-flash",
    reasoningEffort:
      effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" ? effort : undefined,
    timeoutMs: env.OPENROUTER_TIMEOUT_MS,
    maxTokens: env.OPENROUTER_MAX_TOKENS,
    temperature: env.OPENROUTER_TEMPERATURE,
    maxRetries: env.OPENROUTER_MAX_RETRIES,
  });
}

interface OpenRouterModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
}

export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter";
  private readonly config: OpenRouterConfig;
  private modelCatalog: { at: number; models: OpenRouterModelEntry[] } | null = null;

  constructor(config: OpenRouterConfig) {
    this.config = config;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "HTTP-Referer": this.config.appUrl,
      "X-Title": this.config.appTitle,
    };
  }

  /** Igual que en NIM: el abort externo gana siempre al timeout interno. */
  private linkSignal(external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ProviderError("timeout", `OpenRouter exceeded the ${this.config.timeoutMs} ms budget.`)),
      this.config.timeoutMs,
    );
    const onAbort = () => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
      },
    };
  }

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const providerError = error instanceof ProviderError ? error : new ProviderError("network", `${label} failed: ${(error as Error).message}`);
        if (!providerError.retryable || attempt === this.config.maxRetries) throw providerError;
        const backoff = Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw lastError;
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (stream) body.stream_options = { include_usage: true };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
    }
    if (request.responseFormat === "json") body.response_format = { type: "json_object" };
    if (request.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    return body;
  }

  private mapProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const err = error as Error & { name?: string };
    if (err?.name === "AbortError") return new ProviderError("aborted", "Request aborted.", { retryable: false });
    return new ProviderError("network", `Cannot reach OpenRouter: ${err?.message ?? "unknown error"}`);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    return this.withRetry("chat", async () => {
      const { signal, cleanup } = this.linkSignal(request.signal);
      try {
        const response = await fetch(this.url("/chat/completions"), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(this.buildBody(request, false)),
          signal,
        });
        if (!response.ok) throw classifyOpenRouterHttp(response.status, await response.text());
        const raw = (await response.json()) as OpenRouterResponse;
        const message = raw.choices?.[0]?.message ?? {};
        return {
          model: raw.model ?? (request.model ?? this.config.model),
          content: message.content ?? "",
          toolCalls: normalizeToolCalls(message.tool_calls),
          finishReason: raw.choices?.[0]?.finish_reason ?? null,
          usage: usageOf(raw.usage),
          totalLatencyMs: Date.now() - started,
          streamed: false,
        };
      } catch (error) {
        throw this.mapProviderError(error);
      } finally {
        cleanup();
      }
    });
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const started = Date.now();
    return this.withRetry("stream", async () => {
      const { signal, cleanup } = this.linkSignal(request.signal);
      let received = false;
      try {
        const response = await fetch(this.url("/chat/completions"), {
          method: "POST",
          headers: { ...this.headers(), Accept: "text/event-stream" },
          body: JSON.stringify(this.buildBody(request, true)),
          signal,
        });
        if (!response.ok) throw classifyOpenRouterHttp(response.status, await response.text());
        if (!response.body) throw new ProviderError("unavailable", "OpenRouter returned an empty stream.", { retryable: true });

        let content = "";
        let reasoningText = "";
        let model = request.model ?? this.config.model;
        let finishReason: string | null = null;
        let usage: TokenUsage | undefined;
        let firstTokenLatencyMs: number | undefined;
        const toolAccumulator = new Map<number, ProviderToolCall>();

        for await (const event of parseSse(response.body)) {
          if (event === "[DONE]") break;
          let raw: OpenRouterResponse;
          try {
            raw = JSON.parse(event) as OpenRouterResponse;
          } catch {
            continue;
          }
          if (raw.model) model = raw.model;
          const delta = raw.choices?.[0]?.delta;
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (reasoning) {
            received = true;
            reasoningText += String(reasoning);
            onChunk({ type: "reasoning", text: String(reasoning) });
          }
          if (delta?.content) {
            received = true;
            if (firstTokenLatencyMs === undefined) firstTokenLatencyMs = Date.now() - started;
            content += delta.content;
            onChunk({ type: "delta", text: delta.content });
          }
          if (delta?.tool_calls?.length) {
            received = true;
            accumulateToolCalls(toolAccumulator, delta.tool_calls);
          }
          const choice = raw.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (raw.usage) {
            const reported = usageOf(raw.usage);
            if (reported) {
              usage = reported;
              onChunk({ type: "usage", usage: reported, model });
            }
          }
        }

        const toolCalls = [...toolAccumulator.values()];
        if (toolCalls.length) onChunk({ type: "tool_calls", toolCalls });
        onChunk({ type: "done", finishReason });
        return {
          model,
          content,
          reasoning: reasoningText || undefined,
          toolCalls,
          finishReason,
          usage,
          firstTokenLatencyMs,
          totalLatencyMs: Date.now() - started,
          streamed: true,
        };
      } catch (error) {
        const mapped = this.mapProviderError(error);
        // Si ya salió contenido no se reintenta: repetirlo duplicaría la respuesta.
        if (received) mapped.retryable = false;
        throw mapped;
      } finally {
        cleanup();
      }
    });
  }

  async embed(texts: string[], inputType: "query" | "passage" = "passage"): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: this.config.model, dimensions: 0 };
    return this.withRetry("embed", async () => {
      const { signal, cleanup } = this.linkSignal();
      try {
        const response = await fetch(this.url("/embeddings"), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ model: this.config.model, input: texts, input_type: inputType }),
          signal,
        });
        if (!response.ok) {
          const text = await response.text();
          const error = classifyOpenRouterHttp(response.status, text);
          // La mayoría de modelos de chat de OpenRouter no exponen embeddings:
          // se informa con claridad para que la memoria degrade a búsqueda léxica.
          if (error.status === 404 || error.status === 400) {
            throw new ProviderError("unavailable", `OpenRouter no ofrece embeddings para ${this.config.model}.`, {
              status: error.status,
              detail: error.detail,
              retryable: false,
            });
          }
          throw error;
        }
        const raw = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
        const vectors = (raw.data ?? []).map((entry) => entry.embedding ?? []);
        return { vectors, model: this.config.model, dimensions: vectors[0]?.length ?? 0 };
      } catch (error) {
        throw this.mapProviderError(error);
      } finally {
        cleanup();
      }
    });
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const { signal, cleanup } = this.linkSignal();
      try {
        const response = await fetch(this.url("/models"), { headers: this.headers(), signal });
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          const error = classifyOpenRouterHttp(response.status, await response.text());
          return { ok: false, detail: `${error.kind}: ${error.message}`, latencyMs };
        }
        const raw = (await response.json()) as { data?: OpenRouterModelEntry[] };
        const models = raw.data ?? [];
        const present = models.some((model) => model.id === this.config.model);
        return {
          ok: present,
          detail: present
            ? `OpenRouter reachable · modelo ${this.config.model} disponible`
            : `OpenRouter reachable pero el modelo ${this.config.model} no figura en el catálogo`,
          latencyMs,
        };
      } finally {
        cleanup();
      }
    } catch (error) {
      return { ok: false, detail: `OpenRouter inaccesible: ${(error as Error).message}`, latencyMs: Date.now() - started };
    }
  }

  /**
   * Capacidades leídas del catálogo real de OpenRouter (no declaradas).
   * `supported_parameters` y `architecture.input_modalities` los publica el
   * servicio para cada modelo.
   */
  async capabilities(): Promise<ModelCapabilities> {
    const checkedAt = new Date().toISOString();
    const catalog = await this.modelCatalogEntries();
    const entry = catalog.find((model) => model.id === this.config.model);
    if (!entry) {
      return {
        model: this.config.model,
        chat: false,
        streaming: false,
        tools: false,
        vision: false,
        embeddings: false,
        source: "probe",
        checkedAt,
        notes: `El modelo ${this.config.model} no figura en el catálogo de OpenRouter (${catalog.length} modelos).`,
      };
    }
    const parameters = entry.supported_parameters ?? [];
    const inputs = entry.architecture?.input_modalities ?? [];
    return {
      model: this.config.model,
      chat: true,
      streaming: parameters.includes("stream"),
      tools: parameters.includes("tools") || parameters.includes("tool_choice"),
      vision: inputs.includes("image") || inputs.includes("video"),
      embeddings: false,
      source: "probe",
      checkedAt,
      notes: `leído del catálogo de OpenRouter · ${parameters.length} parámetros soportados · entradas: ${inputs.join(", ") || "text"}`,
    };
  }

  /** Catálogo con caché corta: las capacidades cambian poco. */
  private async modelCatalogEntries(): Promise<OpenRouterModelEntry[]> {
    const now = Date.now();
    if (this.modelCatalog && now - this.modelCatalog.at < 5 * 60_000) return this.modelCatalog.models;
    const { signal, cleanup } = this.linkSignal();
    try {
      const response = await fetch(this.url("/models"), { headers: this.headers(), signal });
      if (!response.ok) throw classifyOpenRouterHttp(response.status, await response.text());
      const raw = (await response.json()) as { data?: OpenRouterModelEntry[] };
      const models = raw.data ?? [];
      this.modelCatalog = { at: now, models };
      return models;
    } finally {
      cleanup();
    }
  }
}

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: RawToolCall[] | null; reasoning?: string | null; reasoning_content?: string | null };
    delta?: { content?: string | null; tool_calls?: RawToolCall[] | null; reasoning?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface RawToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

export function classifyOpenRouterHttp(status: number, body: string): ProviderError {
  const detail = body.slice(0, 500);
  if (status === 401 || status === 403) return new ProviderError("auth", "OpenRouter rejected the credentials.", { status, detail });
  if (status === 404) return new ProviderError("unavailable", "The requested model or endpoint is not available on OpenRouter.", { status, detail, retryable: false });
  if (status === 402) return new ProviderError("unavailable", "OpenRouter reports insufficient credit for this request.", { status, detail, retryable: false });
  if (status === 408) return new ProviderError("timeout", "OpenRouter timed out the request.", { status, detail });
  if (status === 429) return new ProviderError("rate_limit", "OpenRouter rate limit reached.", { status, detail });
  if (status >= 500) return new ProviderError("unavailable", `OpenRouter returned ${status}.`, { status, detail, retryable: true });
  if (status === 400 || status === 422) return new ProviderError("invalid_request", `OpenRouter rejected the request (${status}).`, { status, detail });
  return new ProviderError("unknown", `Unexpected OpenRouter status ${status}.`, { status, detail });
}

function usageOf(usage: OpenRouterResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

function normalizeToolCalls(calls: RawToolCall[] | null | undefined): ProviderToolCall[] {
  if (!calls?.length) return [];
  return calls.map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    arguments: call.function?.arguments ?? "{}",
  }));
}

function accumulateToolCalls(acc: Map<number, ProviderToolCall>, deltas: RawToolCall[]): void {
  for (const [position, delta] of deltas.entries()) {
    const index = delta.index ?? position;
    const current = acc.get(index) ?? { id: delta.id ?? `call_${index}`, name: "", arguments: "" };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name = delta.function.name;
    if (delta.function?.arguments) current.arguments += delta.function.arguments;
    acc.set(index, current);
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        yield trimmed.slice(5).trim();
      }
    }
    if (buffer.trim().startsWith("data:")) yield buffer.trim().slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
