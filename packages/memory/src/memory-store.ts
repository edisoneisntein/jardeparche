import { randomUUID } from "node:crypto";
import type { ToolCallRecord } from "@jarvis/shared";
import type {
  ApprovalRecord,
  AuditEntry,
  CachedResponse,
  EpisodicMemoryRecord,
  SemanticMemoryRecord,
  SessionRecord,
  Store,
  StoredMessage,
  TaskRecord,
} from "./schema.js";
import { cosineSimilarity, lexicalScore } from "./text.js";

/**
 * In-process store. Used by unit tests and by `PERSISTENCE=memory`. It is
 * intentionally not a fake: it implements the full contract so behavior is
 * identical to Postgres except for durability across restarts.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  /** Tope de mensajes en memoria: el más reciente desplaza al más antiguo. */
  private static readonly MAX_MESSAGES = 10_000;
  /** Tope de recuerdos episódicos en memoria. */
  private static readonly MAX_EPISODIC = 5_000;
  /** Tope de entradas de auditoría en memoria. */
  private static readonly MAX_AUDIT = 10_000;
  private sessions = new Map<string, SessionRecord>();
  private messages: StoredMessage[] = [];
  private episodic: EpisodicMemoryRecord[] = [];
  private semantic: SemanticMemoryRecord[] = [];
  private tasks = new Map<string, TaskRecord>();
  private audit: AuditEntry[] = [];
  private approvals = new Map<string, ApprovalRecord>();
  private toolCalls = new Map<string, ToolCallRecord[]>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "in-process store" };
  }

  async createSession(input: { id: string; userId: string; title?: string }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: input.id,
      userId: input.userId,
      title: input.title ?? "Nueva sesión",
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async touchSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    const now = new Date().toISOString();
    session.updatedAt = now;
    session.lastSeenAt = now;
  }

  async listSessions(userId: string, limit = 50): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.messages = this.messages.filter((message) => message.sessionId !== id);
  }

  async addMessage(message: Omit<StoredMessage, "id" | "createdAt">): Promise<StoredMessage> {
    const record: StoredMessage = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    this.messages.push(record);
    if (this.messages.length > MemoryStore.MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MemoryStore.MAX_MESSAGES);
    }
    return record;
  }

  async getMessages(sessionId: string, limit = 100): Promise<StoredMessage[]> {
    return this.messages.filter((message) => message.sessionId === sessionId).slice(-limit);
  }

  async countMessages(userId: string): Promise<number> {
    return this.messages.filter((message) => message.userId === userId).length;
  }

  async addEpisodic(record: Omit<EpisodicMemoryRecord, "id" | "createdAt">): Promise<EpisodicMemoryRecord> {
    const stored: EpisodicMemoryRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    this.episodic.unshift(stored);
    if (this.episodic.length > MemoryStore.MAX_EPISODIC) {
      this.episodic.length = MemoryStore.MAX_EPISODIC;
    }
    return stored;
  }

  async searchEpisodic(userId: string, query: string, limit = 5): Promise<EpisodicMemoryRecord[]> {
    return this.episodic
      .filter((record) => record.userId === userId)
      .map((record) => ({ record, score: lexicalScore(query, record.summary) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  async listEpisodic(userId: string, limit = 20): Promise<EpisodicMemoryRecord[]> {
    return this.episodic.filter((record) => record.userId === userId).slice(0, limit);
  }

  async purgeEpisodicBefore(userId: string, iso: string): Promise<number> {
    const before = this.episodic.length;
    this.episodic = this.episodic.filter((record) => record.userId !== userId || record.createdAt >= iso);
    return before - this.episodic.length;
  }

  async purgeEpisodicBeforeAll(iso: string): Promise<number> {
    const before = this.episodic.length;
    this.episodic = this.episodic.filter((record) => record.createdAt >= iso);
    return before - this.episodic.length;
  }

  async addSemantic(record: Omit<SemanticMemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<SemanticMemoryRecord> {
    const existing = this.semantic.find((item) => item.userId === record.userId && item.key === record.key);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { value: record.value, source: record.source, embedding: record.embedding, updatedAt: now });
      return existing;
    }
    const stored: SemanticMemoryRecord = { ...record, id: randomUUID(), createdAt: now, updatedAt: now };
    this.semantic.unshift(stored);
    return stored;
  }

  async searchSemantic(userId: string, query: string, limit = 5, queryEmbedding?: number[]): Promise<SemanticMemoryRecord[]> {
    const candidates = this.semantic.filter((record) => record.userId === userId);
    const scored = candidates.map((record) => {
      let score = lexicalScore(query, `${record.key} ${record.value}`);
      if (queryEmbedding && record.embedding) {
        score = Math.max(score, cosineSimilarity(queryEmbedding, record.embedding));
      }
      return { record, score };
    });
    return scored
      .filter((entry) => entry.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ ...entry.record, score: entry.score }));
  }

  async listSemantic(userId: string, limit = 100): Promise<SemanticMemoryRecord[]> {
    return this.semantic.filter((record) => record.userId === userId).slice(0, limit);
  }

  /* ── PERF-002 · Caché de respuestas ─────────────────────────────────── */

  /**
   * Tope de respuestas cacheadas en memoria.
   *
   * Sin tope, la caché crecía sin límite (cada prompt distinto se quedaba)
   * y la búsqueda semántica recorría TODAS las entradas de TODOS los
   * usuarios en cada turno: O(entradas × dimensiones) de CPU en el event
   * loop, en el camino crítico de cada conversación.
   */
  private static readonly MAX_CACHED_RESPONSES = 512;
  /** PERF-002 · Respuestas cacheadas, por usuario y hash de prompt. */
  private responseCache = new Map<string, CachedResponse>();
  /** Índice inverso: usuario → claves cacheadas de ese usuario. */
  private responseCacheByUser = new Map<string, Set<string>>();

  private cacheKey(userId: string, promptHash: string): string {
    return `${userId}::${promptHash}`;
  }

  /** Inserta o actualiza una entrada de caché y aplica el tope LRU. */
  private putCacheEntry(entry: CachedResponse): void {
    const key = this.cacheKey(entry.userId, entry.promptHash);
    this.responseCache.set(key, entry);
    const keys = this.responseCacheByUser.get(entry.userId) ?? new Set<string>();
    keys.add(key);
    this.responseCacheByUser.set(entry.userId, keys);
    while (this.responseCache.size > MemoryStore.MAX_CACHED_RESPONSES) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest === undefined) break;
      this.removeCacheEntry(oldest);
    }
  }

  /** Elimina una entrada de caché de los dos índices. */
  private removeCacheEntry(key: string): void {
    const entry = this.responseCache.get(key);
    if (!entry) return;
    this.responseCache.delete(key);
    const keys = this.responseCacheByUser.get(entry.userId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.responseCacheByUser.delete(entry.userId);
  }

  async getCachedResponse(userId: string, promptHash: string): Promise<CachedResponse | undefined> {
    const key = this.cacheKey(userId, promptHash);
    const entry = this.responseCache.get(key);
    if (!entry) return undefined;
    // Servir desde la caché cuenta como un acierto: paridad con Postgres.
    const hits = entry.hits + 1;
    this.putCacheEntry({ ...entry, hits });
    return { ...entry, hits };
  }

  async findSimilarCachedResponse(
    userId: string,
    embedding: number[],
    threshold: number,
    limit = 5,
  ): Promise<CachedResponse | undefined> {
    // Solo se recorren las entradas DEL USUARIO: antes se iteraba toda la
    // caché (todos los usuarios) en cada turno.
    const keys = this.responseCacheByUser.get(userId);
    if (!keys) return undefined;
    let best: CachedResponse | undefined;
    let bestScore = threshold;
    for (const key of keys) {
      const entry = this.responseCache.get(key);
      if (!entry?.embedding) continue;
      const score = cosineSimilarity(embedding, entry.embedding);
      if (score < bestScore) continue;
      best = entry;
      bestScore = score;
    }
    void limit;
    if (!best) return undefined;
    const hits = best.hits + 1;
    this.putCacheEntry({ ...best, hits });
    return { ...best, hits };
  }

  async setCachedResponse(entry: CachedResponse): Promise<void> {
    this.putCacheEntry(entry);
  }

  async purgeCachedResponsesBefore(iso: string): Promise<number> {
    const cutoff = Date.parse(iso);
    if (Number.isNaN(cutoff)) return 0;
    let purged = 0;
    for (const [key, entry] of this.responseCache) {
      if (Date.parse(entry.createdAt) >= cutoff) continue;
      this.removeCacheEntry(key);
      purged += 1;
    }
    return purged;
  }

  /**
   * Borra una respuesta cacheada concreta.
   *
   * Se usa cuando la respuesta cacheada es una negativa del modelo: servirla
   * una segunda vez convertiría un fallo puntual en un fallo permanente.
   */
  async deleteCachedResponse(userId: string, promptHash: string): Promise<boolean> {
    const key = this.cacheKey(userId, promptHash);
    if (!this.responseCache.has(key)) return false;
    this.removeCacheEntry(key);
    return true;
  }

  async deleteSemantic(userId: string, id: string): Promise<boolean> {
    const before = this.semantic.length;
    this.semantic = this.semantic.filter((record) => !(record.userId === userId && record.id === id));
    return this.semantic.length < before;
  }

  async createTask(record: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const stored: TaskRecord = { ...record, id: randomUUID(), createdAt: now, updatedAt: now };
    this.tasks.set(stored.id, stored);
    return stored;
  }

  async listTasks(userId: string, status?: TaskRecord["status"]): Promise<TaskRecord[]> {
    return [...this.tasks.values()].filter((task) => task.userId === userId && (!status || task.status === status));
  }

  async updateTask(
    id: string,
    userId: string,
    patch: Partial<Pick<TaskRecord, "title" | "notes" | "status" | "dueAt">>,
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(id);
    if (!task || task.userId !== userId) return undefined;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return task;
  }

  async deleteTask(id: string, userId: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.userId !== userId) return false;
    this.tasks.delete(id);
    return true;
  }

  async appendAudit(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<AuditEntry> {
    const stored: AuditEntry = { ...entry, id: randomUUID(), createdAt: new Date().toISOString() };
    this.audit.unshift(stored);
    if (this.audit.length > MemoryStore.MAX_AUDIT) {
      this.audit.length = MemoryStore.MAX_AUDIT;
    }
    return stored;
  }

  async listAudit(userId: string, limit = 100): Promise<AuditEntry[]> {
    return this.audit.filter((entry) => entry.userId === userId).slice(0, limit);
  }

  async createApproval(record: Omit<ApprovalRecord, "id" | "requestedAt" | "status">): Promise<ApprovalRecord> {
    const stored: ApprovalRecord = { ...record, id: randomUUID(), status: "pending", requestedAt: new Date().toISOString() };
    this.approvals.set(stored.id, stored);
    return stored;
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(id);
  }

  async resolveApproval(id: string, status: "approved" | "denied" | "expired"): Promise<ApprovalRecord | undefined> {
    const record = this.approvals.get(id);
    if (!record) return undefined;
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    return record;
  }

  async recordToolCall(record: ToolCallRecord): Promise<void> {
    const list = this.toolCalls.get(record.taskId) ?? [];
    const index = list.findIndex((entry) => entry.id === record.id);
    if (index >= 0) list[index] = record;
    else list.push(record);
    this.toolCalls.set(record.taskId, list);
  }

  async listToolCalls(taskId: string): Promise<ToolCallRecord[]> {
    return this.toolCalls.get(taskId) ?? [];
  }

  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    return {
      sessions: await this.listSessions(userId, 1000),
      messages: this.messages.filter((message) => message.userId === userId),
      episodic: await this.listEpisodic(userId, 1000),
      semantic: await this.listSemantic(userId, 1000),
      tasks: await this.listTasks(userId),
      audit: await this.listAudit(userId, 1000),
    };
  }

  async deleteUserData(userId: string): Promise<void> {
    for (const [id, session] of this.sessions) if (session.userId === userId) this.sessions.delete(id);
    this.messages = this.messages.filter((message) => message.userId !== userId);
    this.episodic = this.episodic.filter((record) => record.userId !== userId);
    this.semantic = this.semantic.filter((record) => record.userId !== userId);
    for (const [id, task] of this.tasks) if (task.userId === userId) this.tasks.delete(id);
    this.audit = this.audit.filter((entry) => entry.userId !== userId);
    // La caché también guarda prompts y respuestas del usuario: se borra con
    // el resto de sus datos.
    for (const [key, entry] of this.responseCache) {
      if (entry.userId === userId) this.removeCacheEntry(key);
    }
  }
}
