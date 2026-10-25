import { create } from "zustand";
import type {
  AgentState,
  CapabilitiesResponse,
  ClientCommand,
  ComponentStatus,
  ConnectionState,
  HealthReport,
  RiskLevel,
  SessionRecord,
  StoredMessage,
  TokenUsage,
} from "../lib/events";
import { mergeComponentHealth } from "../lib/health";
import { createId } from "../lib/ids";
import { loadSettings, saveSettings, type JarvisSettings } from "./settings";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface UiMessage {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  streaming?: boolean;
  usage?: TokenUsage;
  name?: string;
  source?: "chat" | "voice" | "perception" | "system";
  /** Razonamiento que el modelo ha hecho público en este turno. */
  reasoning?: string;
}

export type ToolStatus =
  | "started"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "unavailable";

export interface ToolCard {
  toolCallId: string;
  name: string;
  risk: RiskLevel | null;
  args: unknown;
  status: ToolStatus;
  createdAt: string;
  summary?: string;
  error?: string;
  unavailable?: boolean;
  durationMs?: number;
  approvalId?: string;
  description?: string;
}

export type ThreadItem =
  | { kind: "message"; message: UiMessage }
  | { kind: "tool"; tool: ToolCard };

export type ActivityTone = "info" | "success" | "warn" | "error" | "voice" | "tool";

export interface ActivityItem {
  id: string;
  ts: string;
  kind: string;
  title: string;
  detail?: string;
  tone: ActivityTone;
  durationMs?: number;
  tokens?: number;
}

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  name: string;
  risk: RiskLevel;
  args: unknown;
  description: string;
  openedAt: string;
}

interface Metrics {
  messages: number;
  events: number;
  toolCalls: number;
  toolFailures: number;
}

interface JarvisState {
  health: HealthReport | null;
  healthLoading: boolean;
  healthError: string | null;
  capabilities: CapabilitiesResponse | null;
  capabilitiesLoading: boolean;
  capabilitiesError: string | null;
  session: SessionRecord | null;
  sessionLoading: boolean;
  sessionError: string | null;
  thread: ThreadItem[];
  activities: ActivityItem[];
  agentState: AgentState | null;
  agentDetail: string | null;
  currentTaskId: string | null;
  connection: ConnectionState;
  pendingApproval: PendingApproval | null;
  usage: TokenUsage;
  metrics: Metrics;
  settings: JarvisSettings;
  ttsSpeaking: boolean;
  sendCommand: (command: ClientCommand) => boolean;

  setConnection: (connection: ConnectionState) => void;
  setHealth: (health: HealthReport | null) => void;
  setHealthLoading: (loading: boolean) => void;
  setHealthError: (error: string | null) => void;
  applyHealthChange: (component: string, status: ComponentStatus, detail: string | undefined, ts: string) => void;
  setCapabilities: (capabilities: CapabilitiesResponse | null) => void;
  setCapabilitiesLoading: (loading: boolean) => void;
  setCapabilitiesError: (error: string | null) => void;
  beginSessionLoad: () => void;
  setSession: (session: SessionRecord | null) => void;
  setSessionError: (error: string | null) => void;
  setThreadFromHistory: (messages: StoredMessage[]) => void;
  addUserMessage: (text: string, source?: UiMessage["source"]) => void;
  appendAssistantDelta: (text: string) => void;
  appendAssistantReasoning: (text: string) => void;
  completeAssistantMessage: (text: string, usage?: TokenUsage) => void;
  addSystemMessage: (text: string, source?: UiMessage["source"]) => void;
  addToolStarted: (input: {
    toolCallId: string;
    name: string;
    args: unknown;
    risk: RiskLevel | null;
    ts: string;
  }) => void;
  addToolAwaitingApproval: (input: {
    toolCallId: string;
    name: string;
    args: unknown;
    risk: RiskLevel;
    approvalId: string;
    description: string;
    ts: string;
  }) => void;
  addToolCompleted: (input: {
    toolCallId: string;
    name: string;
    summary: string;
    durationMs: number;
    ts: string;
    data?: unknown;
  }) => void;
  addToolFailed: (input: {
    toolCallId: string;
    name: string;
    error: string;
    unavailable: boolean;
    ts: string;
  }) => void;
  resolveApproval: (approvalId: string, approve: boolean) => void;
  setPendingApproval: (approval: PendingApproval | null) => void;
  setAgentState: (state: AgentState | null, detail?: string | null) => void;
  setCurrentTask: (taskId: string | null) => void;
  recordActivity: (activity: Omit<ActivityItem, "id" | "ts"> & { ts?: string }) => void;
  addUsage: (usage: TokenUsage) => void;
  setTtsSpeaking: (speaking: boolean) => void;
  updateSettings: (patch: Partial<JarvisSettings>) => void;
  setSendCommand: (send: (command: ClientCommand) => boolean) => void;
}

