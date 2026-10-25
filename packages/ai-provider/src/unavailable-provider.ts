import type { ModelCapabilities, TokenUsage } from "@jarvis/shared";
import { ProviderError } from "./errors.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult } from "./types.js";

/**
 * Honest fallback used when NVIDIA credentials are missing. It never fabricates
 * an answer: every call fails with an explicit "unavailable" error so the HUD
 * reports the brain as DOWN instead of pretending to think.
 */
export class UnavailableProvider implements AiProvider {
  readonly name = "unavailable";

  constructor(private readonly reason: string) {}

  private fail(): never {
    throw new ProviderError("unavailable", this.reason, { retryable: false });
  }

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.fail();
  }

  async stream(_request: ChatRequest, _onChunk: (chunk: never) => void): Promise<ChatResponse> {
    this.fail();
  }

  async embed(_texts: string[]): Promise<EmbedResult> {
    this.fail();
  }

  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    return { ok: false, detail: this.reason, latencyMs: 0 };
  }

  async capabilities(): Promise<ModelCapabilities> {
    return {
      model: "none",
      chat: false,
      streaming: false,
      tools: false,
      vision: false,
      embeddings: false,
      source: "config",
      checkedAt: new Date().toISOString(),
      notes: this.reason,
    };
  }
}

export const noProviderUsage: TokenUsage = {};
