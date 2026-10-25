import type { ModelCapabilities } from "@jarvis/shared";
import { ProviderError, type ProviderErrorKind } from "./errors.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, StreamChunk } from "./types.js";

/**
 * Cadena de proveedores con conmutación por fallo.
 *
 * Hoy JARVIS tiene un único cerebro: si NVIDIA NIM falla, `brain` queda
 * `down` y el agente deja de responder. Esta clase mantiene una lista ORDENADA
 * de proveedores y conmuta al siguiente cuando el activo falla por una causa
 * de PROVEEDOR (red, timeout, 5xx, rate limit, credenciales), nunca por una
 * causa de PETICIÓN (400/422: la misma petición fallaría igual en el respaldo).
 *
 * Reglas de diseño:
 *  · **Sticky**: el proveedor que responde bien se vuelve el preferido. No se
 *    vuelve a probar el primario caído en cada turno (eso pagaría el timeout
 *    en cada llamada).
 *  · **Sin failover a mitad de un stream**: si ya salió contenido, reintentar
 *    en otro proveedor duplicaría la respuesta. Se propaga el error.
 *  · **Abortos del usuario nunca conmutan**: una interrupción del usuario no
 *    es un fallo del proveedor.
 *  · **Embeddings**: cada proveedor se prueba hasta el primero que los sirva
 *    (NIM sí; un modelo de chat en OpenRouter normalmente no).
 */

export interface FailoverOptions {
  /** Notifica cada conmutación para métricas y registro de auditoría. */
  onFailover?: (event: { from: string; to: string; kind: ProviderErrorKind; message: string; attempt: number }) => void;
  /** Number of providers to try per request (at least 1). */
  maxAttempts?: number;
}

export class FailoverProvider implements AiProvider {
  readonly name: string;
  private readonly providers: AiProvider[];
  private readonly options: FailoverOptions;
  /** Índice del proveedor preferido. Se mueve al conmutar. */
  private preferred = 0;

  constructor(providers: AiProvider[], options: FailoverOptions = {}) {
    if (providers.length === 0) throw new Error("FailoverProvider requires at least one provider.");
    this.providers = providers;
    this.options = options;
    this.name = `failover(${providers.map((provider) => provider.name).join(">")})`;
  }

  /** Proveedor actualmente preferido. */
  get active(): AiProvider {
    return this.providers[this.preferred] as AiProvider;
  }

  /** Vuelve a preferir el primero de la lista (para recuperar el primario). */
  restorePrimary(): void {
    this.preferred = 0;
  }

  /** ¿El error justifica cambiar de proveedor? */
  private isFailoverWorthy(error: unknown): boolean {
    if (error instanceof ProviderError) {
      // Una petición inválida fallaría igual en todos los proveedores.
      if (error.kind === "invalid_request") return false;
      if (error.kind === "aborted") return false;
      return true;
    }
    return false;
  }

