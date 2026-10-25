import { z } from "zod";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, ModelCapabilities, ProviderToolCall, StreamChunk, TokenUsage } from "./types.js";
import { ProviderError } from "./errors.js";

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  visionModel?: string;
  embeddingModel?: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  maxRetries: number;
}

const GEMINI_CONFIG_SCHEMA = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  model: z.string().min(1),
  visionModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
  maxTokens: z.coerce.number().int().positive().default(8192),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  maxRetries: z.coerce.number().int().min(0).max(3).default(1),
});

export type GeminiConfig = z.infer<typeof GEMINI_CONFIG_SCHEMA>;

export function loadGeminiConfig(env: Record<string, string | undefined> = process.env): GeminiConfig {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
  return GEMINI_CONFIG_SCHEMA.parse({
    apiKey,
    baseUrl: env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    model: env.GEMINI_MODEL ?? "gemini-2.0-flash-exp",
    visionModel: env.GEMINI_VISION_MODEL ?? "gemini-2.0-flash-exp",
    embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004",
    timeoutMs: Number(env.GEMINI_TIMEOUT_MS) || 60_000,
    maxTokens: Number(env.GEMINI_MAX_TOKENS) || 8192,
    temperature: Number(env.GEMINI_TEMPERATURE) ?? 0.2,
    maxRetries: Number(env.GEMINI_MAX_RETRIES) || 1,
  });
}

interface RawCandidate {
  content?: { parts: Array<{ text?: string; function_call?: { name: string; args: Record<string, unknown> } }> };
  finish_reason?: string;
}

interface RawResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finish_reason?: string }>;
  usage_metadata?: { prompt_token_count?: number; candidates_token_count?: number; total_token_count?: number };
}

export class GeminiProvider {
  readonly name = "gemini";
  private readonly config: { apiKey: string; baseUrl: string; model: string; visionModel?: string; embeddingModel?: string; timeoutMs: number; maxTokens: number; temperature: number; maxRetries: number };

  constructor(config: { apiKey: string; baseUrl: string; model: string; visionModel?: string; embeddingModel?: string; timeoutMs: number; maxTokens: number; temperature: number; maxRetries: number }) {
    this.config = config;
  }

  get models() {
    return { chat: this.config.model, vision: this.config.visionModel ?? this.config.model, embedding: "text-embedding-004" };
  }

  private url(path: string): string { return `${this.config.baseUrl.replace(/\/$/, "")}${path}`; }
  private headers(): Record<string, string> { return { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" }; }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { return await fn(); }
      catch (error) { const err: any = error; const retryable = err?.status === 429 || err?.status === 503 || (err?.status ?? 0) >= 500; if (!retryable || attempt === 2) throw error; await new Promise(r => setTimeout(r, Math.min(2000, 250 * 2 ** attempt) + Math.random() * 100)); }
    }
    throw new Error("Max retries exceeded");
  }

