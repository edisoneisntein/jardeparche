import type { AgentState } from "@jarvis/shared";
import { canTransition } from "@jarvis/shared";

export type StateListener = (next: AgentState, detail?: string) => void;

/**
 * Thin, explicit wrapper around the shared transition table. It never invents
 * activity: the runtime only calls `set` when a real step begins or ends.
 */
export class AgentStateMachine {
  private state: AgentState;
  private readonly listener: StateListener;
  readonly history: Array<{ state: AgentState; detail?: string; at: string }> = [];

  constructor(initial: AgentState = "IDLE", listener: StateListener = () => {}) {
    this.state = initial;
    this.listener = listener;
    this.history.push({ state: initial, at: new Date().toISOString() });
  }

  get current(): AgentState {
    return this.state;
  }

  canGo(next: AgentState): boolean {
    return this.state === next || canTransition(this.state, next);
  }

  set(next: AgentState, detail?: string): void {
    if (next === this.state) return;
    this.state = next;
    this.history.push({ state: next, detail, at: new Date().toISOString() });
    this.listener(next, detail);
  }
}
