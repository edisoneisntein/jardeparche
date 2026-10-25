import type { ComponentHealth, ComponentStatus, HealthReport } from "@jarvis/shared";
import { aggregateStatus } from "@jarvis/shared";
import type { AiProvider } from "@jarvis/ai-provider";
import type { MemoryService, Store } from "@jarvis/memory";
import type { ToolRegistry } from "@jarvis/tool-registry";
import type { VoiceService } from "@jarvis/voice";
import type { PerceptionService } from "@jarvis/perception";
import type { Logger } from "./logger.js";

/** Evento de cambio de salud que consume el hub. */
export interface HealthChange {
  type: "system.health_changed";
  component: string;
  status: ComponentStatus;
  detail?: string;
  ts: string;
}

export interface HealthDeps {
  provider: AiProvider;
  store: Store;
  memory: MemoryService;
  registry: ToolRegistry;
  voice: VoiceService;
  perception: PerceptionService;
  log: Logger;
  runtimeActiveTasks: () => number;
  /** Salud real del runtime (últimos turnos). */
  runtimeHealth: () => { ok: boolean; detail: string };
}

export class HealthRegistry {
  /** Último informe: permite emitir solo los cambios, no el estado completo. */
  private lastReport: HealthReport | null = null;

  constructor(private readonly deps: HealthDeps) {}

  async check(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    const [brain, database, perception] = await Promise.all([
      this.brain(),
      this.database(),
      this.perception(),
    ]);
    const toolsTotal = this.deps.registry.list().length;
    const toolsAvailable = this.deps.registry.available().length;
    const components: ComponentHealth[] = [
      brain,
      database,
      {
        component: "tools",
        status: toolsAvailable > 0 ? "up" : "degraded",
        detail: `${toolsAvailable}/${toolsTotal} herramientas disponibles`,
        checkedAt,
      },
      this.deps.voice.status().health,
      perception,
      this.runtime(),
    ];
    return { status: aggregateStatus(components), components, checkedAt };
  }

  /**
   * Ejecuta la comprobación y emite SOLO los componentes cuyo estado cambió.
   * Es lo que permite que el HUD reciba la salud en vivo en lugar de solo por
   * sondeo: antes este evento existía en el contrato y nadie lo emitía.
   */
  async checkAndEmit(emit: (event: HealthChange) => void): Promise<HealthReport> {
    const report = await this.check();
    const previous = this.lastReport;
    this.lastReport = report;
    if (!previous) return report;
    for (const component of report.components) {
      const before = previous.components.find((entry) => entry.component === component.component);
      if (!before || before.status !== component.status || before.detail !== component.detail) {
        emit({
          type: "system.health_changed",
          component: component.component,
          status: component.status,
          detail: component.detail,
          ts: component.checkedAt,
        });
      }
    }
    return report;
  }

  private async brain(): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    const health = await this.deps.provider.health();
    const capabilities = await this.deps.provider.capabilities().catch(() => undefined);
    const status: ComponentStatus = health.ok ? "up" : "down";
    return {
      component: "brain",
      status,
      detail: `${this.deps.provider.name}: ${health.detail}${capabilities ? ` · modelo ${capabilities.model}` : ""}`,
      checkedAt,
      latencyMs: health.latencyMs ?? Date.now() - started,
    };
  }

  /** Sonda real de percepción: el proveedor de visión debe responder. */
  private async perception(): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const health = await this.deps.perception.health();
      return {
        component: "perception",
        status: health.ok ? "up" : "degraded",
        detail: `${health.detail} · análisis puntual (una foto por petición), nunca captura continua`,
        checkedAt,
      };
    } catch (error) {
      return {
        component: "perception",
        status: "down",
        detail: `la sonda de percepción falló: ${(error as Error).message}`,
        checkedAt,
      };
    }
  }

  /** Sonda real del runtime: refleja los últimos turnos ejecutados. */
  private runtime(): ComponentHealth {
    const checkedAt = new Date().toISOString();
    const health = this.deps.runtimeHealth();
    return {
      component: "runtime",
      status: health.ok ? "up" : "degraded",
      detail: health.detail,
      checkedAt,
    };
  }

  private async database(): Promise<ComponentHealth> {
    const checkedAt = new Date().toISOString();
    const health = await this.deps.store.health();
    return {
      component: "database",
      status: health.ok ? "up" : "down",
      detail: `${this.deps.store.kind}: ${health.detail}`,
      checkedAt,
    };
  }
}
