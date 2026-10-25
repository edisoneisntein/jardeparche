/**
 * Ejecución segura de herramientas.
 *
 * Antes de la refactorización, la ejecución de tools (validación, anti-bucle,
 * disponibilidad, aprobación, auditoría, eventos) estaba incrustada en la
 * clase `AgentRuntime`: 180 líneas de unGod Object que mezclaban política de
 * seguridad con el bucle del agente. Aquí vive como un colaborador con
 * contrato (`ToolCallExecutor`), con sus propias dependencias inyectadas.
 *
 * Garantías:
 *   - Fail-closed: una tool que exige aprobación no se ejecuta sin un token
 *     firmado válido (lo verifica el registro).
 *   - Anti-bucle: una llamada idéntica repetida no se ejecuta dos veces.
 *   - Auditoría: toda llamada deja rastro (inicio, resultado, error).
 *   - Aislamiento de fallos: un error de tool NO tumba el turno; se devuelve
 *     al modelo como resultado fallido y la degradación es explícita.
 */
import type { ChatMessage, ToolDefinition, ToolResult } from "@jarvis/shared";
import type { ProviderToolCall } from "@jarvis/ai-provider";
import type { MemoryService } from "@jarvis/memory";
import type { ToolRegistry } from "@jarvis/tool-registry";
import type { ApprovalBroker } from "./approval-broker.js";
import type { ApprovalPolicy, EmitFn, LogFn, TurnScope } from "./contracts.js";

export interface ToolExecutorDeps {
  /** Registro: única vía autorizada para ejecutar efectos. */
  readonly registry: ToolRegistry;
  /** Memoria: persistencia de resultados y auditoría. */
  readonly memory: MemoryService;
  /** Broker de aprobaciones humanas. */
  readonly approvals: ApprovalBroker;
  /** Política de aprobación vigente. */
  readonly policy: ApprovalPolicy;
  /** Publica eventos hacia el cliente. */
  readonly emit: EmitFn;
  /** Log estructurado. */
  readonly log: LogFn;
}

/**
 * Ejecutor de llamadas a herramientas.
 *
 * Implementa `ToolCallExecutor`: el runtime lo consume sin saber cómo se
 * autoriza, cómo se audita ni cómo se registra el resultado.
 */
export class ToolCallExecutorImpl {
  constructor(private readonly deps: ToolExecutorDeps) {}

