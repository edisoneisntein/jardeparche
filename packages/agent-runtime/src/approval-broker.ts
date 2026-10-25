import type { ApprovalRecord, Store } from "@jarvis/memory";
import type { ToolRegistry } from "@jarvis/tool-registry";

interface Waiter {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  taskId: string;
  cleanup: () => void;
}

export interface ApprovalRequestInput {
  userId: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  risk: string;
  description: string;
}

/**
 * SEC-002 · Petición de ejecución de una tool con efectos.
 *
 * El token es la prueba de que el usuario aprobó ESTA llamada concreta. El
 * registro de tools lo verifica antes de ejecutar (fail-closed).
 */
export interface ExecutionRequest {
  toolId: string;
  parameters: Record<string, unknown>;
  /** Token de aprobación firmado. Ausente = la tool no exige aprobación. */
  userApprovalToken?: string;
}

/**
 * Blocks a task on explicit human authorization. A pending approval always
 * resolves — on approval, denial, timeout (expired) or task cancellation — so
 * a task can never hang forever.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();
  /** Remembers decisions that arrive before `wait()` is called, so resolving early is never lost. */
  private readonly decisions = new Map<string, boolean>();
  private readonly store: Store;
  private readonly timeoutMs: number;
  private readonly log: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
  /** Emisor del token firmado: lo aporta el registro de tools. */
  private readonly issueGrant: (input: {
    toolName: string;
    userId: string;
    sessionId: string;
    taskId: string;
    toolCallId: string;
    arguments: unknown;
    mode: "user" | "auto";
  }) => string;
  /** Tokens ya emitidos, por id de aprobación. */
  private readonly tokens = new Map<string, string>();
  /** Datos de la petición viva, por id de aprobación, para poder firmarla. */
  private readonly pending = new Map<string, ApprovalRequestInput>();
  /** Tope de tokens vivos: el runtime consume el suyo en el acto. */
  private static readonly MAX_LIVE_TOKENS = 512;

  constructor(options: {
    store: Store;
    timeoutMs: number;
    log: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
    /** Fuente de tokens de aprobación. */
    grants?: Pick<ToolRegistry, "issueGrant">;
  }) {
    this.store = options.store;
    this.timeoutMs = options.timeoutMs;
    this.log = options.log;
    this.issueGrant = options.grants
      ? (input) => options.grants!.issueGrant(input)
      : (input) => {
          // Sin registro no se puede firmar: la aprobación nunca se ejecuta.
          this.log("error", "no hay emisor de tokens de aprobación; la ejecución se denegará", { tool: input.toolName });
          return "";
        };
  }

  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    const record = await this.store.createApproval(input);
    this.pending.set(record.id, input);
    return record;
  }

  /**
   * Token de aprobación de una petición ya resuelta.
   *
   * Se devuelve solo si el usuario la aprobó: denegar o caducar NO firma
   * nada, y el registro rechazará la ejecución por falta de token válido.
   */
  tokenFor(approvalId: string): string | undefined {
    return this.tokens.get(approvalId);
  }

  /**
   * Firma un token para la política de auto-aprobación.
   *
   * La auto-aprobación NO es un bypass: emite un token con `mode: "auto"`,
   * igualmente ligado a tool, argumentos y sesión, y igualmente auditado. La
   * diferencia con la aprobación del usuario está en el modo, no en la
   * ausencia de comprobación.
   */
  signAutoApproval(input: ApprovalRequestInput): string {
    return this.signForKey(`${input.sessionId}:${input.toolCallId}`, input, "auto");
  }

  private signForKey(key: string, input: ApprovalRequestInput, mode: "user" | "auto"): string {
    const token = this.issueGrant({ ...input, mode });
    this.tokens.set(key, token);
    // El mapa no crece sin límite: el runtime consume su token en el acto.
    while (this.tokens.size > ApprovalBroker.MAX_LIVE_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    return token;
  }

  /**
   * Firma el token de una aprobación concedida.
   *
   * El token ata la aprobación a la tool, a los argumentos y a la sesión: no
   * sirve para otra llamada ni sobrevive a un reinicio del servidor.
   */
  private signFor(approvalId: string, mode: "user" | "auto"): string {
    const input = this.pending.get(approvalId);
    if (!input) return "";
    return this.signForKey(approvalId, input, mode);
  }

  wait(approvalId: string, taskId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const settled = this.decisions.get(approvalId);
    if (settled !== undefined) {
      this.decisions.delete(approvalId);
      return Promise.resolve(settled);
    }
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => this.settle(approvalId, approved);
      const timer = setTimeout(() => {
        void this.store.resolveApproval(approvalId, "expired");
        this.log("warn", "approval expired", { approvalId });
        finish(false);
      }, this.timeoutMs);
      const onAbort = () => finish(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      const existing = this.waiters.get(approvalId);
      if (existing) existing.cleanup();
      this.waiters.set(approvalId, {
        resolve,
        timer,
        taskId,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
    });
  }

  /** Called by the server when the user answers the approval dialog. */
  async resolve(approvalId: string, approve: boolean): Promise<ApprovalRecord | undefined> {
    const record = await this.store.resolveApproval(approvalId, approve ? "approved" : "denied");
    // Solo una aprobación CONCEDIDA firma un token. Denegar o dejar caducar
    // no deja nada ejecutable: el registro rechazará la llamada.
    if (approve) this.signFor(approvalId, "user");
    else this.tokens.delete(approvalId);
    // La petición ya no está viva: no hace falta guardar sus datos.
    this.pending.delete(approvalId);
    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      this.settle(approvalId, approve);
    } else {
      this.decisions.set(approvalId, approve);
    }
    return record;
  }

  cancelTask(taskId: string): void {
    for (const [id, waiter] of this.waiters) {
      if (waiter.taskId === taskId) this.settle(id, false);
    }
  }

  private settle(approvalId: string, approved: boolean): void {
    const waiter = this.waiters.get(approvalId);
    if (!waiter) return;
    this.waiters.delete(approvalId);
    clearTimeout(waiter.timer);
    waiter.cleanup();
    waiter.resolve(approved);
  }

  get pendingCount(): number {
    return this.waiters.size;
  }
}
