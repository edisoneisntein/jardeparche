import type { ModelCapabilities, TokenUsage } from "@jarvis/shared";
import { classifyHttp, ProviderError } from "./errors.js";
import type { NvidiaConfig } from "./config.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, ProviderToolCall, StreamChunk } from "./types.js";

interface RawToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface RawChoiceMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: RawToolCall[] | null;
}

interface RawCompletion {
  model?: string;
  choices?: Array<{ message?: RawChoiceMessage; delta?: RawChoiceMessage; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * NVIDIA NIM adapter. Wraps the OpenAI-compatible chat completions API with
 * explicit timeout, bounded retry, cancellation and capability detection.
 */
export class NvidiaNimProvider implements AiProvider {
  readonly name = "nvidia-nim";
  private readonly config: NvidiaConfig;

  constructor(config: NvidiaConfig) {
    this.config = config;
  }

  get models() {
    return {
      chat: this.config.model,
      vision: this.config.visionModel,
      embedding: this.config.embeddingModel,
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** Never swallow the caller's abort: it must win over the internal timeout. */
  private linkSignal(external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ProviderError("timeout", `NVIDIA NIM request exceeded ${this.config.timeoutMs} ms.`)), this.config.timeoutMs);
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
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
    }
    if (request.responseFormat === "json") body.response_format = { type: "json_object" };
    if (request.disableThinking) body.chat_template_kwargs = { enable_thinking: false };
    return body;
  }

  private mapProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const err = error as Error & { name?: string };
    if (err?.name === "AbortError") return new ProviderError("aborted", "Request aborted.", { retryable: false });
    return new ProviderError("network", `Cannot reach NVIDIA NIM: ${err?.message ?? "unknown error"}`);
  }