  /**
   * Ejecuta una llamada y devuelve el mensaje de rol `tool`.
   *
   * Nunca lanza por un fallo de la herramienta: esos fallos se convierten en
   * un resultado `ok: false` que el modelo puede leer y el agente puede
   * narrar. Solo lanza si el propio runtime está roto (memoria caída).
   *
   * Args:
   *   call: Llamada emitida por el modelo.
   *   scope: Estado del turno.
   *
   * Returns:
   *   Mensaje `tool` con el resultado serializado.
   */
  async execute(call: ProviderToolCall, scope: TurnScope): Promise<ChatMessage> {
    const { registry, memory, approvals, emit, log } = this.deps;
    const { actor, taskId, abort } = scope;
    const tool = registry.get(call.name);
    const now = new Date().toISOString();

    if (!tool) {
      emit({
        type: "tool.failed",
        sessionId: actor.sessionId,
        taskId,
        ts: now,
        toolCallId: call.id,
        name: call.name,
        error: "unknown_tool",
        unavailable: true,
      });
      return toolMessage(call, { ok: false, error: "unknown_tool" });
    }

    // El modelo escribe el nombre seguro del proveedor; todo lo de abajo usa
    // el nombre real.
    const resolved: ProviderToolCall = { ...call, name: tool.name };
    const name = resolved.name;

    let parsedArguments: unknown;
    try {
      parsedArguments = tool.parse(parseArguments(call.arguments));
    } catch (error) {
      const message = `argumentos inválidos: ${(error as Error).message}`;
      emit({
        type: "tool.failed",
        sessionId: actor.sessionId,
        taskId,
        ts: now,
        toolCallId: call.id,
        name,
        error: message,
        unavailable: false,
      });
      await memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        correlationId: call.id,
        action: "tool.rejected",
        risk: tool.risk,
        toolCallId: call.id,
        detail: { arguments: call.arguments, error: message },
      });
      return toolMessage(call, { ok: false, error: message });
    }

    // Anti-bucle: la misma llamada con los mismos argumentos, dos veces, es un
    // bucle del modelo. No se ejecuta y se le dice por qué.
    const signature = `${name}:${JSON.stringify(parsedArguments)}`;
    if (scope.seenSignatures.has(signature)) {
      const message = "llamada repetida idéntica detectada; evito el bucle";
      emit({
        type: "tool.failed",
        sessionId: actor.sessionId,
        taskId,
        ts: now,
        toolCallId: call.id,
        name,
        error: message,
        unavailable: false,
      });
      return toolMessage(call, { ok: false, error: message });
    }
    scope.seenSignatures.add(signature);
    scope.usedTools.add(name);

    // Disponibilidad: se consulta la INSTANTÁNEA del registro (sin E/S en el
    // camino caliente) para no repetir el sondeo en cada capa.
    const availability = registry.availabilityOf(name);
    if (!availability.available) {
      const result: ToolResult = {
        ok: false,
        summary: `${tool.title} no está disponible: ${availability.reason ?? "no configurada"}`,
        unavailable: true,
        error: "not_configured",
      };
      await this.recordOutcome(scope, resolved, tool.risk, result, 0);
      return toolMessage(call, result);
    }

    const approvalToken = await this.authorize(scope, call, tool, parsedArguments);
    if (approvalToken === DENIED) {
      const result: ToolResult = {
        ok: false,
        summary: "Acción rechazada o expirada: no ejecuté nada.",
        unavailable: false,
        error: "aprobación rechazada o expirada",
      };
      await this.recordOutcome(scope, resolved, tool.risk, result, 0);
      return toolMessage(call, result);
    }

    scope.onState("EXECUTING", `ejecutando ${tool.name}`);
    emit({
      type: "tool.started",
      sessionId: actor.sessionId,
      taskId,
      ts: new Date().toISOString(),
      toolCallId: call.id,
      name,
      arguments: parsedArguments,
      risk: tool.risk,
    });
    const startedAt = Date.now();

    let result: ToolResult;
    try {
      result = await registry.execute(
        name,
        parsedArguments,
        {
          userId: actor.userId,
          sessionId: actor.sessionId,
          taskId,
          correlationId: call.id,
          now: () => new Date(),
          // La señal del turno: las tools de red cortan su fetch en cuanto el
          // usuario interrumpe o vence el presupuesto de la tarea.
          signal: abort.signal,
        },
        approvalToken,
      );
    } catch (error) {
      // Un fallo de la tool NO es un fallo del turno: se degrada a resultado
      // y el agente puede reintentar con otra vía.
      const detail = error instanceof Error ? error.message : String(error);
      log("warn", "tool execution failed", { tool: name, taskId, error: detail });
      result = { ok: false, summary: `La herramienta falló: ${detail}`, unavailable: false, error: "execution_error" };
    }
    const durationMs = Date.now() - startedAt;
    await this.recordOutcome(scope, resolved, tool.risk, result, durationMs);
    return toolMessage(call, result);
  }

  /**
   * Autoriza (o no) la ejecución de una tool con efectos.
   *
   * @returns El token firmado, o `DENIED` si el usuario rechazó o expiró.
   */
  private async authorize(
    scope: TurnScope,
    call: ProviderToolCall,
    tool: ToolDefinition,
    parsedArguments: unknown,
  ): Promise<string | undefined | typeof DENIED> {
    const { approvals, emit, memory } = this.deps;
    const { actor, taskId, abort } = scope;
    if (!tool.requiresApproval) return undefined;

    if (this.deps.policy.requiresHumanApproval(tool)) {
      scope.onState("WAITING_FOR_APPROVAL", `esperando confirmación para ${tool.name}`);
      const approval = await approvals.request({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        toolCallId: call.id,
        toolName: tool.name,
        arguments: parsedArguments,
        risk: tool.risk,
        description: `Ejecutar ${tool.title} (${tool.risk}) con los argumentos indicados.`,
      });
      emit({
        type: "tool.awaiting_approval",
        sessionId: actor.sessionId,
        taskId,
        ts: new Date().toISOString(),
        toolCallId: call.id,
        name: tool.name,
        arguments: parsedArguments,
        risk: tool.risk,
        approvalId: approval.id,
        description: approval.description,
      });
      await memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        correlationId: call.id,
        action: "tool.approval_requested",
        risk: tool.risk,
        toolCallId: call.id,
        detail: { approvalId: approval.id, arguments: parsedArguments },
      });
      const approved = await approvals.wait(approval.id, taskId, abort.signal);
      await memory.raw.appendAudit({
        userId: actor.userId,
        sessionId: actor.sessionId,
        taskId,
        correlationId: call.id,
        action: approved ? "tool.approved" : "tool.denied",
        risk: tool.risk,
        toolCallId: call.id,
        detail: { approvalId: approval.id },
      });
      if (!approved) return DENIED;
      // El usuario aprobó: el broker firma el token de esta llamada.
      return approvals.tokenFor(approval.id);
    }

    // Auto-aprobación: NO es un bypass. Se emite un token con `mode: "auto"`,
    // igualmente ligado a tool, argumentos y sesión, y igualmente auditado.
    await memory.raw.appendAudit({
      userId: actor.userId,
      sessionId: actor.sessionId,
      taskId,
      correlationId: call.id,
      action: "tool.auto_approved",
      risk: tool.risk,
      toolCallId: call.id,
      detail: { name: tool.name, note: "aprobación automática por política" },
    });
    return approvals.signAutoApproval({
      userId: actor.userId,
      sessionId: actor.sessionId,
      taskId,
      toolCallId: call.id,
      toolName: tool.name,
      arguments: parsedArguments,
      risk: tool.risk,
      description: `Ejecutar ${tool.title} (${tool.risk}) con los argumentos indicados.`,
    });
  }

  /** Persiste el resultado de la tool y publica los eventos correspondientes. */
  private async recordOutcome(
    scope: TurnScope,
    call: ProviderToolCall,
    risk: string,
    result: ToolResult,
    durationMs: number,
  ): Promise<void> {
    const { memory, emit } = this.deps;
    const { actor, taskId } = scope;
    const now = new Date().toISOString();
    await memory.recordToolMessage({
      userId: actor.userId,
      sessionId: actor.sessionId,
      taskId,
      toolCallId: call.id,
      name: call.name,
      result,
    });
    await memory.raw.recordToolCall({
      id: call.id,
      taskId,
      sessionId: actor.sessionId,
      userId: actor.userId,
      name: call.name,
      arguments: call.arguments,
      status: result.ok ? "completed" : result.unavailable ? "unavailable" : "failed",
      result,
      startedAt: new Date(Date.now() - durationMs).toISOString(),
      finishedAt: now,
      durationMs,
    });
    await memory.raw.appendAudit({
      userId: actor.userId,
      sessionId: actor.sessionId,
      taskId,
      correlationId: call.id,
      action: result.ok ? "tool.completed" : "tool.failed",
      risk,
      toolCallId: call.id,
      detail: { summary: result.summary, error: result.error, durationMs },
    });
    if (result.ok) {
      emit({
        type: "tool.completed",
        sessionId: actor.sessionId,
        taskId,
        ts: now,
        toolCallId: call.id,
        name: call.name,
        summary: result.summary,
        data: result.data,
        durationMs,
      });
    } else {
      emit({
        type: "tool.failed",
        sessionId: actor.sessionId,
        taskId,
        ts: now,
        toolCallId: call.id,
        name: call.name,
        error: result.error ?? result.summary,
        unavailable: result.unavailable,
      });
    }
    scope.onState("PLANNING", "incorporando resultado de la herramienta");
  }
}

/** Marca interna: el usuario rechazó la aprobación. */
const DENIED = Symbol("approval-denied");

/** Construye el mensaje de rol `tool` que vuelve al modelo. */
function toolMessage(call: ProviderToolCall, payload: unknown): ChatMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.name,
    content: JSON.stringify(payload),
  };
}

/** Convierte los argumentos crudos del modelo en JSON validable. */
function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`no es JSON válido: ${trimmed.slice(0, 120)}`);
  }
}
