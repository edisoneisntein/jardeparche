import { createHash } from "node:crypto";
import { looksLikeRefusal, type ChatMessage, type ToolResult } from "@jarvis/shared";
import type {
  CachedResponse,
  EpisodicMemoryRecord,
  SemanticMemoryRecord,
  Store,
  StoredMessage,
} from "./schema.js";
import { extractText, safeStringify, truncate } from "./text.js";

export interface Embedder {
  embed(texts: string[], inputType?: "query" | "passage"): Promise<{ vectors: number[][]; dimensions: number }>;
}

export interface RecallResult {
  recent: StoredMessage[];
  episodic: EpisodicMemoryRecord[];
  semantic: SemanticMemoryRecord[];
}

export interface MemoryServiceOptions {
  store: Store;
  embedder?: Embedder;
  retentionDays?: number;
}

/** Tope de caracteres del prompt que entra en el hash de la caché. */
const MAX_HASHED_PROMPT_CHARS = 32 * 1024;

/** Tope del prompt almacenado en la caché de respuestas. */
const MAX_CACHED_PROMPT_CHARS = 8 * 1024;

/** Tope de la respuesta almacenada en la caché. */
const MAX_CACHED_RESPONSE_CHARS = 64 * 1024;

/**
 * Normaliza un prompt para poder compararlo con otro equivalente.
 *
 * Solo se ignoran diferencias que NO cambian el significado: mayúsculas,
 * espacios sobrantes y puntuación final. Dos preguntas que se diferencian en
 * una palabra NO son la misma pregunta.
 */
export function normalizePrompt(prompt: string): string {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?¿¡]+$/g, "")
    .trim();
}

/**
 * Hash estable del prompt normalizado: clave de coincidencia exacta.
 *
 * El material hasheado se acota (un prompt puede medir varios megabytes:
 * el transporte WebSocket admite 16 MB), pero la longitud completa entra en
 * el resumen: dos prompts distintos que compartan el prefijo no colisionan.
 */
export function hashPrompt(normalizedPrompt: string): string {
  const capped = normalizedPrompt.slice(0, MAX_HASHED_PROMPT_CHARS);
  return createHash("sha256").update(`${normalizedPrompt.length}:${capped}`).digest("hex");
}

/**
 * Personal memory facade. Enforces the rule that semantic memory only ever
 * contains facts the user explicitly authorized — never model inferences.
 */
export class MemoryService {
  private readonly store: Store;
  private readonly embedder?: Embedder;
  private readonly retentionDays: number;

  constructor(options: MemoryServiceOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.retentionDays = options.retentionDays ?? 0;
  }

  get raw(): Store {
    return this.store;
  }

  async recordUserMessage(input: { userId: string; sessionId: string; taskId?: string; text: string; content?: ChatMessage["content"] }): Promise<StoredMessage> {
    await this.store.touchSession(input.sessionId);
    return this.store.addMessage({
      sessionId: input.sessionId,
      userId: input.userId,
      taskId: input.taskId,
      kind: "user",
      role: "user",
      text: truncate(input.text),
      content: input.content ?? input.text,
    });
  }

  async recordAssistantMessage(input: { userId: string; sessionId: string; taskId?: string; text: string }): Promise<StoredMessage> {
    return this.store.addMessage({
      sessionId: input.sessionId,
      userId: input.userId,
      taskId: input.taskId,
      kind: "assistant",
      role: "assistant",
      text: truncate(input.text),
      content: input.text,
    });
  }

  async recordToolMessage(input: {
    userId: string;
    sessionId: string;
    taskId: string;
    toolCallId: string;
    name: string;
    result: ToolResult;
  }): Promise<StoredMessage> {
    return this.store.addMessage({
      sessionId: input.sessionId,
      userId: input.userId,
      taskId: input.taskId,
      kind: "tool",
      role: "tool",
      name: input.name,
      tool_call_id: input.toolCallId,
      text: truncate(input.result.summary),
      content: truncate(safeStringify(input.result.data ?? input.result.summary)),
    });
  }

  async recordEpisode(input: {
    userId: string;
    sessionId: string;
    taskId: string;
    summary: string;
    outcome: "completed" | "failed" | "cancelled";
    toolsUsed: string[];
  }): Promise<EpisodicMemoryRecord> {
    return this.store.addEpisodic({
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      summary: truncate(input.summary, 1000),
      outcome: input.outcome,
      toolsUsed: input.toolsUsed,
    });
  }