  private order(): AiProvider[] {
    const preferred = this.providers[this.preferred] as AiProvider;
    const rest = this.providers.filter((_, index) => index !== this.preferred);
    return [preferred, ...rest];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const order = this.order();
    const max = Math.min(this.options.maxAttempts ?? order.length, order.length);
    let lastError: unknown;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const provider = order[attempt] as AiProvider;
      try {
        const response = await provider.chat(request);
        this.markHealthy(provider);
        return response;
      } catch (error) {
        lastError = error;
        if (!this.isFailoverWorthy(error)) throw error;
        const next = order[attempt + 1];
        if (next) {
          this.options.onFailover?.({
            from: provider.name,
            to: next.name,
            kind: error instanceof ProviderError ? error.kind : "unknown",
            message: (error as Error).message,
            attempt: attempt + 1,
          });
        }
      }
    }
    throw this.describeFailure(lastError, order.slice(0, max).map((provider) => provider.name));
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    const order = this.order();
    const max = Math.min(this.options.maxAttempts ?? order.length, order.length);
    let lastError: unknown;
    for (let attempt = 0; attempt < max; attempt += 1) {
      const provider = order[attempt] as AiProvider;
      let emitted = false;
      try {
        const response = await provider.stream(request, (chunk) => {
          // Si ya se emitió contenido, el stream no se puede repetir en otro
          // proveedor: se propaga el error original.
          if (chunk.type === "delta" || chunk.type === "reasoning" || chunk.type === "tool_calls") emitted = true;
          onChunk(chunk);
        });
        this.markHealthy(provider);
        return response;
      } catch (error) {
        lastError = error;
        if (emitted) throw error;
        if (!this.isFailoverWorthy(error)) throw error;
        const next = order[attempt + 1];
        if (next) {
          this.options.onFailover?.({
            from: provider.name,
            to: next.name,
            kind: error instanceof ProviderError ? error.kind : "unknown",
            message: (error as Error).message,
            attempt: attempt + 1,
          });
        }
      }
    }
    throw this.describeFailure(lastError, order.slice(0, max).map((provider) => provider.name));
  }

  async embed(texts: string[], inputType: "query" | "passage" = "passage"): Promise<EmbedResult> {
    let lastError: unknown;
    for (const provider of this.order()) {
      try {
        const result = await provider.embed(texts, inputType);
        this.markHealthy(provider);
        return result;
      } catch (error) {
        lastError = error;
        // Un proveedor sin embeddings no es un fallo: se prueba el siguiente.
        if (error instanceof ProviderError && error.kind === "invalid_request") continue;
      }
    }
    throw this.describeFailure(lastError, this.providers.map((provider) => provider.name));
  }

  /**
   * Sonda informativa. NO cambia el proveedor preferido: sondear y conmutar
   * son responsabilidades distintas. (Antes esta llamada marcaba el proveedor
   * sano como preferido, y como el health check corre cada 20 s, el sistema
   * "saltaba" al respaldo sin registrar ninguna conmutación y sin volver
   * nunca al primario.)
   */
  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = Date.now();
    const failures: string[] = [];
    for (const provider of this.order()) {
      try {
        const health = await provider.health();
        if (health.ok) {
          const suffix = this.providers.length > 1 ? ` (cadena de ${this.providers.length} proveedores)` : "";
          return { ok: true, detail: `${provider.name}: ${health.detail}${suffix}`, latencyMs: Date.now() - started };
        }
        failures.push(`${provider.name}: ${health.detail}`);
      } catch (error) {
        failures.push(`${provider.name}: ${(error as Error).message}`);
      }
    }
    return { ok: false, detail: failures.join(" | "), latencyMs: Date.now() - started };
  }

  /**
   * Sonda el PRIMARIO sin alterar el estado. El servidor la usa para
   * re-promoverlo cuando se recupera, sin pagar un turno fallido por sondeo.
   */
  async probePrimary(): Promise<{ ok: boolean; detail: string }> {
    const primary = this.providers[0] as AiProvider;
    try {
      const health = await primary.health();
      return { ok: health.ok, detail: `${primary.name}: ${health.detail}` };
    } catch (error) {
      return { ok: false, detail: `${primary.name}: ${(error as Error).message}` };
    }
  }

  /** Nombre del proveedor en uso. */
  get activeName(): string {
    return this.active.name;
  }

  /** Modelos del proveedor activo (lo usa el servidor para el modelo de visión). */
  get models(): { chat: string; vision: string; embedding: string } | undefined {
    const candidate = this.active as AiProvider & { models?: { chat: string; vision: string; embedding: string } };
    return candidate.models;
  }

  async capabilities(): Promise<ModelCapabilities> {
    return this.active.capabilities();
  }

  /** Marca el proveedor que respondió como preferido (sticky). */
  private markHealthy(provider: AiProvider): void {
    const index = this.providers.indexOf(provider);
    if (index >= 0) this.preferred = index;
  }

  private describeFailure(error: unknown, attempted: string[]): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof ProviderError ? error.kind : "unknown";
    return new ProviderError(kind === "unknown" ? "unavailable" : kind, `Todos los proveedores fallaron (${attempted.join(", ")}): ${message}`, {
      retryable: false,
      detail: attempted.join(", "),
    });
  }
}
