import type { ChatMessage, RiskLevel } from "@jarvis/shared";
import type { AiProvider } from "@jarvis/ai-provider";
import type { MemoryService } from "@jarvis/memory";
import type { ToolRegistry } from "@jarvis/tool-registry";
import { AgentStateMachine } from "./state-machine.js";
import { buildSystemPrompt } from "./prompt.js";
import { ApprovalBroker } from "./approval-broker.js";
import { ResponseComposer } from "./composer.js";
import {
  FALLBACK_NUDGE,
  IntentToolResolver,
  isRawToolCall,
  looksLikeRefusal,
  summariseToolOutput,
} from "./intent.js";
import { ToolCallExecutorImpl } from "./tool-executor.js";
import { ALL_RISK_LEVELS, humanApprovalAlways, riskTieredApproval } from "./approval-policy.js";
import type {
  Actor,
  AgentLimits,
  ApprovalPolicy,
  EmitFn,
  LogFn,
  ToolIntentResolver,
  TurnScope,
} from "./contracts.js";

export type { Actor, AgentLimits, ApprovalPolicy, LogFn, EmitFn } from "./contracts.js";
export {
  ALWAYS_AVAILABLE_TOOLS,
  FALLBACK_NUDGE,
  FALLBACK_PATTERNS,
  IntentToolResolver,
  isRawToolCall,
  providerNameOf,
  summariseToolOutput,
} from "./intent.js";

/** Error de interrupción: el usuario canceló el turno. */
export class TaskInterruptedError extends Error {
  constructor() {
    super("Task interrupted by the user");
    this.name = "TaskInterruptedError";
  }
}

/** Techos por defecto de un turno. */
export const DEFAULT_LIMITS: AgentLimits = {
  maxIterations: 6,
  maxToolCalls: 8,
  maxDurationMs: 120_000,
  maxHistoryMessages: 8,
};

/**
 * PERF-002 · Umbral de similitud para servir una respuesta cacheada.
 *
 * 0.98 es MUY estricto a propósito: la caché solo debe responder cuando la
 * pregunta es prácticamente la misma. Un umbral más bajo serviría respuestas
 * parecidas pero distintas, y el usuario notaría que JARVIS «se equivoca».
 */
export const SEMANTIC_CACHE_THRESHOLD = 0.98;

/** Tope de retención del compositor: caracteres y milisegundos. */
const RESPONSE_HOLD_CHARS = 90;
const RESPONSE_HOLD_MS = 150;

export interface AgentRuntimeDeps {
  /** Motor de inferencia. */
  provider: AiProvider;
  /** Registro de herramientas: única vía para producir efectos. */
  registry: ToolRegistry;
  /** Memoria persistente y semántica. */
  memory: MemoryService;
  /** Publica eventos hacia el cliente. */
  emit: EmitFn;
  /** Log estructurado. */
  log?: LogFn;
  /** Techos del turno. */
  limits?: Partial<AgentLimits>;
  /** Espera máxima de una aprobación humana, en ms. */
  approvalTimeoutMs?: number;
  /** Prompt de sistema (por defecto, el del paquete). */
  systemPrompt?: string;
  /**
   * Catálogo COMPLETO de herramientas en cada turno.
   *
   * Con `false` (por defecto) se poda por intención: menos esquema en el
   * pre-fill, el modelo responde de memoria lo que ya sabe y NO busca en la
   * web por rutina (medido: con el catálogo completo el primer audio pasó de
   * 3 s a 30 s). El poder NO se pierde: si el modelo responde con una excusa
   * («no dispongo de una herramienta»), la excusa se retiene en silencio y el
   * turno se reintenta con TODAS las herramientas.
   *
   * Con `true` se le ofrecen siempre todas: más lento, pero sin poda.
   */
  fullCatalog?: boolean;
  /**
   * Ejecuta las herramientas sin pedir confirmación. La acción queda
   * auditada igual; lo que desaparece es el aviso previo.
   */
  autoApprove?: boolean;
  /**
   * Política de aprobación explícita. Si no se indica, se deduce de
   * `autoApprove` y de `autoApprovableRisks`.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * Niveles de riesgo que la auto-aprobación puede cubrir.
   *
   * Por defecto se cubren TODOS (compatibilidad con el comportamiento
   * anterior). Un despliegue que quiera que `external_effect` y `destructive`
   * exijan confirmación humana debe pasa `["public_read", "local_reversible"]`.
   */
  autoApprovableRisks?: readonly RiskLevel[];
  /**
   * Resolutor de intención: qué herramientas se ofrecen según el texto.
   * Por defecto, señales léxicas locales (sin inferencia extra).
   */
  intentResolver?: ToolIntentResolver;
}

