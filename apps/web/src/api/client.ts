import type {
  CapabilitiesResponse,
  HealthReport,
  PerceptionAnalyzeResponse,
  SessionRecord,
  StoredMessage,
} from "../lib/events";

const REQUEST_TIMEOUT_MS = 15_000;

// URL por defecto de la API: sigue el host de la página (funciona igual al
// abrirla por localhost que por la IP de la red local). Puerto fijo 8787.
// El protocolo se hereda de la página para que el modo HTTPS (`pnpm dev:https`)
// no mezcle contenido: la página y la API deben hablar el mismo protocolo.
function defaultApiBase(): string {
  if (typeof window !== "undefined" && window.location?.hostname) {
    const protocol = window.location.protocol === "https:" ? "https:" : "http:";
    return `${protocol}//${window.location.hostname}:8787`;
  }
  return "http://localhost:8787";
}

// Se puede forzar con VITE_API_URL; si está vacío o no existe, se deriva del host.
export const API_BASE = (import.meta.env.VITE_API_URL || defaultApiBase()).replace(/\/+$/, "");

const ACCESS_TOKEN = import.meta.env.VITE_JARVIS_TOKEN ?? "";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  return ACCESS_TOKEN ? { "x-jarvis-token": ACCESS_TOKEN } : {};
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string; message?: string };
        if (payload.error) message = payload.error;
        else if (payload.message) message = payload.message;
      } catch {
        const text = await response.text().catch(() => "");
        if (text) message = text.slice(0, 200);
      }
      throw new ApiError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(408, "Tiempo de espera agotado al contactar el backend");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getHealth(): Promise<HealthReport> {
  return request<HealthReport>("/api/health");
}

export function getCapabilities(): Promise<CapabilitiesResponse> {
  return request<CapabilitiesResponse>("/api/capabilities");
}

/** Métricas reales del servidor (no contadores locales del cliente). */
export interface ServerMetrics {
  counters: Record<string, number>;
  timings: Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number }>;
  collectedAt: string;
  hubConnections: number;
  activeTasks: number;
}

export function getMetrics(): Promise<ServerMetrics> {
  return request<ServerMetrics>("/api/metrics");
}

/** Usuarios que el servidor autoriza realmente. */
export function getUsers(): Promise<{ users: string[] }> {
  return request<{ users: string[] }>("/api/users");
}

export function getSessions(userId: string): Promise<SessionRecord[]> {
  return request<SessionRecord[]>(`/api/sessions?userId=${encodeURIComponent(userId)}`);
}

export function createSession(input: { userId: string; title?: string }): Promise<SessionRecord> {
  return postJson<SessionRecord>("/api/sessions", input);
}

export function getSessionMessages(sessionId: string): Promise<StoredMessage[]> {
  return request<StoredMessage[]>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
}

export function analyzeImage(input: {
  sessionId: string;
  dataUrl: string;
  prompt?: string;
  cameraActive: boolean;
}): Promise<PerceptionAnalyzeResponse> {
  return postJson<PerceptionAnalyzeResponse>("/api/perception/analyze", input);
}

export function buildWebSocketUrl(sessionId: string, userId: string): string {
  const url = new URL(`${API_BASE}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("userId", userId);
  if (ACCESS_TOKEN) url.searchParams.set("token", ACCESS_TOKEN);
  return url.toString();
}