  /** Only called after explicit user authorization. */
  async rememberExplicitFact(input: { userId: string; key: string; value: string; source?: SemanticMemoryRecord["source"] }): Promise<SemanticMemoryRecord> {
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        const result = await this.embedder.embed([`${input.key}: ${input.value}`], "passage");
        embedding = result.vectors[0];
      } catch {
        embedding = undefined;
      }
    }
    return this.store.addSemantic({
      userId: input.userId,
      key: input.key,
      value: input.value,
      source: input.source ?? "explicit_user",
      embedding,
    });
  }

  async listFacts(userId: string, limit = 100): Promise<SemanticMemoryRecord[]> {
    return this.store.listSemantic(userId, limit);
  }

  async forgetFact(userId: string, id: string): Promise<boolean> {
    return this.store.deleteSemantic(userId, id);
  }

  async listEpisodes(userId: string, limit = 20): Promise<EpisodicMemoryRecord[]> {
    return this.store.listEpisodic(userId, limit);
  }

  /**
   * Retrieves bounded, relevant context. Every returned item is backed by a
   * stored record with a timestamp; nothing is invented.
   */
  async recall(userId: string, sessionId: string, query: string, limit = 4): Promise<RecallResult> {
    let queryEmbedding: number[] | undefined;
    if (this.embedder && query.trim().length > 0) {
      try {
        const result = await this.embedder.embed([query], "query");
        queryEmbedding = result.vectors[0];
      } catch {
        queryEmbedding = undefined;
      }
    }
    const [recent, episodic, semantic] = await Promise.all([
      this.store.getMessages(sessionId, 12),
      this.store.searchEpisodic(userId, query, limit),
      this.store.searchSemantic(userId, query, limit, queryEmbedding),
    ]);
    return { recent, episodic, semantic };
  }

  /* ── PERF-002 · Caché de respuestas ─────────────────────────────────── */

  /**
   * Busca una respuesta cacheada para este prompt.
   *
   * Dos rutas, de la más barata a la más cara:
   *  1. Coincidencia EXACTA por hash del prompt normalizado: sin embeddings,
   *     sin coste de inferencia. Es la que resuelve el caso habitual.
   *  2. Coincidencia SEMÁNTICA por embedding, solo si hay embedder y la
   *     similitud llega al umbral (0.98 por defecto: muy estricto, para no
   *     servir una respuesta que no era la misma).
   *
   * Devuelve `undefined` si no hay coincidencia: el runtime sigue el camino
   * normal y llama al proveedor.
   */
  async findSemanticMatch(
    userId: string,
    prompt: string,
    threshold = 0.98,
  ): Promise<CachedResponse | undefined> {
    const normalized = normalizePrompt(prompt);
    if (!normalized) return undefined;
    const promptHash = hashPrompt(normalized);
    const exact = await this.store.getCachedResponse(userId, promptHash);
    if (exact) return this.usableOrDiscard(userId, exact);
    if (!this.embedder) return undefined;
    try {
      const embedded = await this.embedder.embed([normalized], "query");
      const vector = embedded.vectors[0];
      if (!vector?.length) return undefined;
      const similar = await this.store.findSimilarCachedResponse(userId, vector, threshold);
      if (!similar) return undefined;
      return this.usableOrDiscard(userId, similar);
    } catch {
      // Sin embeddings no hay caché semántica: se sigue con la coincidencia
      // exacta. La caché nunca debe romper un turno.
      return undefined;
    }
  }

  /**
   * Descarta una respuesta cacheada que sea una NEGATIVA del modelo.
   *
   * Caso real (2026-10-23): el modelo respondió «no puedo buscar…» a una
   * pregunta de salud, la respuesta se guardó en la caché semántica y a partir
   * de ahí TODAS las preguntas parecidas recibían esa misma negativa. Una
   * negativa no es una respuesta: se borra y el turno sigue por el camino
   * normal (modelo + herramientas).
   *
   * @returns La respuesta si es utilizable; `undefined` si era una negativa.
   */
  private usableOrDiscard(userId: string, cached: CachedResponse): CachedResponse | undefined {
    if (!looksLikeRefusal(cached.response)) return cached;
    void this.store.deleteCachedResponse(userId, cached.promptHash).catch(() => undefined);
    return undefined;
  }

  /** Guarda una respuesta para reutilizarla en un prompt equivalente. */
  async cacheResponse(userId: string, prompt: string, response: string): Promise<void> {
    const normalized = normalizePrompt(prompt);
    if (!normalized || !response.trim()) return;
    let embedding: number[] | undefined;
    if (this.embedder) {
      try {
        const embedded = await this.embedder.embed([normalized], "passage");
        embedding = embedded.vectors[0];
      } catch {
        embedding = undefined;
      }
    }
    await this.store.setCachedResponse({
      userId,
      promptHash: hashPrompt(normalized),
      // La caché guarda el prompt y la respuesta completos: sin tope, una
      // respuesta de varios megabytes ocupaba la fila (y la RAM del
      // proveedor) sin límite.
      prompt: normalized.slice(0, MAX_CACHED_PROMPT_CHARS),
      response: response.slice(0, MAX_CACHED_RESPONSE_CHARS),
      embedding,
      createdAt: new Date().toISOString(),
      hits: 0,
    });
  }

  /**
   * Aplica la política de retención.
   *
   * Antes purgaba únicamente los recuerdos del usuario literal `"local"`: con
   * cualquier otro identificador la política era un no-op silencioso y el
   * servidor anunciaba `purged: 0` como si se hubiera limpiado algo. La
   * retención es una política GLOBAL del despliegue, así que se aplica a
   * todos los usuarios, y también a la caché de respuestas (que guarda
   * prompts y respuestas del usuario: dato personal).
   */
  async purgeExpired(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    const episodic = await this.store.purgeEpisodicBeforeAll(cutoff);
    const cached = await this.store.purgeCachedResponsesBefore(cutoff);
    return episodic + cached;
  }

  async exportUser(userId: string): Promise<Record<string, unknown>> {
    return this.store.exportUserData(userId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.store.deleteUserData(userId);
  }

  buildContextBlock(recall: RecallResult): string | undefined {
    const lines: string[] = [];
    if (recall.episodic.length) {
      lines.push("Episodic memory (past interactions):");
      for (const item of recall.episodic) lines.push(`- [${item.createdAt.slice(0, 10)}] ${item.summary} (${item.outcome})`);
    }
    if (recall.semantic.length) {
      lines.push("Authorized personal facts:");
      for (const item of recall.semantic) lines.push(`- ${item.key}: ${item.value}`);
    }
    return lines.length ? lines.join("\n") : undefined;
  }
}

export { extractText };
