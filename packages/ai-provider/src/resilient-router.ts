import type { ModelCapabilities } from "@jarvis/shared";
import { FailoverProvider } from "./failover-provider.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, StreamChunk } from "./types.js";

/**
 * ARCH-001 · Enrutador resiliente de proveedores de IA.
 *
 * Capa de SALUD por encima de la conmutación por fallo:
 *
 *  · `FailoverProvider` (reactivo) salta al respaldo cuando una petición
 *    falla. Eso resuelve la caída, pero obliga al servidor a esperar el tiempo
 *    de espera del primario cada vez que vuelve a intentarlo.
 *  · `ResilientAIRouter` (proactivo) mantiene un CIRCUITO por proveedor: tras
 *    varios fallos seguidos el proveedor queda abierto y no se le vuelve a
 *    llamar hasta que pase el enfriamiento. Cuando el primario se recupera,
 *    el enrutador lo repone él mismo.
 *
 * El runtime NO se entera de nada de esto: habla con `AiProvider` y siempre
 * recibe una respuesta o un error de proveedor, nunca una excepción de
 * enrutado.
 */
export interface ResilientRouterOptions {
  /** Notifica cada conmutación (métricas y auditoría). */
  onFailover?: (event: { from: string; to: string; kind: string; message: string; attempt: number }) => void;
  /** Máximo de proveedores que se intentan en una petición. */
  maxAttempts?: number;
  /** Fallos consecutivos antes de abrir el circuito de un proveedor. */
  failureThreshold?: number;
  /** Tiempo que un circuito abierto aguanta antes de volver a probar. */
  cooldownMs?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

const DEFAULTS = {
  failureThreshold: 2,
  cooldownMs: 60_000,
} as const;

export class ResilientAIRouter implements AiProvider {
  readonly name: string;
  /** Cadena reactiva: conmutación por fallo dentro de una misma petición. */
  private readonly chain: FailoverProvider;
  private readonly providers: AiProvider[];
  private readonly options: ResilientRouterOptions;
  private readonly now: () => number;
  /** Fallos consecutivos por proveedor. */
  private readonly failures = new Map<string, number>();
  /** Hasta cuándo está abierto el circuito de un proveedor. */
  private readonly openUntil = new Map<string, number>();
  /**
   * Callback interno que registra qué proveedor falló durante la llamada en
   * curso. Lo rellena la cadena al conmutar: sin él no se sabe a quién
   * atribuir el fallo (tras conmutar, el preferido ya es el respaldo).
   */
  private pendingFailure: ((providerName: string) => void) | undefined;

  constructor(providers: AiProvider[], options: ResilientRouterOptions = {}) {
    if (providers.length === 0) throw new Error("ResilientAIRouter requires at least one provider.");
    this.providers = providers;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.chain = new FailoverProvider(providers, {
      onFailover: (event) => {
        // El proveedor que falló es el que abre el circuito.
        this.pendingFailure?.(event.from);
        options.onFailover?.(event);
      },
      maxAttempts: options.maxAttempts,
    });
    this.name = `resilient(${providers.map((provider) => provider.name).join(">")})`;
  }

  /** Proveedor preferido ahora mismo. */
  get activeName(): string {
    return this.chain.activeName;
  }

  /** Modelos del proveedor activo (el servidor los usa para el modelo de visión). */
  get models(): { chat: string; vision: string; embedding: string } | undefined {
    return this.chain.models;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.guard(() => this.chain.chat(request));
  }

  async stream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
    return this.guard(() => this.chain.stream(request, onChunk));
  }

  async embed(texts: string[], inputType: "query" | "passage" = "passage"): Promise<EmbedResult> {
    return this.guard(() => this.chain.embed(texts, inputType));
  }

  async capabilities(): Promise<ModelCapabilities> {
    return this.chain.capabilities();
  }

  /**
   * Sonda de salud que además REPONE al primario si se ha recuperado.
   *
   * Es el único punto que decide a quién se llama: el servidor la invoca
   * desde su watcher de salud, así que la reposición ocurre sin que ningún
   * turno pague un tiempo de espera.
   */
  async health(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = this.now();
    await this.maybeRestorePrimary();
    const result = await this.chain.health();
    return { ...result, latencyMs: this.now() - started };
  }

  /**
   * Repone al primario si su circuito está cerrado y ha pasado el enfriamiento.
   *
   * No toca la cadena si el primario sigue fallando: en ese caso el circuito
   * sigue abierto y el respaldo sigue siendo el preferido.
   */
  private async maybeRestorePrimary(): Promise<void> {
    const primary = this.providers[0];
    if (!primary) return;
    const openUntil = this.openUntil.get(primary.name) ?? 0;
    if (this.now() < openUntil) return;
    if ((this.failures.get(primary.name) ?? 0) === 0) return;
    try {
      const probe = await primary.health();
      if (probe.ok) {
        this.failures.delete(primary.name);
        this.openUntil.delete(primary.name);
        this.chain.restorePrimary();
      }
    } catch {
      // El sondeo fallido no cambia nada: el circuito sigue cerrado.
    }
  }

  /**
   * Envuelve una llamada: contabiliza el fallo y abre el circuito del
   * proveedor si toca. El error de proveedor se propaga tal cual (con su
   * `kind`), para que el runtime pueda decidir sin conocer el enrutado.
   */
  private async guard<T>(call: () => Promise<T>): Promise<T> {
    let failedProvider: string | undefined;
    const previous = this.pendingFailure;
    this.pendingFailure = (providerName) => {
      failedProvider = providerName;
    };
    try {
      const result = await call();
      this.markSuccess(this.chain.activeName);
      // Aunque la llamada haya tenido éxito, el proveedor que falló por el
      // camino cuenta su fallo: si no, su circuito nunca se abriría.
      if (failedProvider) this.markFailure(failedProvider);
      return result;
    } catch (error) {
      // El circuito se abre sobre el proveedor que falló de verdad; si no
      // hubo conmutación, es el que estaba en uso.
      this.markFailure(failedProvider ?? this.chain.activeName);
      throw error;
    } finally {
      this.pendingFailure = previous;
    }
  }

  private markSuccess(providerName: string): void {
    this.failures.delete(providerName);
    this.openUntil.delete(providerName);
  }

  private markFailure(providerName: string): void {
    const failures = (this.failures.get(providerName) ?? 0) + 1;
    this.failures.set(providerName, failures);
    const threshold = this.options.failureThreshold ?? DEFAULTS.failureThreshold;
    if (failures >= threshold) {
      this.openUntil.set(providerName, this.now() + (this.options.cooldownMs ?? DEFAULTS.cooldownMs));
    }
  }

  /** Estado del circuito de un proveedor (diagnóstico). */
  circuitState(providerName: string): "closed" | "open" {
    const openUntil = this.openUntil.get(providerName) ?? 0;
    return this.now() < openUntil ? "open" : "closed";
  }
}
