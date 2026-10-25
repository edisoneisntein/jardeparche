import { z } from "zod";

/** Risk tiers drive the authorization policy. */
export const RISK_LEVELS = ["public_read", "local_reversible", "external_effect", "destructive"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  /** Machine readable payload actually produced by the tool. */
  data: z.unknown().optional(),
  /** Human readable summary shown in the HUD. */
  summary: z.string(),
  /** True when the tool could not run because it is not configured. */
  unavailable: z.boolean().default(false),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface ToolContext {
  userId: string;
  sessionId: string;
  taskId: string;
  /** Correlates every side effect with a single conversation turn. */
  correlationId: string;
  now: () => Date;
  /**
   * Señal de cancelación del turno. Las tools de red deben propagarla a su
   * `fetch` para que la conexión se corte en cuanto el usuario interrumpe o
   * vence el presupuesto de la tarea. Opcional para no romper tools existentes.
   */
  signal?: AbortSignal;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  title: string;
  description: string;
  risk: RiskLevel;
  /** JSON Schema for the model, already in OpenAI tool format. */
  parameters: Record<string, unknown>;
  /** Validates raw model arguments into a typed input. */
  parse: (raw: unknown) => Input;
  /** Hard upper bound enforced by the executor, in ms. */
  timeoutMs: number;
  /** Whether the runtime must obtain explicit user approval before executing. */
  requiresApproval: boolean;
  /** Detects missing configuration/credentials without performing the action. */
  availability: () => { available: boolean; reason?: string };
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCallRecord {
  id: string;
  taskId: string;
  sessionId: string;
  userId: string;
  name: string;
  arguments: unknown;
  status: "started" | "awaiting_approval" | "completed" | "failed" | "denied" | "unavailable";
  result?: ToolResult;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}