interface ActiveTask {
  abort: AbortController;
  state: AgentStateMachine;
  sessionId: string;
  taskId: string;
}

/**
 * The orchestrator. Implements a bounded, observable agent loop:
 * interpret → recall → plan → (approve) → execute → observe → answer.
 * Every state change corresponds to a real step; there are no decorative timers.
 *
 * Responsabilidad: ORQUESTAR. La resolución de intención, la ejecución de
 * herramientas y la composición del texto viven en colaboradores con contrato
 * (`ToolIntentResolver`, `ToolCallExecutor`, `ResponseComposer`). Este objeto
 * compone el turno, conserva el presupuesto y decide cuándo termina.
 */
export class AgentRuntime {
  private readonly provider: AiProvider;
  private readonly registry: ToolRegistry;
  private readonly memory: MemoryService;
  private readonly emit: EmitFn;
  private readonly log: LogFn;
  private readonly limits: AgentLimits;
  private readonly prompt: string;
  /** Catálogo completo de herramientas (sin poda por intención). */
  private readonly fullCatalog: boolean;
  /** Ejecuta sin pedir confirmación (si la política lo permite). */
  private readonly autoApprove: boolean;
  /** Política de aprobación vigente. */
  private readonly approvalPolicy: ApprovalPolicy;
  /** Resolutor de intención. */
  private readonly intent: ToolIntentResolver;
  /** Ejecutor de herramientas. */
  private readonly toolExecutor: ToolCallExecutorImpl;
  private readonly tasks = new Map<string, ActiveTask>();
  /**
   * Cola de turnos por sesión.
   *
   * Dos turnos simultáneos de la MISMA sesión intercalaban escrituras de
   * memoria e historial: el segundo turno building prompt con el historial a
   * medias del primero. Ahora los turnos de una sesión se serializan.
   */
  private readonly sessionQueues = new Map<string, Promise<void>>();
  /** Salud real del runtime: fallos consecutivos y última operación correcta. */
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: string | null = null;
  /** Broker de aprobaciones humanas. */
  readonly approvals: ApprovalBroker;

  constructor(deps: AgentRuntimeDeps) {
    this.provider = deps.provider;
    this.registry = deps.registry;
    this.memory = deps.memory;
    this.emit = deps.emit;
    this.log = deps.log ?? (() => {});
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.prompt = deps.systemPrompt ?? buildSystemPrompt();
    this.fullCatalog = deps.fullCatalog ?? false;
    this.autoApprove = deps.autoApprove ?? true;
    this.intent = deps.intentResolver ?? new IntentToolResolver();
    this.approvalPolicy = deps.approvalPolicy ?? this.defaultApprovalPolicy(deps);
    this.approvals = new ApprovalBroker({
      store: this.memory.raw,
      timeoutMs: deps.approvalTimeoutMs ?? 120_000,
      log: this.log,
      // SEC-002: el registro firma y verifica los tokens de aprobación.
      grants: this.registry,
    });
    this.toolExecutor = new ToolCallExecutorImpl({
      registry: this.registry,
      memory: this.memory,
      approvals: this.approvals,
      policy: this.approvalPolicy,
      emit: this.emit,
      log: this.log,
    });
  }

  /** Política por defecto según `autoApprove` y los riesgos configurados. */
  private defaultApprovalPolicy(deps: AgentRuntimeDeps): ApprovalPolicy {
    if (!this.autoApprove) return humanApprovalAlways();
    return riskTieredApproval(deps.autoApprovableRisks ?? ALL_RISK_LEVELS);
  }