  private usageOf(raw: RawCompletion): TokenUsage | undefined {
    if (!raw.usage) return undefined;
    return {
      promptTokens: raw.usage.prompt_tokens,
      completionTokens: raw.usage.completion_tokens,
      totalTokens: raw.usage.total_tokens,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      return await this.withRetry("chat", async () => {
        const { signal, cleanup } = this.linkSignal(request.signal);
        try {
          const response = await fetch(this.url("/chat/completions"), {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(this.buildBody(request, false)),
            signal,
          });
          const text = await response.text();
          if (!response.ok) throw classifyHttp(response.status, text);
          const raw = JSON.parse(text) as RawCompletion;
          const message = raw.choices?.[0]?.message ?? {};
          return {
            model: raw.model ?? (request.model ?? this.config.model),
            content: message.content ?? "",
            toolCalls: normalizeToolCalls(message.tool_calls),
            finishReason: raw.choices?.[0]?.finish_reason ?? null,
            usage: this.usageOf(raw),
            totalLatencyMs: Date.now() - started,
            streamed: false,
          };
        } catch (error) {
          throw this.mapProviderError(error);
        } finally {
          cleanup();
        }
      });
    } catch (error) {
      throw this.mapProviderError(error);
    }
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const started = Date.now();
    try {
      return await this.withRetry("stream", async () => {
        const { signal, cleanup } = this.linkSignal(request.signal);
        let received = false;
        try {
          const response = await fetch(this.url("/chat/completions"), {
            method: "POST",
            headers: { ...this.headers(), Accept: "text/event-stream" },
            body: JSON.stringify(this.buildBody(request, true)),
            signal,
          });
          if (!response.ok) {
            const text = await response.text();
            throw classifyHttp(response.status, text);
          }
          if (!response.body) throw new ProviderError("unavailable", "NVIDIA NIM returned an empty stream.", { retryable: true });

          let content = "";
          let reasoning = "";
          let model = request.model ?? this.config.model;
          let finishReason: string | null = null;
          let usage: TokenUsage | undefined;
          let firstTokenLatencyMs: number | undefined;
          const toolAccumulator = new Map<number, ProviderToolCall>();

          for await (const event of parseSse(response.body)) {
            if (event === "[DONE]") break;
            let raw: RawCompletion;
            try {
              raw = JSON.parse(event) as RawCompletion;
            } catch {
              continue;
            }
            if (raw.model) model = raw.model;
            const delta = raw.choices?.[0]?.delta;
            if (delta?.content) {
              if (!received) {
                received = true;
                firstTokenLatencyMs = Date.now() - started;
              }
              content += delta.content;
              onChunk({ type: "delta", text: delta.content });
            }
            if (delta?.reasoning_content) {
              received = true;
              reasoning += delta.reasoning_content;
              onChunk({ type: "reasoning", text: delta.reasoning_content });
            }
            if (delta?.tool_calls?.length) {
              received = true;
              accumulateToolCalls(toolAccumulator, delta.tool_calls);
            }
            const choice = raw.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (raw.usage) {
              const reported = this.usageOf(raw);
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
            reasoning: reasoning || undefined,
            toolCalls,
            finishReason,
            usage,
            firstTokenLatencyMs,
            totalLatencyMs: Date.now() - started,
            streamed: true,
          };
        } catch (error) {
          const mapped = this.mapProviderError(error);
          if (received) mapped.retryable = false;
          throw mapped;
        } finally {
          cleanup();
        }
      });
    } catch (error) {
      throw this.mapProviderError(error);
    }
  }

  async embed(texts: string[], inputType: "query" | "passage" = "passage"): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: this.config.embeddingModel, dimensions: 0 };
    return this.withRetry("embed", async () => {
      const { signal, cleanup } = this.linkSignal();
      try {
        const response = await fetch(this.url("/embeddings"), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ model: this.config.embeddingModel, input: texts, input_type: inputType }),
          signal,
        });
        const text = await response.text();
        if (!response.ok) throw classifyHttp(response.status, text);
        const raw = JSON.parse(text) as { model?: string; data?: Array<{ embedding: number[] }> };
        const vectors = (raw.data ?? []).map((d) => d.embedding);
        return { vectors, model: raw.model ?? this.config.embeddingModel, dimensions: vectors[0]?.length ?? 0 };
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
          const text = await response.text();
          const error = classifyHttp(response.status, text);
          return { ok: false, detail: `${error.kind}: ${error.message}`, latencyMs };
        }
        return { ok: true, detail: "NVIDIA NIM reachable", latencyMs };
      } finally {
        cleanup();
      }
    } catch (error) {
      const mapped = this.mapProviderError(error);
      return { ok: false, detail: `${mapped.kind}: ${mapped.message}`, latencyMs: Date.now() - started };
    }
  }

  async capabilities(): Promise<ModelCapabilities> {
    return {
      model: this.config.model,
      chat: true,
      streaming: this.config.streaming !== "disabled",
      tools: true,
      vision: false,
      embeddings: true,
      source: "config",
      checkedAt: new Date().toISOString(),
      notes: `vision model: ${this.config.visionModel}; capabilities are declared by configuration, run \`pnpm --filter @jarvis/ai-provider probe\` to verify against the live account.`,
    };
  }

  /**
   * Actively verifies capabilities against the live account. Costs a few tokens
   * but never claims a capability that has not been observed.
   */
  async probeCapabilities(): Promise<ModelCapabilities> {
    const checkedAt = new Date().toISOString();
    const notes: string[] = [];
    let streaming = false;
    let tools = false;

    try {
      const streamed = await this.stream(
        { messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 256, temperature: 0 },
        () => {},
      );
      streaming = streamed.content.trim().length > 0 || streamed.toolCalls.length > 0;
      if (!streaming) notes.push("streaming produced no content");
    } catch (error) {
      notes.push(`streaming probe failed: ${(error as Error).message}`);
    }

    try {
      const tooled = await this.chat({
        messages: [{ role: "user", content: "Call the tool `__jarvis_probe` with no arguments." }],
        tools: [
          {
            type: "function",
            function: { name: "__jarvis_probe", description: "Capability probe. Call it.", parameters: { type: "object", properties: {} } },
          },
        ],
        toolChoice: "auto",
        maxTokens: 512,
        temperature: 0,
      });
      tools = tooled.toolCalls.some((call) => call.name === "__jarvis_probe");
      if (!tools) notes.push("tools probe returned no tool call");
    } catch (error) {
      notes.push(`tools probe failed: ${(error as Error).message}`);
    }

    return {
      model: this.config.model,
      chat: true,
      streaming,
      tools,
      vision: false,
      embeddings: true,
      source: "probe",
      checkedAt,
      notes: notes.join("; ") || "all probes passed",
    };
  }
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