const MAX_ACTIVITIES = 160;

function nowIso(): string {
  return new Date().toISOString();
}

function emptyUsage(): TokenUsage {
  return {};
}

function addUsageTotals(current: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    promptTokens: (current.promptTokens ?? 0) + (delta.promptTokens ?? 0),
    completionTokens: (current.completionTokens ?? 0) + (delta.completionTokens ?? 0),
    totalTokens: (current.totalTokens ?? 0) + (delta.totalTokens ?? 0),
  };
}

function historyToThread(messages: StoredMessage[]): ThreadItem[] {
  const sorted = [...messages].sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
  });

  return sorted.map<ThreadItem>((message) => {
    if (message.role === "tool") {
      return {
        kind: "tool",
        tool: {
          toolCallId: message.toolCallId ?? message.id,
          name: message.name ?? "tool",
          risk: null,
          args: undefined,
          status: "completed",
          createdAt: message.createdAt,
          summary: message.text,
        },
      };
    }
    const role: MessageRole =
      message.role === "user" || message.role === "assistant" || message.role === "system"
        ? message.role
        : "assistant";
    return {
      kind: "message",
      message: {
        id: message.id,
        role,
        text: message.text,
        createdAt: message.createdAt,
        name: message.name,
      },
    };
  });
}

function updateTool(
  thread: ThreadItem[],
  toolCallId: string,
  update: (tool: ToolCard) => ToolCard,
): ThreadItem[] {
  let found = false;
  const next = thread.map((item) => {
    if (item.kind === "tool" && item.tool.toolCallId === toolCallId) {
      found = true;
      return { kind: "tool" as const, tool: update(item.tool) };
    }
    return item;
  });
  return found ? next : thread;
}