  /** Cancela un turno en curso. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.abort.abort(new TaskInterruptedError());
    return true;
  }

  /** Cancela todas las tareas vivas de una sesión. */
  cancelSession(sessionId: string): boolean {
    let cancelled = false;
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      task.abort.abort(new TaskInterruptedError());
      cancelled = true;
    }
    return cancelled;
  }

  /** ¿Hay un turno vivo con ese identificador? */
  isRunning(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Turnos vivos (en curso o en cola). */
  activeTaskCount(): number {
    return this.tasks.size;
  }

  /**
   * Salud real del runtime. No es una constante: refleja los últimos turnos.
   * Con tres fallos consecutivos el runtime se considera degradado.
   */
  health(): { ok: boolean; detail: string } {
    const active = this.tasks.size;
    if (this.consecutiveFailures >= 3) {
      return { ok: false, detail: `${this.consecutiveFailures} turno(s) fallidos seguidos: ${this.lastError ?? "error desconocido"}` };
    }
    if (this.consecutiveFailures > 0) {
      return { ok: true, detail: `último turno fallido: ${this.lastError ?? "error desconocido"}` };
    }
    return { ok: true, detail: `${active} tarea(s) activa(s)${this.lastSuccessAt ? ` · último turno correcto ${this.lastSuccessAt}` : ""}` };
  }

  /**
   * Ejecuta un turno de conversación.
   *
   * Args:
   *   actor: Identidad del interlocutor.
   *   text: Texto del usuario.
   *   task_id: Identificador del turno (por defecto, uno nuevo).
   *   options: Ajustes del turno (`disableThinking` para el modo voz rápido).
   *
   * Returns:
   *   El identificador del turno y el texto final (vacío si se canceló).
   */
  async runTurn(
    actor: Actor,
    text: string,
    taskId = crypto.randomUUID(),
    options: { disableThinking?: boolean } = {},
  ): Promise<{ taskId: string; text: string }> {
    const abort = new AbortController();
    const state = new AgentStateMachine("IDLE", (next, detail) => {
      this.emit({
        type: "assistant.state_changed",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        state: next,
        detail,
      });
    });
    // El turno se registra ANTES de encolarse: un turno en cola también
    // puede cancelarse.
    this.tasks.set(taskId, { abort, state, sessionId: actor.sessionId, taskId });
    const startedAt = Date.now();

    try {
      return await this.enqueue(actor.sessionId, () =>
        this.executeTurn(actor, text, taskId, options, abort, state, startedAt),
      );
    } finally {
      this.tasks.delete(taskId);
      this.approvals.cancelTask(taskId);
    }
  }

  /**
   * Serializa los turnos de una misma sesión.
   *
   * Los turnos de sesiones DISTINTAS no se bloquean entre sí: la cola es por
   * sesión, no global.
   */
  private async enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId);
    const run = previous ? previous.then(work) : work();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionQueues.set(sessionId, settled);
    try {
      return await run;
    } finally {
      if (this.sessionQueues.get(sessionId) === settled) this.sessionQueues.delete(sessionId);
    }
  }

  /**
   * Cuerpo del turno: memoria, caché, contexto y bucle del agente.
   *
   * Todo lo que puede fallar se degrada: un turno fallido deja constancia
   * (episodio, auditoría, salud) y devuelve texto vacío en vez de tumbar el
   * proceso.
   */
  private async executeTurn(
    actor: Actor,
    text: string,
    taskId: string,
    options: { disableThinking?: boolean },
    abort: AbortController,
    state: AgentStateMachine,
    startedAt: number,
  ): Promise<{ taskId: string; text: string }> {
    const change = (next: Parameters<AgentStateMachine["set"]>[0], detail?: string) => {
      if (!state.canGo(next)) this.log("warn", "illegal state transition", { from: state.current, to: next, taskId });
      state.set(next, detail);
    };
    const usedTools = new Set<string>();
    const seenSignatures = new Set<string>();
    const scope: TurnScope = {
      actor,
      taskId,
      abort,
      seenSignatures,
      usedTools,
      startedAt,
      onState: change,
    };

    try {
      await this.memory.recordUserMessage({ userId: actor.userId, sessionId: actor.sessionId, taskId, text });

      // PERF-002 · Caché de respuestas. Si este prompt ya se respondió, se
      // devuelve lo mismo SIN llamar al proveedor: mismo texto, coste cero y
      // una latencia muy por debajo de la inferencia.
      const cached = await this.memory.findSemanticMatch(actor.userId, text, SEMANTIC_CACHE_THRESHOLD);
      if (cached) {
        change("SPEAKING", "respuesta servida desde la caché");
        this.emit({
          type: "assistant.delta",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          text: cached.response,
        });
        this.emit({
          type: "assistant.message_completed",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          text: cached.response,
        });
        await this.memory.recordAssistantMessage({
          userId: actor.userId,
          sessionId: actor.sessionId,
          taskId,
          text: cached.response,
        });
        this.log("info", "respuesta servida desde la caché", { taskId, hits: cached.hits });
        return { taskId, text: cached.response };
      }

      change("UNDERSTANDING", "recuperando contexto");

      const recall = await this.memory.recall(actor.userId, actor.sessionId, text);
      const memoryContext = this.memory.buildContextBlock(recall);
      const history = await this.buildHistory(actor.sessionId, taskId);
      const messages: ChatMessage[] = [
        { role: "system", content: memoryContext ? `${this.prompt}\n\n${memoryContext}` : this.prompt },
        ...history,
        { role: "user", content: text },
      ];

      const allTools = this.registry.toProviderTools();
      // Los nombres publicados los decide EL REGISTRO (son la clave que ve el
      // modelo). El runtime no normaliza por su cuenta: dos copias de la
      // regla de saneado divergen y el resultado es un turno sin
      // herramientas sin ningún error visible.
      const wantedNames = new Set([
        ...this.intent.resolve(text).map((name) => this.registry.publishedNameOf(name)),
        // La búsqueda web NO se poda nunca: es la respuesta universal a
        // «no lo sé». Sin ella, una pregunta que solo activa la señal de hora
        // (p. ej. «¿cuándo juega la selección?», que menciona «fecha»)
        // dejaba al modelo sin herramienta de búsqueda: contestaba con la hora
        // y además afirmaba no tener forma de buscar.
        ...this.intent.alwaysAvailable.map((name) => this.registry.publishedNameOf(name)),
      ]);
      // Catálogo completo: se le da TODO lo que el registro tiene. Con la
      // poda por intención, el modelo se quedaba a veces sin ninguna
      // herramienta y contestaba «no dispongo de una herramienta que me
      // permita...» antes de que el reintento lo arreglara: el usuario veía
      // (y oía) la excusa primero.
      let activeTools = this.fullCatalog
        ? allTools
        : wantedNames.size
          ? allTools.filter((tool) => wantedNames.has(tool.function.name))
          : [];
      let fallbackTried = false;
      let speechStarted = false;
      let finalText = "";
      /** Resumen del último tool call ejecutado: sirve de respuesta de reserva. */
      let lastToolSummary = "";
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      let iteration = 0;

      while (true) {
        this.assertNotAborted(abort);
        iteration += 1;
        if (iteration > this.limits.maxIterations) {
          finalText = `He alcanzado mi límite de ${this.limits.maxIterations} pasos sin cerrar la tarea. Esto es lo último que obtuve: ${finalText || "(sin contenido)"}`;
          break;
        }
        if (Date.now() - startedAt > this.limits.maxDurationMs) {
          finalText = `La tarea superó el presupuesto de ${Math.round(this.limits.maxDurationMs / 1000)} s. La detengo para no dejarla a medias.`;
          break;
        }

        change("PLANNING", activeTools.length ? "decidiendo si uso herramientas" : "respondiendo directamente");
        // El compositor retiene el primer fragmento si parece una EXCUSA
        // («no dispongo de una herramienta…»): esa frase no llega al usuario
        // ni a su voz; se reintenta con el catálogo completo y lo que se
        // muestra/escucha es la respuesta buena.
        const composer = new ResponseComposer({
          holdChars: RESPONSE_HOLD_CHARS,
          holdMs: RESPONSE_HOLD_MS,
          onDelta: (chunk) => {
            this.emit({ type: "assistant.delta", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), text: chunk });
          },
          onFirstRelease: () => {
            if (speechStarted) return;
            speechStarted = true;
            this.emit({
              type: "voice.speaking.started",
              sessionId: actor.sessionId,
              taskId,
              ts: new Date().toISOString(),
              generationId: `voice:${taskId}`,
              text: finalText,
              serverEpoch: 0,
              serverAudio: true,
            });
          },
        });

        const result = await this.provider.stream(
          {
            messages,
            tools: activeTools.length ? activeTools : undefined,
            toolChoice: activeTools.length ? "auto" : undefined,
            signal: abort.signal,
            disableThinking: options.disableThinking,
          },
          (chunk) => {
            if (chunk.type === "delta") composer.accept(chunk.text);
          },
        );
        this.assertNotAborted(abort);
        // Si el modelo llamó a una herramienta, lo que dijo antes ("voy a
        // comprobarlo") se oye: es parte de la voz de JARVIS. Si en cambio
        // respondió y era una excusa, se descarta en el reintento.
        composer.release();
        if (result.usage) usage = result.usage;
        // El razonamiento del modelo se publica para que el usuario vea cómo
        // ha llegado a la respuesta (en vez de una respuesta opaca).
        if (result.reasoning && result.reasoning.trim()) {
          this.emit({
            type: "assistant.reasoning",
            sessionId: actor.sessionId,
            taskId,
            ts: new Date().toISOString(),
            text: result.reasoning.trim(),
          });
        }

        if (result.toolCalls.length === 0) {
          const content = (result.content || finalText).trim();
          if (isRawToolCall(content)) {
            // El modelo ha escrito la llamada a la tool como texto plano
            // (así lo hace a veces Nemotron). Eso NO es una respuesta: se
            // entrega al usuario la información que la tool ya devolvió.
            finalText = lastToolSummary
              ? summariseToolOutput(lastToolSummary)
              : "La herramienta se invocó pero no devolvió información utilizable.";
          } else {
            finalText = content;
          }
          // Falsos negativos: la respuesta delata que el modelo quería datos.
          // Se reintenta con el catálogo completo aunque la ruta haya
          // transmitted deltas: las tools de investigación están siempre
          // disponibles, así que «no dispongo de una herramienta» ya no
          // significa que falte la búsqueda, sino que el modelo decidió
          // rendirse con el subconjunto que tenía.
          if (!this.fullCatalog && !fallbackTried && finalText && looksLikeRefusal(finalText)) {
            fallbackTried = true;
            this.log("info", "fallback conversacional: reintento con catálogo completo", { taskId });
            change("PLANNING", "la respuesta requiere datos; reintento");
            activeTools = allTools;
            // El reintento necesita una instrucción explícita: el modelo acaba
            // de afirmar que no tiene herramientas y, sin este aviso, repite
            // la misma negativa con el mismo catálogo.
            const systemIndex = messages.findIndex((m) => m.role === "system");
            const systemMessage = systemIndex >= 0 ? messages[systemIndex] : undefined;
            if (systemMessage) {
              messages[systemIndex] = {
                role: "system",
                content: `${systemMessage.content ?? ""}\n\n${FALLBACK_NUDGE}`,
              };
            }
            finalText = "";
            continue;
          }
          break;
        }

        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        let budgetExceeded = false;
        for (const call of result.toolCalls) {
          if (seenSignatures.size >= this.limits.maxToolCalls) {
            budgetExceeded = true;
            break;
          }
          const toolMessage = await this.toolExecutor.execute(call, scope);
          messages.push(toolMessage);
          const last = toolMessage.content;
          if (typeof last === "string") lastToolSummary = last;
        }
        if (budgetExceeded) {
          finalText = `Detuve la ejecución tras ${this.limits.maxToolCalls} llamadas a herramientas para evitar un bucle.`;
          break;
        }
      }

      change("SPEAKING", "respuesta lista");
      if (finalText) {
        await this.memory.recordAssistantMessage({ userId: actor.userId, sessionId: actor.sessionId, taskId, text: finalText });
      }
      this.emit({
        type: "assistant.message_completed",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        text: finalText,
        usage,
      });
      // El navegador sintetiza la voz (Web Speech API). Sin este evento el cliente
      // nunca dispara speechSynthesis, por eso JARVIS escribía pero no hablaba.
      const generationId = `voice:${taskId}`;
      if (finalText) {
        this.emit({
          type: "voice.output_started",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          generationId,
          text: finalText,
        });
      }
      // Cierre explícito de la generación: el cliente necesita saber que la
      // locución terminó para limpiar su estado (antes este evento existía
      // en el contrato pero nadie lo emitía).
      this.emit({
        type: "voice.output_stopped",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        generationId,
        reason: "completed",
        serverEpoch: 0,
      });
      await this.memory.recordEpisode({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        summary: summarize(text, finalText, [...usedTools]),
        outcome: "completed",
        toolsUsed: [...usedTools],
      });
      await this.memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        action: "task.completed",
        detail: { toolsUsed: [...usedTools], iterations: iteration, durationMs: Date.now() - startedAt },
      });
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      // PERF-002 · Se guarda la respuesta para reutilizarla. Solo si el turno
      // NO usó herramientas: repetir una respuesta que saltó un efecto (borrar,
      // enviar, escribir) volvería a saltarse ese efecto, y eso no es una
      // caché: es un cambio de comportamiento.
      //
      // Y NUNCA se cachea una negativa («no puedo buscar…»): caso real del
      // 2026-10-23. Al guardarse, esa negativa se convirtió en la respuesta
      // automática de todas las preguntas parecidas: el usuario recibía la
      // misma frase estúpida en lugar de una búsqueda real.
      if (usedTools.size === 0 && finalText.trim() && !looksLikeRefusal(finalText)) {
        void this.memory.cacheResponse(actor.userId, text, finalText).catch((error: Error) => {
          this.log("warn", "no se pudo cachear la respuesta", { err: error.message });
        });
      }
      change("COMPLETED", `en ${Date.now() - startedAt} ms`);
      change("IDLE");
      return { taskId, text: finalText };
    } catch (error) {
      if (error instanceof TaskInterruptedError || abort.signal.aborted) {
        change("INTERRUPTED", "cancelado por el usuario");
        this.emit({ type: "task.cancelled", sessionId: actor.sessionId, taskId, ts: new Date().toISOString() });
        this.emit({
          type: "voice.output_stopped",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          generationId: `voice:${taskId}`,
          reason: "interrupted",
          serverEpoch: 0,
        });
        await this.memory.raw.appendAudit({
          userId: actor.userId,
          sessionId: actor.sessionId,
          taskId,
          action: "task.cancelled",
          detail: { durationMs: Date.now() - startedAt },
        });
        change("IDLE");
        return { taskId, text: "" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.consecutiveFailures += 1;
      this.lastError = message;
      change("FAILED", message);
      this.emit({ type: "agent.error", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), message, recoverable: true });
      await this.memory.recordEpisode({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        summary: summarize(text, `ERROR: ${message}`, [...usedTools]),
        outcome: "failed",
        toolsUsed: [...usedTools],
      });
      await this.memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        action: "task.failed",
        detail: { error: message },
      });
      this.log("error", "turn failed", { taskId, error: message });
      change("IDLE");
      return { taskId, text: "" };
    }
  }

  /**
   * Ejecuta un turno de conversación en STREAMING.
   *
   * A diferencia de runTurn, este método no emite assistant.delta completo al final,
   * sino que llama al callback onDelta para cada fragmento del LLM, permitiendo
   * que el TTS comience a sintetizar inmediatamente (pipeline LLM -> TTS).
   */
  async runTurnStreaming(
    actor: Actor,
    text: string,
    taskId = crypto.randomUUID(),
    options: {
      disableThinking?: boolean;
      onDelta?: (delta: string) => void;
    } = {},
  ): Promise<{ taskId: string; text: string }> {
    const abort = new AbortController();
    const state = new AgentStateMachine("IDLE", (next, detail) => {
      this.emit({
        type: "assistant.state_changed",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        state: next,
        detail,
      });
    });
    this.tasks.set(taskId, { abort, state, sessionId: actor.sessionId, taskId });
    const startedAt = Date.now();

    try {
      return await this.enqueue(actor.sessionId, () =>
        this.executeTurnStreaming(actor, text, taskId, options, abort, state, startedAt),
      );
    } finally {
      this.tasks.delete(taskId);
      this.approvals.cancelTask(taskId);
    }
  }

  /**
   * Cuerpo del turno streaming: igual que executeTurn pero con callback onDelta
   * para enviar fragmentos al TTS en tiempo real.
   */
  private async executeTurnStreaming(
    actor: Actor,
    text: string,
    taskId: string,
    options: { disableThinking?: boolean; onDelta?: (delta: string) => void },
    abort: AbortController,
    state: AgentStateMachine,
    startedAt: number,
  ): Promise<{ taskId: string; text: string }> {
    const change = (next: Parameters<AgentStateMachine["set"]>[0], detail?: string) => {
      if (!state.canGo(next)) this.log("warn", "illegal state transition", { from: state.current, to: next, taskId });
      state.set(next, detail);
    };
    const usedTools = new Set<string>();
    const seenSignatures = new Set<string>();
    const scope: TurnScope = {
      actor,
      taskId,
      abort,
      seenSignatures,
      usedTools,
      startedAt,
      onState: change,
    };

    try {
      await this.memory.recordUserMessage({ userId: actor.userId, sessionId: actor.sessionId, taskId, text });

      // Caché semántica
      const cached = await this.memory.findSemanticMatch(actor.userId, text, SEMANTIC_CACHE_THRESHOLD);
      if (cached) {
        change("SPEAKING", "respuesta servida desde la caché");
        if (options.onDelta) options.onDelta(cached.response);
        this.emit({
          type: "assistant.delta",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          text: cached.response,
        });
        this.emit({
          type: "assistant.message_completed",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          text: cached.response,
        });
        await this.memory.recordAssistantMessage({
          userId: actor.userId,
          sessionId: actor.sessionId,
          taskId,
          text: cached.response,
        });
        this.log("info", "respuesta servida desde la caché", { taskId, hits: cached.hits });
        return { taskId, text: cached.response };
      }

      change("UNDERSTANDING", "recuperando contexto");

      const recall = await this.memory.recall(actor.userId, actor.sessionId, text);
      const memoryContext = this.memory.buildContextBlock(recall);
      const history = await this.buildHistory(actor.sessionId, taskId);
      const messages: ChatMessage[] = [
        { role: "system", content: memoryContext ? `${this.prompt}\n\n${memoryContext}` : this.prompt },
        ...history,
        { role: "user", content: text },
      ];

      const allTools = this.registry.toProviderTools();
      const wantedNames = new Set([
        ...this.intent.resolve(text).map((name) => this.registry.publishedNameOf(name)),
        ...this.intent.alwaysAvailable.map((name) => this.registry.publishedNameOf(name)),
      ]);
      let activeTools = this.fullCatalog
        ? allTools
        : wantedNames.size
        ? allTools.filter((tool) => wantedNames.has(tool.function.name))
        : [];
      let fallbackTried = false;
      let speechStarted = false;
      let finalText = "";
      let lastToolSummary = "";
      let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
      let iteration = 0;

      while (true) {
        this.assertNotAborted(abort);
        iteration += 1;
        if (iteration > this.limits.maxIterations) {
          finalText = `He alcanzado mi límite de ${this.limits.maxIterations} pasos sin cerrar la tarea. Esto es lo último que obtuve: ${finalText || "(sin contenido)"}`;
          break;
        }
        if (Date.now() - startedAt > this.limits.maxDurationMs) {
          finalText = `La tarea superó el presupuesto de ${Math.round(this.limits.maxDurationMs / 1000)} s. La detengo para no dejarla a medias.`;
          break;
        }

        change("PLANNING", activeTools.length ? "decidiendo si uso herramientas" : "respondiendo directamente");
        const composer = new ResponseComposer({
          holdChars: RESPONSE_HOLD_CHARS,
          holdMs: RESPONSE_HOLD_MS,
          onDelta: (chunk) => {
            this.emit({ type: "assistant.delta", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), text: chunk });
            if (options.onDelta) options.onDelta(chunk);
          },
          onFirstRelease: () => {
            if (speechStarted) return;
            speechStarted = true;
            this.emit({
              type: "voice.speaking.started",
              sessionId: actor.sessionId,
              taskId,
              ts: new Date().toISOString(),
              generationId: `voice:${taskId}`,
              text: finalText,
              serverEpoch: 0,
              serverAudio: true,
            });
          },
        });

        const result = await this.provider.stream(
          {
            messages,
            tools: activeTools.length ? activeTools : undefined,
            toolChoice: activeTools.length ? "auto" : undefined,
            signal: abort.signal,
            disableThinking: options.disableThinking,
          },
          (chunk) => {
            if (chunk.type === "delta") {
              composer.accept(chunk.text);
              if (options.onDelta) options.onDelta(chunk.text);
            }
          },
        );
        this.assertNotAborted(abort);
        composer.release();
        if (result.usage) usage = result.usage;
        if (result.reasoning && result.reasoning.trim()) {
          this.emit({
            type: "assistant.reasoning",
            sessionId: actor.sessionId,
            taskId,
            ts: new Date().toISOString(),
            text: result.reasoning.trim(),
          });
        }

        if (result.toolCalls.length === 0) {
          const content = (result.content || finalText).trim();
          if (isRawToolCall(content)) {
            finalText = lastToolSummary
              ? summariseToolOutput(lastToolSummary)
              : "La herramienta se invocó pero no devolvió información utilizable.";
          } else {
            finalText = content;
          }
          if (!this.fullCatalog && !fallbackTried && finalText && looksLikeRefusal(finalText)) {
            fallbackTried = true;
            this.log("info", "fallback conversacional: reintento con catálogo completo", { taskId });
            change("PLANNING", "la respuesta requiere datos; reintento");
            activeTools = allTools;
            const systemIndex = messages.findIndex((m) => m.role === "system");
            const systemMessage = systemIndex >= 0 ? messages[systemIndex] : undefined;
            if (systemMessage) {
              messages[systemIndex] = {
                role: "system",
                content: `${systemMessage.content ?? ""}\n\n${FALLBACK_NUDGE}`,
              };
            }
            finalText = "";
            continue;
          }
          break;
        }

        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        let budgetExceeded = false;
        for (const call of result.toolCalls) {
          if (seenSignatures.size >= this.limits.maxToolCalls) {
            budgetExceeded = true;
            break;
          }
          const toolMessage = await this.toolExecutor.execute(call, scope);
          messages.push(toolMessage);
          const last = toolMessage.content;
          if (typeof last === "string") lastToolSummary = last;
        }
        if (budgetExceeded) {
          finalText = `Detuve la ejecución tras ${this.limits.maxToolCalls} llamadas a herramientas para evitar un bucle.`;
          break;
        }
      }

      change("SPEAKING", "respuesta lista");
      if (finalText) {
        await this.memory.recordAssistantMessage({ userId: actor.userId, sessionId: actor.sessionId, taskId, text: finalText });
      }
      this.emit({
        type: "assistant.message_completed",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        text: finalText,
        usage,
      });
      const generationId = `voice:${taskId}`;
      if (finalText) {
        this.emit({
          type: "voice.output_started",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          generationId,
          text: finalText,
        });
      }
      this.emit({
        type: "voice.output_stopped",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        generationId,
        reason: "completed",
        serverEpoch: 0,
      });
      await this.memory.recordEpisode({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        summary: summarize(text, finalText, [...usedTools]),
        outcome: "completed",
        toolsUsed: [...usedTools],
      });
      await this.memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        action: "task.completed",
        detail: { toolsUsed: [...usedTools], iterations: iteration, durationMs: Date.now() - startedAt },
      });
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSuccessAt = new Date().toISOString();
      if (usedTools.size === 0 && finalText.trim() && !looksLikeRefusal(finalText)) {
        void this.memory.cacheResponse(actor.userId, text, finalText).catch((error: Error) => {
          this.log("warn", "no se pudo cachear la respuesta", { err: error.message });
        });
      }
      change("COMPLETED", `en ${Date.now() - startedAt} ms`);
      change("IDLE");
      return { taskId, text: finalText };
    } catch (error) {
      if (error instanceof TaskInterruptedError || abort.signal.aborted) {
        change("INTERRUPTED", "cancelado por el usuario");
        this.emit({ type: "task.cancelled", sessionId: actor.sessionId, taskId, ts: new Date().toISOString() });
        this.emit({
          type: "voice.output_stopped",
          sessionId: actor.sessionId,
          taskId,
          ts: new Date().toISOString(),
          generationId: `voice:${taskId}`,
          reason: "interrupted",
          serverEpoch: 0,
        });
        await this.memory.raw.appendAudit({
          userId: actor.userId,
          sessionId: actor.sessionId,
          taskId,
          action: "task.cancelled",
          detail: { durationMs: Date.now() - startedAt },
        });
        change("IDLE");
        return { taskId, text: "" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.consecutiveFailures += 1;
      this.lastError = message;
      change("FAILED", message);
      this.emit({ type: "agent.error", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), message, recoverable: true });
      await this.memory.recordEpisode({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        summary: summarize(text, `ERROR: ${message}`, [...usedTools]),
        outcome: "failed",
        toolsUsed: [...usedTools],
      });
      await this.memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        action: "task.failed",
        detail: { error: message },
      });
      this.log("error", "turn failed", { taskId, error: message });
      change("IDLE");
      return { taskId, text: "" };
    }
  }

  /** Falla si el turno ha sido cancelado. */
  private assertNotAborted(abort: AbortController): void {
    if (abort.signal.aborted) throw new TaskInterruptedError();
  }

  /** Historial conversacional que se inyecta en el prompt. */
  private async buildHistory(sessionId: string, excludeTaskId: string): Promise<ChatMessage[]> {
    const stored = await this.memory.raw.getMessages(sessionId, this.limits.maxHistoryMessages * 2);
    return stored
      .filter((message) => message.kind === "user" || message.kind === "assistant")
      .slice(-this.limits.maxHistoryMessages)
      .map((message) => ({ role: message.role, content: message.text }))
      .filter((message) => typeof message.content === "string" && message.content.length > 0) as ChatMessage[];
  }

  /**
   * Perceptual entry point: analyzes a single image through the vision model.
   * This is one-shot analysis, never continuous background capture.
   */
  async analyzeImage(actor: Actor, dataUrl: string, prompt?: string): Promise<string> {
    const taskId = crypto.randomUUID();
    const state = new AgentStateMachine("IDLE", (next, detail) => {
      this.emit({ type: "assistant.state_changed", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), state: next, detail });
    });
    state.set("UNDERSTANDING", "analizando imagen");
    state.set("PLANNING", "consulta al modelo de visión");
    try {
      const result = await this.provider.chat({
        model: this.visionModel(),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt ?? "Describe con precisión qué se ve en esta imagen. Si hay texto legible, transcríbelo. No inventes detalles que no puedas ver." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        maxTokens: 1024,
        temperature: 0.1,
      });
      const text = result.content.trim() || "El modelo de visión no devolvió contenido.";
      state.set("SPEAKING", "descripción lista");
      this.emit({ type: "assistant.message_completed", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), text, usage: result.usage });
      state.set("COMPLETED");
      state.set("IDLE");
      return text;
    } catch (error) {
      state.set("FAILED", error instanceof Error ? error.message : String(error));
      this.emit({ type: "agent.error", sessionId: actor.sessionId, taskId, ts: new Date().toISOString(), message: error instanceof Error ? error.message : String(error), recoverable: true });
      state.set("IDLE");
      throw error;
    }
  }

  /** Modelo de visión configurado en el proveedor. */
  private visionModel(): string {
    const provider = this.provider as AiProvider & { models?: { vision?: string } };
    return provider.models?.vision ?? "nvidia/nemotron-3.5-super-vl-120b-a12b";
  }
}

/** Resumen de un turno para la memoria episódica. */
function summarize(userText: string, assistantText: string, tools: string[]): string {
  const toolPart = tools.length ? ` Herramientas: ${tools.join(", ")}.` : " Sin herramientas.";
  return `Usuario: ${clip(userText, 220)} → JARVIS: ${clip(assistantText, 320)}${toolPart}`;
}

/** Recorta un texto a un máximo de caracteres. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
