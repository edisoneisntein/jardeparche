import type { ModelCapabilities, TokenUsage } from "@jarvis/shared";
import { ProviderError } from "./errors.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, ProviderToolCall, StreamChunk } from "./types.js";

export interface FakeProviderScriptStep {
  content?: string;
  /** Razonamiento emitido por el modelo (se publica como `assistant.reasoning`). */
  reasoning?: string;
  toolCalls?: ProviderToolCall[];
  usage?: TokenUsage;
  /** Simulates a failure at this step. */
  error?: { kind: "network" | "rate_limit" | "timeout" | "auth" | "aborted"; message?: string };
  /** Simulated latency per step in ms. */
  delayMs?: number;
}

/**
 * Deterministic in-process provider used by unit tests and by `pnpm dev`
 * when no NVIDIA key is present (the UI then reports the brain as offline).
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake";
  private steps: FakeProviderScriptStep[];
  private cursor = 0;
  public readonly calls: ChatRequest[] = [];
  public readonly streams: ChatRequest[] = [];

  constructor(steps: FakeProviderScriptStep[] = [{ content: "OK" }]) {
    this.steps = steps;
  }

  setScript(steps: FakeProviderScriptStep[]): void {
    this.steps = steps;
    this.cursor = 0;
  }

  queue(step: FakeProviderScriptStep): void {
    this.steps.push(step);
  }

  private next(): FakeProviderScriptStep {
    const step = this.steps[this.cursor] ?? { content: "OK" };
    this.cursor += 1;
    return step;
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    if (signal.aborted) return Promise.reject(new ProviderError("aborted", "aborted"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ProviderError("aborted", "aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async materialize(step: FakeProviderScriptStep, started: number, signal?: AbortSignal): Promise<ChatResponse> {
    if (step.delayMs) await this.delay(step.delayMs, signal);
    if (step.error) {
      const err = new ProviderError(step.error.kind, step.error.message ?? `simulated ${step.error.kind}`, {
        retryable: step.error.kind === "network" || step.error.kind === "rate_limit" || step.error.kind === "timeout",
      });
      throw err;
    }
    return {
      model: "fake-model",
      content: step.content ?? "",
      reasoning: step.reasoning,
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? "tool_calls" : "stop",
      usage: step.usage,
      totalLatencyMs: Date.now() - started,
      streamed: false,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    return this.materialize(this.next(), Date.now(), request.signal);
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    this.streams.push(request);
    const started = Date.now();
    const step = this.next();
    if (step.delayMs) await this.delay(step.delayMs, request.signal);
    if (step.error) {
      const err = new ProviderError(step.error.kind, step.error.message ?? `simulated ${step.error.kind}`, {
        retryable: step.error.kind === "network" || step.error.kind === "rate_limit" || step.error.kind === "timeout",
      });
      throw err;
    }
    let content = "";
    let reasoning = "";
    if (step.reasoning) {
      reasoning = step.reasoning;
      onChunk({ type: "reasoning", text: step.reasoning });
    }
    for (const token of tokenize(step.content ?? "")) {
      if (request.signal?.aborted) throw new ProviderError("aborted", "aborted");
      content += token;
      onChunk({ type: "delta", text: token });
    }
    if (step.toolCalls?.length) onChunk({ type: "tool_calls", toolCalls: step.toolCalls });
    if (step.usage) onChunk({ type: "usage", usage: step.usage, model: "fake-model" });
    onChunk({ type: "done", finishReason: step.toolCalls?.length ? "tool_calls" : "stop" });
    return {
      model: "fake-model",
      content,
      reasoning: reasoning || undefined,
      toolCalls: step.toolCalls ?? [],
      finishReason: step.toolCalls?.length ? "tool_calls" : "stop",
      usage: step.usage,
      firstTokenLatencyMs: 0,
      totalLatencyMs: Date.now() - started,
      streamed: true,
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((text) => deterministicVector(text));
    return { vectors, model: "fake-embed", dimensions: vectors[0]?.length ?? 0 };
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    return { ok: true, detail: "fake provider", latencyMs: 0 };
  }

  async capabilities(): Promise<ModelCapabilities> {
    return {
      model: "fake-model",
      chat: true,
      streaming: true,
      tools: true,
      vision: false,
      embeddings: true,
      source: "config",
      checkedAt: new Date().toISOString(),
    };
  }
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text.match(/\s*\S+/g) ?? [text];
}

/** Stable hashed embedding so semantic search logic is testable without network. */
function deterministicVector(text: string, dimensions = 32): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dimensions;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
