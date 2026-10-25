import type { ChatMessage, ToolCallRecord } from "@jarvis/shared";

export interface SessionRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface StoredMessage extends ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  taskId?: string;
  createdAt: string;
  /** true when the message is a tool result rather than user/assistant text */
  kind: "user" | "assistant" | "tool" | "system" | "summary";
  /** redacted searchable text */
  text: string;
}

export interface EpisodicMemoryRecord {
  id: string;
  userId: string;
  sessionId?: string;
  taskId?: string;
  summary: string;
  outcome: "completed" | "failed" | "cancelled";
  toolsUsed: string[];
  createdAt: string;
}

export interface SemanticMemoryRecord {
  id: string;
  userId: string;
  key: string;
  value: string;
  /** only ever set from explicit user authorization */
  source: "explicit_user" | "user_document";
  createdAt: string;
  updatedAt: string;
  /** present when embeddings are enabled */
  embedding?: number[];
  /** cosine similarity, only populated by search */
  score?: number;
}

export interface TaskRecord {
  id: string;
  userId: string;
  title: string;
  notes?: string;
  status: "open" | "done";
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  userId: string;
  sessionId?: string;
  taskId?: string;
  correlationId?: string;
  action: string;
  risk?: string;
  toolCallId?: string;
  detail: unknown;
  createdAt: string;
}

/**
 * Respuesta del modelo cacheada para reutilizarla (PERF-002).
 *
 * La cachea guarda la RESPUESTA, no un hecho: son cosas distintas y no se
 * mezclan (ver `Store.getCachedResponse`).
 */
export interface CachedResponse {
  userId: string;
  /** Hash estable del prompt normalizado: clave de coincidencia exacta. */
  promptHash: string;
  /** Prompt original, para auditoría. */
  prompt: string;
  /** Respuesta del modelo. */
  response: string;
  /** Embedding del prompt: permite buscar coincidencias semánticas. */
  embedding?: number[];
  createdAt: string;
  /** Cuántas veces se ha servido desde la caché. */
  hits: number;
}

export interface ApprovalRecord {
  id: string;
  userId: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  risk: string;
  description: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt?: string;
}

export interface Store {
  readonly kind: "postgres" | "memory";
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;

  createSession(input: { id: string; userId: string; title?: string }): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  touchSession(id: string): Promise<void>;
  listSessions(userId: string, limit?: number): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;

  addMessage(message: Omit<StoredMessage, "id" | "createdAt">): Promise<StoredMessage>;
  getMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  countMessages(userId: string): Promise<number>;

  addEpisodic(record: Omit<EpisodicMemoryRecord, "id" | "createdAt">): Promise<EpisodicMemoryRecord>;
  searchEpisodic(userId: string, query: string, limit?: number): Promise<EpisodicMemoryRecord[]>;
  listEpisodic(userId: string, limit?: number): Promise<EpisodicMemoryRecord[]>;
  purgeEpisodicBefore(userId: string, iso: string): Promise<number>;
  /**
   * Borra los recuerdos épicos de TODOS los usuarios anteriores a la fecha.
   *
   * Existe porque la retención es una política GLOBAL del despliegue: purgar
   * por usuario obligaba al servicio a conocer la lista de usuarios, que no
   * es lo que ocurre en la práctica.
   */
  purgeEpisodicBeforeAll(iso: string): Promise<number>;

  addSemantic(record: Omit<SemanticMemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<SemanticMemoryRecord>;
  searchSemantic(
    userId: string,
    query: string,
    limit?: number,
    queryEmbedding?: number[],
  ): Promise<SemanticMemoryRecord[]>;
  listSemantic(userId: string, limit?: number): Promise<SemanticMemoryRecord[]>;
  deleteSemantic(userId: string, id: string): Promise<boolean>;

  /* ── Caché de respuestas (PERF-002) ────────────────────────────────── */

  /**
   * Respuesta cacheada de una inferencia.
   *
   * NO es memoria semántica: la memoria semántica guarda HECHOS que el
   * usuario autorizó, y aquí se guardan RESPUESTAS del modelo. Mezclarlas
   * contaminaría el contexto que el agente se inyecta a sí mismo.
   */
  getCachedResponse(userId: string, promptHash: string): Promise<CachedResponse | undefined>;
  /** Busca una respuesta cacheada cuyo embedding se parezca al del prompt. */
  findSimilarCachedResponse(
    userId: string,
    embedding: number[],
    threshold: number,
    limit?: number,
  ): Promise<CachedResponse | undefined>;
  setCachedResponse(entry: CachedResponse): Promise<void>;
  /**
   * Borra una respuesta cacheada concreta.
   *
   * Se usa cuando lo cacheado es una negativa del modelo: repetirla dejaría
   * al usuario atrapado con la misma respuesta inválida.
   */
  deleteCachedResponse(userId: string, promptHash: string): Promise<boolean>;
  /**
   * Borra las respuestas cacheadas anteriores a la fecha.
   *
   * La caché guarda prompts y respuestas del usuario: es dato personal y
   * tiene que obedecer la misma retención que el resto de la memoria.
   */
  purgeCachedResponsesBefore(iso: string): Promise<number>;

  createTask(record: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">): Promise<TaskRecord>;
  listTasks(userId: string, status?: TaskRecord["status"]): Promise<TaskRecord[]>;
  updateTask(id: string, userId: string, patch: Partial<Pick<TaskRecord, "title" | "notes" | "status" | "dueAt">>): Promise<TaskRecord | undefined>;
  deleteTask(id: string, userId: string): Promise<boolean>;

  appendAudit(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<AuditEntry>;
  listAudit(userId: string, limit?: number): Promise<AuditEntry[]>;

  createApproval(record: Omit<ApprovalRecord, "id" | "requestedAt" | "status">): Promise<ApprovalRecord>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  resolveApproval(id: string, status: "approved" | "denied" | "expired"): Promise<ApprovalRecord | undefined>;

  recordToolCall(record: ToolCallRecord): Promise<void>;
  listToolCalls(taskId: string): Promise<ToolCallRecord[]>;

  exportUserData(userId: string): Promise<Record<string, unknown>>;
  deleteUserData(userId: string): Promise<void>;
}