  private toGeminiMessages(request: ChatRequest): Array<{ role: "user" | "model"; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> {
    const msgs: Array<{ role: "user" | "model"; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> = [];
    for (const m of request.messages) {
      if (m.role === "system") continue;
      if (m.role === "user" || m.role === "assistant" || m.role === "model") {
        const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
        if (typeof m.content === "string") parts.push({ text: m.content });
        else if (Array.isArray(m.content)) for (const part of m.content) {
          if (part.type === "text") parts.push({ text: part.text });
          else if (part.type === "image_url" && part.image_url?.url) {
            const url = part.image_url.url;
            if (url.startsWith("data:")) { const [header, data] = url.split(",", 2); const mime = header.split(":")[1]?.split(";")[0] ?? "image/png"; parts.push({ inline_data: { mime_type: mime, data } }); }
            else parts.push({ text: `[Image URL: ${url}]` });
          }
        }
        if (parts.length) msgs.push({ role: m.role === "assistant" ? "model" : "user", parts });
      } else if (m.role === "tool") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        msgs.push({ role: "user", parts: [{ text: `Tool result: ${text}` }] });
      }
    }
    return msgs;
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = this.toGeminiMessages(request);
    const body: Record<string, unknown> = { contents: messages, generationConfig: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxTokens ?? this.config.maxTokens, topP: 0.95, topK: 40 } };
    if (stream) body.stream = true;
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    return this.withRetry("chat", async () => {
      const response = await fetch(this.url("/models/" + this.config.model + ":generateContent"), { method: "POST", headers: this.headers(), body: JSON.stringify(this.buildBody(request, false)), signal: request.signal });
      const text = await response.text();
      if (!response.ok) { const err = new Error(`Gemini API error ${response.status}: ${text}`) as Error & { status: number }; err.status = response.status; throw err; }
      const raw = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finish_reason?: string }>; usage_metadata?: { prompt_token_count?: number; candidates_token_count?: number; total_token_count?: number } };
      const candidate = raw.candidates?.[0];
      const content = candidate?.content?.parts?.map((p: { text?: string }) => p.text).join("") ?? "";
      const usage = raw.usage_metadata;
      return { model: this.config.model, content, toolCalls: [], finishReason: candidate?.finish_reason ?? "stop", usage: usage ? { promptTokens: usage.prompt_token_count, completionTokens: usage.candidates_token_count, totalTokens: usage.total_token_count } : undefined, totalLatencyMs: Date.now() - started, streamed: false };
    });
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const started = Date.now();
    let content = "";
    let finishReason: string | null = null;

    const response = await fetch(this.url("/models/" + this.config.model + ":streamGenerateContent?alt=sse"), { method: "POST", headers: { ...this.headers(), Accept: "text/event-stream" }, body: JSON.stringify(this.buildBody(request, true)) });

    if (!response.ok) { const text = await response.text(); throw new Error(`Gemini API error ${response.status}: ${text}`); }
    if (!response.body) throw new Error("Empty response body");

    let content = "";
    let finishReason: string | null = null;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const raw = JSON.parse(data);
          const candidate = raw.candidates?.[0];
          if (candidate?.content?.parts?.[0]?.text) { content += candidate.content.parts[0].text; onChunk({ type: "delta", text: candidate.content.parts[0].text }); }
          if (candidate?.finish_reason) finishReason = candidate.finish_reason;
        } catch { }
      }
      return { model: this.config.model, content, finishReason: finishReason ?? "stop", totalLatencyMs: Date.now() - started, streamed: true };
    }

  async embed(texts: string[], inputType: "query" | "document" = "document"): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model: "text-embedding-004", dimensions: 0 };
    return this.withRetry("embed", async () => {
      const response = await fetch(this.url("/models/text-embedding-004:embedContent"), { method: "POST", headers: this.headers(), body: JSON.stringify({ model: "models/text-embedding-004", content: { parts: [{ text: texts.join("\n") }] } }) });
      if (!response.ok) throw new Error(`Embedding failed: ${await response.text()}`);
      const raw = await response.json() as { embedding?: { values: number[] } };
      const vectors = raw.embedding?.values ?? [];
      return { vectors: [vectors], model: "text-embedding-004", dimensions: vectors.length };
    });
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const response = await fetch(this.url("/models/" + this.config.model), { headers: this.headers() });
      const latencyMs = Date.now() - started;
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}`, latencyMs };
      return { ok: true, detail: "Gemini API reachable", latencyMs };
    } catch (error) { return { ok: false, detail: `${(error as Error).message}`, latencyMs: Date.now() - started }; }
  }

  async capabilities(): Promise<ModelCapabilities> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(this.url("/models/" + this.config.model), { headers: this.headers() });
      if (!response.ok) throw new Error("Model not found");
      const raw = await response.json() as { display_name?: string; supported_generation_methods?: string[]; input_token_limit?: number; output_token_limit?: number };
      return { model: this.config.model, chat: true, streaming: true, tools: false, vision: true, embeddings: true, source: "config", checkedAt: new Date().toISOString(), notes: `Gemini native API · input tokens: ${raw.input_token_limit} · output tokens: ${raw.output_token_limit}` };
    } catch { return { model: this.config.model, chat: true, streaming: true, tools: false, vision: true, embeddings: true, source: "config", checkedAt: new Date().toISOString(), notes: "Gemini native API (capabilities declared by config)" }; }
  }

  private url(path: string): string { return `${this.config.baseUrl.replace(/\/$/, "")}${path}`; }
  private headers(): Record<string, string> { return { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" }; }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { return await fn(); }
      catch (error) { const err: any = error; const retryable = err?.status === 429 || err?.status === 503 || (err?.status ?? 0) >= 500; if (!retryable || attempt === 2) throw error; await new Promise(r => setTimeout(r, Math.min(2000, 250 * 2 ** attempt) + Math.random() * 100)); }
    }
    throw new Error("Max retries exceeded");
  }

  private url(path: string): string { return `${this.config.baseUrl.replace(/\/$/, "")}${path}`; }
  private headers(): Record<string, string> { return { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" }; }

  private toGeminiMessages(request: ChatRequest): Array<{ role: "user" | "model"; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> {
    const msgs: Array<{ role: "user" | "model"; parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }> = [];
    for (const m of request.messages) {
      if (m.role === "system") continue;
      if (m.role === "user" || m.role === "assistant" || m.role === "model") {
        const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
        if (typeof m.content === "string") parts.push({ text: m.content });
        else if (Array.isArray(m.content)) for (const part of m.content) {
          if (part.type === "text") parts.push({ text: part.text });
          else if (part.type === "image_url" && part.image_url?.url) { const url = part.image_url.url; if (url.startsWith("data:")) { const [header, data] = url.split(",", 2); const mime = header.split(":")[1]?.split(";")[0] ?? "image/png"; parts.push({ inline_data: { mime_type: mime, data } }); } else parts.push({ text: `[Image URL: ${url}]` }); }
        }
        if (parts.length) msgs.push({ role: m.role === "assistant" ? "model" : "user", parts });
      } else if (m.role === "tool") { const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content); msgs.push({ role: "user", parts: [{ text: `Tool result: ${text}` }] }); }
    }
    return msgs;
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const messages = this.toGeminiMessages(request);
    const body: Record<string, unknown> = { contents: messages, generationConfig: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxTokens ?? this.config.maxTokens, topP: 0.95, topK: 40 } };
    if (stream) body.stream = true;
    return body;
  }
}

export function createGeminiProvider(config: any) { return new (class { constructor(config: any) { this.config = config; } })(); }
export type { AiProvider, ChatRequest, ChatResponse, EmbedResult, ModelCapabilities, ProviderToolCall, StreamChunk, TokenUsage } from "./types.js";
export { ProviderError } from "./errors.js";
export type { GeminiConfig } from "./config.js";
export { loadGeminiConfig } from "./config.js";