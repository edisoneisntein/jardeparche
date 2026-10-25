/**
 * Contratos del orquestador de turnos (el núcleo de `Jarvis.main`).
 *
 * Este módulo no tiene dependencias de infraestructura: solo tipos. Su razón
 * de existir es la INVERSIÓN DE DEPENDENCIAS: el runtime depende de
 * contratos mínimos (emisor, ejecutor de tools, resolutor de intención) y no
 * de implementaciones concretas, de forma que cada pieza se puede sustituir
 * por un doble de prueba sin tocar el núcleo.
 *
 * Reglas:
 *   - ISP: cada interfaz expone lo mínimo que su consumidor necesita.
 *   - DIP: los colaboradores se inyectan; el runtime no los construye.
 *   - LSP: cualquier implementación que cumpla el contrato es intercambiable.
 */
import type { AgentState, ChatMessage, ServerEvent, ToolDefinition } from "@jarvis/shared";
import type { ProviderToolCall } from "@jarvis/ai-provider";

/** Niveles de log admitidos por el runtime. */
export type LogLevel = "info" | "warn" | "error";

/**
 * Función de log estructurado.
 *
 * Args:
 *   level: Severidad.
 *   message: Mensaje estable (sin datos del usuario).
 *   meta: Campos estructurados (ids, duraciones, errores).
 */
export type LogFn = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

/** Publica un evento de servidor hacia el HUD, la voz y el cliente. */
export type EmitFn = (event: ServerEvent) => void;

/**
 * Identidad del interlocutor de un turno.
 *
 * `userId` es la identidad estable (datos, memoria, herramientas) y
 * `sessionId` es el hilo conversacional (historial, aprobaciones).
 */
export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
}

/** Techos de un turno: iteraciones, llamadas, duración e historial. */
export interface AgentLimits {
  /** Iteraciones máximas del bucle del agente. */
  maxIterations: number;
  /** Llamadas a herramientas máximas por turno. */
  maxToolCalls: number;
  /** Presupuesto de reloj del turno, en ms. */
  maxDurationMs: number;
  /** Mensajes de historial que se inyectan en el prompt. */
  maxHistoryMessages: number;
}

/**
 * Estado compartido de un turno en curso.
 *
 * Es el contexto mínimo que necesita el ejecutor de herramientas: quién
 * pregunta, qué turno es, cómo se cancela, qué llamadas ya se hicieron y cómo
 * se notifican los cambios de estado.
 */
export interface TurnScope {
  /** Quién inicia el turno. */
  readonly actor: Actor;
  /** Identificador único del turno. */
  readonly taskId: string;
  /** Señal de cancelación del turno. */
  readonly abort: AbortController;
  /** Firmas de las llamadas ya ejecutadas (anti-bucle). */
  readonly seenSignatures: Set<string>;
  /** Nombres de las tools efectivamente usadas. */
  readonly usedTools: Set<string>;
  /** Reloj de referencia del turno (milisegundos epoch). */
  readonly startedAt: number;
  /** Notifica un cambio de estado del agente. */
  onState(state: AgentState, detail?: string): void;
}

/**
 * Resuelve la intención del usuario al conjunto de herramientas candidatas.
 *
 * Implementaciones: `IntentToolResolver` (basada en señales léxicas) y
 * cualquier clasificador futuro (semántico, por modelo): el runtime no
 * conoce el algoritmo.
 */
export interface ToolIntentResolver {
  /** Nombres reales de las tools que encajan con el texto del usuario. */
  resolve(text: string): readonly string[];
  /** Tools que siempre se ofrecen (investigación web). */
  readonly alwaysAvailable: readonly string[];
}

/**
 * Ejecuta una llamada de herramienta de forma segura, auditada y cancelable.
 */
export interface ToolCallExecutor {
  /**
   * Ejecuta una llamada y devuelve el mensaje de rol `tool` que vuelve al
   * modelo.
   *
   * Args:
   *     call: Llamada emitida por el modelo.
   *     scope: Estado del turno.
   *
   * Returns:
   *     Mensaje `tool` con el resultado serializado.
   */
  execute(call: ProviderToolCall, scope: TurnScope): Promise<ChatMessage>;
}

/**
 * Política de aprobación: decide si una tool exige confirmación humana.
 *
 * Es un contrato, no una constante: el nivel de garantía depende del
 * despliegue, no del código.
 */
export interface ApprovalPolicy {
  /**
   * Args:
   *   tool: Tool evaluada.
   *
   * Returns:
   *   `true` si la tool NO puede ejecutarse sin confirmación humana.
   */
  requiresHumanApproval(tool: ToolDefinition): boolean;
}
