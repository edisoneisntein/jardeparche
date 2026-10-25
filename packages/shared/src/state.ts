import { z } from "zod";

/**
 * Explicit agent state machine. Transitions must be driven by real runtime
 * events — never by decorative timers.
 */
export const AGENT_STATES = [
  "IDLE",
  "LISTENING",
  "UNDERSTANDING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "EXECUTING",
  "SPEAKING",
  "INTERRUPTED",
  "COMPLETED",
  "FAILED",
] as const;

export const AgentStateSchema = z.enum(AGENT_STATES);
export type AgentState = z.infer<typeof AgentStateSchema>;

/**
 * Legal transitions. A transition outside this map is a bug and the runtime
 * must reject it (and surface it in the audit log).
 */
export const AGENT_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  IDLE: ["LISTENING", "UNDERSTANDING", "FAILED"],
  LISTENING: ["UNDERSTANDING", "INTERRUPTED", "IDLE", "FAILED"],
  UNDERSTANDING: ["PLANNING", "SPEAKING", "INTERRUPTED", "FAILED"],
  PLANNING: ["EXECUTING", "WAITING_FOR_APPROVAL", "SPEAKING", "UNDERSTANDING", "INTERRUPTED", "FAILED"],
  WAITING_FOR_APPROVAL: ["EXECUTING", "INTERRUPTED", "COMPLETED", "FAILED"],
  EXECUTING: ["PLANNING", "UNDERSTANDING", "SPEAKING", "INTERRUPTED", "COMPLETED", "FAILED"],
  SPEAKING: ["IDLE", "COMPLETED", "INTERRUPTED", "LISTENING", "FAILED"],
  INTERRUPTED: ["IDLE", "LISTENING", "UNDERSTANDING", "FAILED"],
  COMPLETED: ["IDLE", "LISTENING", "UNDERSTANDING", "FAILED"],
  FAILED: ["IDLE", "LISTENING", "UNDERSTANDING"],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}