export const useJarvisStore = create<JarvisState>((set, get) => ({
  health: null,
  healthLoading: false,
  healthError: null,
  capabilities: null,
  capabilitiesLoading: false,
  capabilitiesError: null,
  session: null,
  sessionLoading: false,
  sessionError: null,
  thread: [],
  activities: [],
  agentState: null,
  agentDetail: null,
  currentTaskId: null,
  connection: "connecting",
  pendingApproval: null,
  usage: emptyUsage(),
  metrics: { messages: 0, events: 0, toolCalls: 0, toolFailures: 0 },
  settings: loadSettings(),
  ttsSpeaking: false,
  sendCommand: () => false,

  setConnection: (connection) => set({ connection }),
  setHealth: (health) => set({ health }),
  setHealthLoading: (healthLoading) => set({ healthLoading }),
  setHealthError: (healthError) => set({ healthError }),
  applyHealthChange: (component, status, detail, ts) =>
    set((state) => ({ health: mergeComponentHealth(state.health, component, status, detail, ts) })),
  setCapabilities: (capabilities) => set({ capabilities }),
  setCapabilitiesLoading: (capabilitiesLoading) => set({ capabilitiesLoading }),
  setCapabilitiesError: (capabilitiesError) => set({ capabilitiesError }),

  beginSessionLoad: () => set({ sessionLoading: true, sessionError: null }),
  setSession: (session) => set({ session, sessionLoading: false }),
  setSessionError: (sessionError) => set({ sessionError, sessionLoading: false }),

  setThreadFromHistory: (messages) =>
    set({ thread: historyToThread(messages), metrics: { ...get().metrics, messages: messages.length } }),

  addUserMessage: (text, source = "chat") =>
    set((state) => ({
      thread: [
        ...state.thread,
        {
          kind: "message",
          message: {
            id: createId("msg"),
            role: "user",
            text,
            createdAt: nowIso(),
            source,
          },
        },
      ],
      metrics: { ...state.metrics, messages: state.metrics.messages + 1 },
    })),

  appendAssistantDelta: (text) =>
    set((state) => {
      const last = state.thread[state.thread.length - 1];
      if (last && last.kind === "message" && last.message.role === "assistant" && last.message.streaming) {
        const updated: ThreadItem = {
          kind: "message",
          message: { ...last.message, text: last.message.text + text },
        };
        return { thread: [...state.thread.slice(0, -1), updated] };
      }
      return {
        thread: [
          ...state.thread,
          {
            kind: "message",
            message: {
              id: createId("msg"),
              role: "assistant",
              text,
              createdAt: nowIso(),
              streaming: true,
            },
          },
        ],
        metrics: { ...state.metrics, messages: state.metrics.messages + 1 },
      };
    }),

  appendAssistantReasoning: (text) =>
    set((state) => {
      const last = state.thread[state.thread.length - 1];
      if (last && last.kind === "message" && last.message.role === "assistant") {
        const updated: ThreadItem = {
          kind: "message",
          message: { ...last.message, reasoning: (last.message.reasoning ?? "") + text },
        };
        return { thread: [...state.thread.slice(0, -1), updated] };
      }
      // El modelo puede razonar sin emitir contenido (p. ej. antes de llamar a
      // una herramienta): se abre el mensaje para que el razonamiento no se
      // pierda.
      return {
        thread: [
          ...state.thread,
          {
            kind: "message",
            message: {
              id: createId("msg"),
              role: "assistant",
              text: "",
              createdAt: nowIso(),
              streaming: true,
              reasoning: text,
            },
          },
        ],
        metrics: { ...state.metrics, messages: state.metrics.messages + 1 },
      };
    }),

  completeAssistantMessage: (text, usage) =>
    set((state) => {
      const lastIndex = state.thread.length - 1;
      const last = state.thread[lastIndex];
      let thread = state.thread;
      let created = false;

      if (last && last.kind === "message" && last.message.role === "assistant") {
        const updated: ThreadItem = {
          kind: "message",
          message: { ...last.message, text, streaming: false, usage: usage ?? last.message.usage },
        };
        thread = [...state.thread.slice(0, -1), updated];
      } else {
        created = true;
        thread = [
          ...state.thread,
          {
            kind: "message",
            message: {
              id: createId("msg"),
              role: "assistant",
              text,
              createdAt: nowIso(),
              usage,
            },
          },
        ];
      }

      return {
        thread,
        metrics: created
          ? { ...state.metrics, messages: state.metrics.messages + 1 }
          : state.metrics,
      };
    }),

  addSystemMessage: (text, source = "system") =>
    set((state) => ({
      thread: [
        ...state.thread,
        {
          kind: "message",
          message: { id: createId("msg"), role: "system", text, createdAt: nowIso(), source },
        },
      ],
    })),

  addToolStarted: ({ toolCallId, name, args, risk, ts }) => {
    set((state) => {
      const exists = state.thread.some(
        (item) => item.kind === "tool" && item.tool.toolCallId === toolCallId,
      );
      if (exists) {
        return {
          thread: updateTool(state.thread, toolCallId, (tool) => ({
            ...tool,
            status: "started",
            args,
            risk,
            name,
          })),
        };
      }
      return {
        thread: [
          ...state.thread,
          {
            kind: "tool",
            tool: {
              toolCallId,
              name,
              args,
              risk,
              status: "started",
              createdAt: ts,
            },
          },
        ],
        metrics: { ...state.metrics, toolCalls: state.metrics.toolCalls + 1 },
      };
    });
  },

  addToolAwaitingApproval: ({ toolCallId, name, args, risk, approvalId, description, ts }) =>
    set((state) => {
      const exists = state.thread.some(
        (item) => item.kind === "tool" && item.tool.toolCallId === toolCallId,
      );
      const tool: ToolCard = {
        toolCallId,
        name,
        args,
        risk,
        status: "awaiting_approval",
        createdAt: ts,
        approvalId,
        description,
      };
      return {
        thread: exists
          ? updateTool(state.thread, toolCallId, (current) => ({ ...current, ...tool }))
          : [...state.thread, { kind: "tool", tool }],
        metrics: exists
          ? state.metrics
          : { ...state.metrics, toolCalls: state.metrics.toolCalls + 1 },
        pendingApproval: {
          approvalId,
          toolCallId,
          name,
          risk,
          args,
          description,
          openedAt: ts,
        },
      };
    }),

  addToolCompleted: ({ toolCallId, name, summary, durationMs, ts, data }) =>
    set((state) => {
      const exists = state.thread.some(
        (item) => item.kind === "tool" && item.tool.toolCallId === toolCallId,
      );
      if (exists) {
        return {
          thread: updateTool(state.thread, toolCallId, (tool) => ({
            ...tool,
            name,
            status: "completed",
            summary,
            durationMs,
            args: tool.args ?? data,
          })),
        };
      }
      return {
        thread: [
          ...state.thread,
          {
            kind: "tool",
            tool: {
              toolCallId,
              name,
              risk: null,
              args: data,
              status: "completed",
              createdAt: ts,
              summary,
              durationMs,
            },
          },
        ],
        metrics: { ...state.metrics, toolCalls: state.metrics.toolCalls + 1 },
      };
    }),

  addToolFailed: ({ toolCallId, name, error, unavailable, ts }) =>
    set((state) => {
      const exists = state.thread.some(
        (item) => item.kind === "tool" && item.tool.toolCallId === toolCallId,
      );
      const status: ToolStatus = unavailable ? "unavailable" : "failed";
      if (exists) {
        return {
          thread: updateTool(state.thread, toolCallId, (tool) => ({
            ...tool,
            name,
            status,
            error,
            unavailable,
          })),
          metrics: { ...state.metrics, toolFailures: state.metrics.toolFailures + 1 },
        };
      }
      return {
        thread: [
          ...state.thread,
          {
            kind: "tool",
            tool: {
              toolCallId,
              name,
              risk: null,
              args: undefined,
              status,
              createdAt: ts,
              error,
              unavailable,
            },
          },
        ],
        metrics: {
          ...state.metrics,
          toolCalls: state.metrics.toolCalls + 1,
          toolFailures: state.metrics.toolFailures + 1,
        },
      };
    }),

  resolveApproval: (approvalId, approve) =>
    set((state) => {
      const pending = state.pendingApproval;
      if (!pending || pending.approvalId !== approvalId) return {};
      return {
        pendingApproval: null,
        thread: updateTool(state.thread, pending.toolCallId, (tool) => ({
          ...tool,
          status: approve ? "approved" : "rejected",
        })),
      };
    }),

  setPendingApproval: (pendingApproval) => set({ pendingApproval }),
  setAgentState: (agentState, agentDetail = null) => set({ agentState, agentDetail }),
  setCurrentTask: (currentTaskId) => set({ currentTaskId }),

  recordActivity: (activity) =>
    set((state) => {
      const item: ActivityItem = {
        id: createId("act"),
        ts: activity.ts ?? nowIso(),
        kind: activity.kind,
        title: activity.title,
        detail: activity.detail,
        tone: activity.tone,
        durationMs: activity.durationMs,
        tokens: activity.tokens,
      };
      return {
        activities: [item, ...state.activities].slice(0, MAX_ACTIVITIES),
        metrics: { ...state.metrics, events: state.metrics.events + 1 },
      };
    }),

  addUsage: (usage) => set((state) => ({ usage: addUsageTotals(state.usage, usage) })),
  setTtsSpeaking: (ttsSpeaking) => set({ ttsSpeaking }),

  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings, ...patch };
      saveSettings(settings);
      return { settings };
    }),

  setSendCommand: (sendCommand) => set({ sendCommand }),
}));

export function resetForNewSession(): void {
  useJarvisStore.setState({
    thread: [],
    activities: [],
    pendingApproval: null,
    agentState: null,
    agentDetail: null,
    currentTaskId: null,
    usage: emptyUsage(),
    metrics: { messages: 0, events: 0, toolCalls: 0, toolFailures: 0 },
    ttsSpeaking: false,
    // La sesión anterior se invalida: mantenerla permitía al cliente seguir
    // conectado al websocket del usuario previo durante la recarga.
    session: null,
    sessionError: null,
  });
}
