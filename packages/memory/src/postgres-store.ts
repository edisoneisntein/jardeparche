import { randomUUID } from "node:crypto";
import pg from "pg";
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
import { MIGRATIONS, MIGRATIONS_TABLE } from "./migrations.js";
import { cosineSimilarity, lexicalScore } from "./text.js";

const { Pool } = pg;

/** Tope de respuestas cacheadas por usuario (coincide con la caché en memoria). */
const MAX_CACHED_RESPONSES_PER_USER = 512;

/**
 * Tipos de fila de postgres.
 *
 * Sin ellos, `pool.query` devuelve `rows: any[]` y cada acceso es una
 * dependencia implícita del nombre de la columna: un typo en `user_id` no lo
 * detecta TypeScript, lo detecta producción. Las filas se declaran una vez y
 * las consultas las piden como genérico.
 */
interface SessionRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_seen_at: Date | string;
}

interface MessageRow extends pg.QueryResultRow {
  id: string;
  session_id: string;
  user_id: string;
  task_id: string | null;
  kind: StoredMessage["kind"];
  role: StoredMessage["role"];
  text: string;
  content: StoredMessage["content"];
  name: string | null;
  tool_call_id: string | null;
  tool_calls: StoredMessage["tool_calls"];
  created_at: Date | string;
}

interface EpisodicRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  session_id: string | null;
  task_id: string | null;
  summary: string;
  outcome: EpisodicMemoryRecord["outcome"];
  tools_used: string[];
  created_at: Date | string;
}

interface SemanticRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  key: string;
  value: string;
  source: SemanticMemoryRecord["source"];
  embedding: number[] | string | null;
  score: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TaskRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  status: TaskRecord["status"];
  due_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AuditRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  session_id: string | null;
  task_id: string | null;
  correlation_id: string | null;
  action: string;
  risk: string | null;
  tool_call_id: string | null;
  detail: unknown;
  created_at: Date | string;
}

interface ApprovalRow extends pg.QueryResultRow {
  id: string;
  user_id: string;
  session_id: string;
  task_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  risk: string;
  description: string;
  status: ApprovalRecord["status"];
  requested_at: Date | string;
  resolved_at: Date | string | null;
}

interface CachedResponseRow extends pg.QueryResultRow {
  user_id: string;
  prompt_hash: string;
  prompt: string;
  response: string;
  embedding: number[] | string | null;
  hits: number;
  created_at: Date | string;
}

interface ToolCallRow extends pg.QueryResultRow {
  id: string;
  task_id: string;
  session_id: string;
  user_id: string;
  name: string;
  arguments: unknown;
  status: ToolCallRecord["status"];
  result: ToolCallRecord["result"];
  started_at: Date | string;
  finished_at: Date | string | null;
  duration_ms: number | null;
}

/** Cliente mínimo de postgres que necesita el gestor de migraciones. */
export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/**
 * ARCH-002 · Aplica las migraciones pendientes en UNA transacción.
 *
 * Atomicidad: si una migración falla, se hace `ROLLBACK` y la base de datos
 * queda como estaba. Nunca hay un esquema a medias.
 *
 * Idempotencia: cada migración aplicada se anota en
 * `jarvis_schema_migrations`; solo se ejecuta lo que falta.
 *
 * Devuelve los identificadores de las migraciones aplicadas en esta llamada.
 */
export async function runMigrations(client: MigrationClient): Promise<string[]> {
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         id         text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = await client.query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
    const rows = (applied as { rows?: Array<{ id: string }> }).rows ?? [];
    const done = new Set(rows.map((row) => row.id));
    const executed: string[] = [];
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1) ON CONFLICT DO NOTHING`, [migration.id]);
      executed.push(migration.id);
    }
    await client.query("COMMIT");
    return executed;
  } catch (error) {
    // La base de datos vuelve a su estado anterior: nada a medias. Si el
    // ROLLBACK también falla, ambos errores se reportan: esconder el fallo
    // del ROLLBACK deja una sesión en transacción abierta, que bloquea filas
    // para siempre.
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [failure, rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))],
        "la migración falló y además falló el ROLLBACK",
      );
    }
    throw failure;
  }
}

/**
 * Aplica las migraciones sobre una base de datos dada.
 *
 * Es la entrada única: la usan tanto el arranque del servidor como el
 * script `db:migrate`, sin depender de ficheros duplicados en el build.
 */
export async function migratePostgres(
  databaseUrl: string,
  options: { maxConnections?: number } = {},
): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: options.maxConnections ?? 2 });
  const client = await pool.connect();
  try {
    const executed = await runMigrations(client);
    client.release();
    return executed;
  } catch (error) {
    // Se destruye el cliente en lugar de devolverlo al pool: si la
    // transacción quedó abierta, reutilizarlo propagaría el bloqueo.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    await pool.end();
  }
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value as number[];
  if (typeof value === "string") {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((entry) => Number.parseFloat(entry))
      .filter((entry) => Number.isFinite(entry));
  }
  return undefined;
}

export interface PostgresStoreOptions {
  connectionString: string;
  maxConnections?: number;
  /** Tope de espera para conseguir una conexión del pool (ms). */
  connectionTimeoutMs?: number;
  /** Tope de ejecución de una sentencia en el servidor (ms). */
  statementTimeoutMs?: number;
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;

  constructor(options: PostgresStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      // Sin `connectionTimeoutMillis`, una petición espera ENCOLADA para
      // siempre si el pool está saturado: la latencia crecía sin techo y la
      // cola de espera no tenía límite. Con tope, la exceso se degrada a un
      // error explícito y el runtime puede responder por otra vía.
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      // Tope de sentencia en el servidor: una consulta patológica no retiene
      // una ranura del pool indefinidamente.
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      // Tope de espera del cliente: una red colgada o una consulta bloqueada.
      query_timeout: options.statementTimeoutMs ?? 15_000,
      // Una transacción abierta por error bloquea filas para siempre.
      idle_in_transaction_session_timeout: 10_000,
    });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await runMigrations(client);
      client.release();
    } catch (error) {
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Ejecuta un bloque en una transacción.
   *
   * Si el `ROLLBACK` falla, el cliente se destruye (no se devuelve al pool):
   * una sesión con una transacción abierta bloquea filas para siempre.
   */
  private async withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      client.release();
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(rollbackError instanceof Error ? rollbackError : failure);
        throw failure;
      }
      client.release(failure);
      throw failure;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.pool.query("SELECT 1 AS ok");
      return { ok: result.rows[0]?.ok === 1, detail: "postgres ok" };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  private async ensureUser(userId: string): Promise<void> {
    await this.pool.query("INSERT INTO jarvis_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
  }

  async createSession(input: { id: string; userId: string; title?: string }): Promise<SessionRecord> {
    await this.ensureUser(input.userId);
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO jarvis_sessions (id, user_id, title) VALUES ($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()
       RETURNING *`,
      [input.id, input.userId, input.title ?? "Nueva sesión"],
    );
    return mapSession(expectRow(result.rows, "createSession"));
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM jarvis_sessions WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapSession(row) : undefined;
  }

  async touchSession(id: string): Promise<void> {
    await this.pool.query("UPDATE jarvis_sessions SET updated_at = now(), last_seen_at = now() WHERE id = $1", [id]);
  }

  async listSessions(userId: string, limit = 50): Promise<SessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM jarvis_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
      [userId, limit],
    );
    return result.rows.map(mapSession);
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query("DELETE FROM jarvis_sessions WHERE id = $1", [id]);
  }

  async addMessage(message: Omit<StoredMessage, "id" | "createdAt">): Promise<StoredMessage> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO jarvis_messages
        (id, session_id, user_id, task_id, kind, role, text, content, name, tool_call_id, tool_calls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        randomUUID(),
        message.sessionId,
        message.userId,
        message.taskId ?? null,
        message.kind,
        message.role,
        message.text,
        message.content == null ? null : JSON.stringify(message.content),
        message.name ?? null,
        message.tool_call_id ?? null,
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
      ],
    );
    return mapMessage(expectRow(result.rows, "addMessage"));
  }

  async getMessages(sessionId: string, limit = 100): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM jarvis_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [sessionId, limit],
    );
    return result.rows.map(mapMessage);
  }

  async countMessages(userId: string): Promise<number> {
    const result = await this.pool.query("SELECT count(*)::int AS count FROM jarvis_messages WHERE user_id = $1", [userId]);
    return result.rows[0]?.count ?? 0;
  }

  async addEpisodic(record: Omit<EpisodicMemoryRecord, "id" | "createdAt">): Promise<EpisodicMemoryRecord> {
    const result = await this.pool.query<EpisodicRow>(
      `INSERT INTO jarvis_episodic_memories (id, user_id, session_id, task_id, summary, outcome, tools_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        randomUUID(),
        record.userId,
        record.sessionId ?? null,
        record.taskId ?? null,
        record.summary,
        record.outcome,
        JSON.stringify(record.toolsUsed),
      ],
    );
    return mapEpisodic(expectRow(result.rows, "addEpisodic"));
  }

  async searchEpisodic(userId: string, query: string, limit = 5): Promise<EpisodicMemoryRecord[]> {
    const result = await this.pool.query<EpisodicRow>(
      `SELECT *, ts_rank(to_tsvector('simple', summary), plainto_tsquery('simple', $2)) AS rank
       FROM jarvis_episodic_memories
       WHERE user_id = $1 AND to_tsvector('simple', summary) @@ plainto_tsquery('simple', $2)
       ORDER BY rank DESC, created_at DESC LIMIT $3`,
      [userId, query, limit],
    );
    if (result.rows.length > 0) return result.rows.map(mapEpisodic);
    const all = await this.listEpisodic(userId, 200);
    return all
      .map((record) => ({ record, score: lexicalScore(query, record.summary) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  async listEpisodic(userId: string, limit = 20): Promise<EpisodicMemoryRecord[]> {
    const result = await this.pool.query<EpisodicRow>(
      "SELECT * FROM jarvis_episodic_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return result.rows.map(mapEpisodic);
  }

  async purgeEpisodicBefore(userId: string, iso: string): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM jarvis_episodic_memories WHERE user_id = $1 AND created_at < $2",
      [userId, iso],
    );
    return result.rowCount ?? 0;
  }

  async purgeEpisodicBeforeAll(iso: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM jarvis_episodic_memories WHERE created_at < $1", [iso]);
    return result.rowCount ?? 0;
  }

  async addSemantic(record: Omit<SemanticMemoryRecord, "id" | "createdAt" | "updatedAt">): Promise<SemanticMemoryRecord> {
    await this.ensureUser(record.userId);
    const result = await this.pool.query<SemanticRow>(
      `INSERT INTO jarvis_semantic_memories (id, user_id, key, value, source, embedding)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, key) DO UPDATE
         SET value = EXCLUDED.value, source = EXCLUDED.source, embedding = EXCLUDED.embedding, updated_at = now()
       RETURNING *`,
      [randomUUID(), record.userId, record.key, record.value, record.source, record.embedding ? vectorLiteral(record.embedding) : null],
    );
    return mapSemantic(expectRow(result.rows, "addSemantic"));
  }

  /* ── PERF-002 · Caché de respuestas ─────────────────────────────────── */

  async getCachedResponse(userId: string, promptHash: string): Promise<CachedResponse | undefined> {
    // Una sola ida y vuelta: el contador se incrementa Y se devuelve la fila
    // ya incrementada. Antes el SELECT devolvía el valor previo al UPDATE
    // (un acierto de menos en las métricas) y el camino de lectura escribía
    // en dos viajes, con el bloqueo de fila en medio.
    const result = await this.pool.query<CachedResponseRow>(
      `WITH bumped AS (
         UPDATE jarvis_response_cache SET hits = hits + 1
         WHERE user_id = $1 AND prompt_hash = $2
         RETURNING *
       )
       SELECT * FROM bumped`,
      [userId, promptHash],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapCachedResponse(row) : undefined;
  }

  async findSimilarCachedResponse(
    userId: string,
    embedding: number[],
    threshold: number,
    limit = 5,
  ): Promise<CachedResponse | undefined> {
    if (!embedding.length) return undefined;
    // El parámetro $2 era un fantasma: se enviaba `limit` pero la consulta no
    // lo usaba. Un desajuste de posiciones es un fallo silencioso esperando a
    // ocurrir.
    const result = await this.pool.query<CachedResponseRow>(
      `WITH bumped AS (
         UPDATE jarvis_response_cache SET hits = hits + 1
         WHERE id = (
           SELECT id FROM jarvis_response_cache
           WHERE user_id = $1 AND embedding IS NOT NULL AND 1 - (embedding <=> $2::vector) >= $3
           ORDER BY embedding <=> $2::vector LIMIT 1
         )
         RETURNING *
       )
       SELECT * FROM bumped`,
      [userId, vectorLiteral(embedding), threshold],
    );
    void limit;
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? mapCachedResponse(row) : undefined;
  }

  async setCachedResponse(entry: CachedResponse): Promise<void> {
    await this.pool.query(
      `INSERT INTO jarvis_response_cache (id, user_id, prompt_hash, prompt, response, embedding, hits, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
       ON CONFLICT (user_id, prompt_hash) DO UPDATE
         SET response = EXCLUDED.response,
             embedding = EXCLUDED.embedding,
             hits = EXCLUDED.hits,
             created_at = EXCLUDED.created_at`,
      [
        randomUUID(),
        entry.userId,
        entry.promptHash,
        entry.prompt,
        entry.response,
        entry.embedding?.length ? vectorLiteral(entry.embedding) : null,
        entry.hits,
        entry.createdAt,
      ],
    );
    // Techo de filas por usuario: la caché es desechable por definición (no
    // es memoria del usuario, es una copia de respuestas del modelo), y sin
    // este límite crecía sin fin en Postgres, que no tiene LRU. El tope
    // coincide con el de la caché en memoria (512).
    await this.pool.query(
      `DELETE FROM jarvis_response_cache
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM jarvis_response_cache WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
         )`,
      [entry.userId, MAX_CACHED_RESPONSES_PER_USER],
    );
  }

  async purgeCachedResponsesBefore(iso: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM jarvis_response_cache WHERE created_at < $1", [iso]);
    return result.rowCount ?? 0;
  }

  /**
   * Borra una respuesta cacheada concreta.
   *
   * Se usa cuando la respuesta cacheada es una negativa del modelo: servirla
   * una segunda vez convertiría un fallo puntual en un fallo permanente.
   */
  async deleteCachedResponse(userId: string, promptHash: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM jarvis_response_cache WHERE user_id = $1 AND prompt_hash = $2",
      [userId, promptHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async searchSemantic(
    userId: string,
    query: string,
    limit = 5,
    queryEmbedding?: number[],
  ): Promise<SemanticMemoryRecord[]> {
    if (queryEmbedding?.length) {
      const result = await this.pool.query<SemanticRow>(
        `SELECT *, 1 - (embedding <=> $3::vector) AS score
         FROM jarvis_semantic_memories
         WHERE user_id = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector LIMIT $2`,
        [userId, limit, vectorLiteral(queryEmbedding)],
      );
      if (result.rows.length > 0) return result.rows.map(mapSemantic);
    }
    const result = await this.pool.query<SemanticRow>(
      `SELECT *, ts_rank(to_tsvector('simple', key || ' ' || value), plainto_tsquery('simple', $2)) AS score
       FROM jarvis_semantic_memories
       WHERE user_id = $1 AND to_tsvector('simple', key || ' ' || value) @@ plainto_tsquery('simple', $2)
       ORDER BY score DESC LIMIT $3`,
      [userId, query, limit],
    );
    if (result.rows.length > 0) return result.rows.map(mapSemantic);
    const all = await this.listSemantic(userId, 200);
    return all
      .map((record) => {
        const lexical = lexicalScore(query, `${record.key} ${record.value}`);
        const cosine = queryEmbedding && record.embedding ? cosineSimilarity(queryEmbedding, record.embedding) : 0;
        return { record, score: Math.max(lexical, cosine) };
      })
      .filter((entry) => entry.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  async listSemantic(userId: string, limit = 100): Promise<SemanticMemoryRecord[]> {
    const result = await this.pool.query<SemanticRow>(
      "SELECT * FROM jarvis_semantic_memories WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2",
      [userId, limit],
    );
    return result.rows.map(mapSemantic);
  }

  async deleteSemantic(userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM jarvis_semantic_memories WHERE user_id = $1 AND id = $2", [userId, id]);
    return (result.rowCount ?? 0) > 0;
  }

  async createTask(record: Omit<TaskRecord, "id" | "createdAt" | "updatedAt">): Promise<TaskRecord> {
    await this.ensureUser(record.userId);
    const result = await this.pool.query<TaskRow>(
      `INSERT INTO jarvis_tasks (id, user_id, title, notes, status, due_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [randomUUID(), record.userId, record.title, record.notes ?? null, record.status, record.dueAt ?? null],
    );
    return mapTask(expectRow(result.rows, "createTask"));
  }

  async listTasks(userId: string, status?: TaskRecord["status"]): Promise<TaskRecord[]> {
    const result = status
      ? await this.pool.query("SELECT * FROM jarvis_tasks WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC", [userId, status])
      : await this.pool.query("SELECT * FROM jarvis_tasks WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
    return result.rows.map(mapTask);
  }

  async updateTask(
    id: string,
    userId: string,
    patch: Partial<Pick<TaskRecord, "title" | "notes" | "status" | "dueAt">>,
  ): Promise<TaskRecord | undefined> {
    // Actualización en UNA sentencia: el patrón anterior (SELECT → mutación →
    // UPDATE) perdía cambios cuando dos parches alcanzaban la misma tarea
    // (el segundo escribía los valores que había leído, no los nuevos).
    // `COALESCE` conserva la semántica previa: `undefined` significa «sin
    // cambio»; para vaciar un campo hay que enviar un valor vacío.
    const result = await this.pool.query<TaskRow>(
      `UPDATE jarvis_tasks SET
         title = COALESCE($3, title),
         notes = COALESCE($4, notes),
         status = COALESCE($5, status),
         due_at = COALESCE($6, due_at),
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, patch.title ?? null, patch.notes ?? null, patch.status ?? null, patch.dueAt ?? null],
    );
    const row = result.rows[0];
    return row ? mapTask(row) : undefined;
  }

  async deleteTask(id: string, userId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM jarvis_tasks WHERE id = $1 AND user_id = $2", [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async appendAudit(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<AuditEntry> {
    const result = await this.pool.query<AuditRow>(
      `INSERT INTO jarvis_audit_log (id, user_id, session_id, task_id, correlation_id, action, risk, tool_call_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        randomUUID(),
        entry.userId,
        entry.sessionId ?? null,
        entry.taskId ?? null,
        entry.correlationId ?? null,
        entry.action,
        entry.risk ?? null,
        entry.toolCallId ?? null,
        entry.detail == null ? null : JSON.stringify(entry.detail),
      ],
    );
    return mapAudit(expectRow(result.rows, "appendAudit"));
  }

  async listAudit(userId: string, limit = 100): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      "SELECT * FROM jarvis_audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit],
    );
    return result.rows.map(mapAudit);
  }

  async createApproval(record: Omit<ApprovalRecord, "id" | "requestedAt" | "status">): Promise<ApprovalRecord> {
    const result = await this.pool.query<ApprovalRow>(
      `INSERT INTO jarvis_approvals (id, user_id, session_id, task_id, tool_call_id, tool_name, arguments, risk, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        randomUUID(),
        record.userId,
        record.sessionId,
        record.taskId,
        record.toolCallId,
        record.toolName,
        JSON.stringify(record.arguments ?? null),
        record.risk,
        record.description,
      ],
    );
    return mapApproval(expectRow(result.rows, "createApproval"));
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query<ApprovalRow>("SELECT * FROM jarvis_approvals WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }

  async resolveApproval(id: string, status: "approved" | "denied" | "expired"): Promise<ApprovalRecord | undefined> {
    const result = await this.pool.query<ApprovalRow>(
      "UPDATE jarvis_approvals SET status = $2, resolved_at = now() WHERE id = $1 RETURNING *",
      [id, status],
    );
    const row = result.rows[0];
    return row ? mapApproval(row) : undefined;
  }

  async recordToolCall(record: ToolCallRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO jarvis_tool_calls (id, task_id, session_id, user_id, name, arguments, status, result, started_at, finished_at, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, result = EXCLUDED.result,
         finished_at = EXCLUDED.finished_at, duration_ms = EXCLUDED.duration_ms`,
      [
        record.id,
        record.taskId,
        record.sessionId,
        record.userId,
        record.name,
        JSON.stringify(record.arguments ?? null),
        record.status,
        record.result ? JSON.stringify(record.result) : null,
        record.startedAt,
        record.finishedAt ?? null,
        record.durationMs ?? null,
      ],
    );
  }

  async listToolCalls(taskId: string): Promise<ToolCallRecord[]> {
    const result = await this.pool.query("SELECT * FROM jarvis_tool_calls WHERE task_id = $1 ORDER BY started_at ASC", [taskId]);
    return result.rows.map(mapToolCall);
  }

  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    return {
      sessions: await this.listSessions(userId, 1000),
      messages: await this.pool.query("SELECT * FROM jarvis_messages WHERE user_id = $1 ORDER BY created_at ASC", [userId]).then((r) => r.rows.map(mapMessage)),
      episodic: await this.listEpisodic(userId, 1000),
      semantic: await this.listSemantic(userId, 1000),
      tasks: await this.listTasks(userId),
      audit: await this.listAudit(userId, 1000),
    };
  }

  async deleteUserData(userId: string): Promise<void> {
    // Borrado ATÓMICO: antes eran nueve `DELETE` sueltos y un fallo a mitad
    // dejaba datos personales a medias (una persona). Ahora todo ocurre en una
    // transacción: o se borra todo, o no se borra nada.
    await this.withTransaction(async (client) => {
      const statements = [
        "DELETE FROM jarvis_sessions WHERE user_id = $1",
        "DELETE FROM jarvis_messages WHERE user_id = $1",
        "DELETE FROM jarvis_episodic_memories WHERE user_id = $1",
        "DELETE FROM jarvis_semantic_memories WHERE user_id = $1",
        "DELETE FROM jarvis_tasks WHERE user_id = $1",
        "DELETE FROM jarvis_audit_log WHERE user_id = $1",
        "DELETE FROM jarvis_approvals WHERE user_id = $1",
        "DELETE FROM jarvis_tool_calls WHERE user_id = $1",
        // La caché guarda prompts y respuestas del usuario: se borra con el resto.
        "DELETE FROM jarvis_response_cache WHERE user_id = $1",
      ];
      for (const statement of statements) {
        await client.query(statement, [userId]);
      }
    });
  }
}

/** Fila obligatoria: una consulta que no devuelve fila es un error de contrato, no un `undefined` silencioso. */
function expectRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${context}: la consulta no devolvió ninguna fila`);
  return row;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function mapMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    taskId: row.task_id ? String(row.task_id) : undefined,
    kind: row.kind as StoredMessage["kind"],
    role: row.role as StoredMessage["role"],
    content: row.content as StoredMessage["content"],
    text: String(row.text ?? ""),
    name: row.name ? String(row.name) : undefined,
    tool_call_id: row.tool_call_id ? String(row.tool_call_id) : undefined,
    tool_calls: (row.tool_calls as StoredMessage["tool_calls"]) ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapEpisodic(row: Record<string, unknown>): EpisodicMemoryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    summary: String(row.summary),
    outcome: row.outcome as EpisodicMemoryRecord["outcome"],
    toolsUsed: (row.tools_used as string[]) ?? [],
    createdAt: iso(row.created_at),
  };
}

function mapSemantic(row: Record<string, unknown>): SemanticMemoryRecord {
  const score = row.score;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    key: String(row.key),
    value: String(row.value),
    source: row.source as SemanticMemoryRecord["source"],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    embedding: parseVector(row.embedding),
    score: score == null ? undefined : Number(score),
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title),
    notes: row.notes ? String(row.notes) : undefined,
    status: row.status as TaskRecord["status"],
    dueAt: row.due_at ? iso(row.due_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
    action: String(row.action),
    risk: row.risk ? String(row.risk) : undefined,
    toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
    detail: row.detail,
    createdAt: iso(row.created_at),
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    taskId: String(row.task_id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    arguments: row.arguments,
    risk: String(row.risk),
    description: String(row.description),
    status: row.status as ApprovalRecord["status"],
    requestedAt: iso(row.requested_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : undefined,
  };
}

function mapCachedResponse(row: Record<string, unknown>): CachedResponse {
  const embedding = row.embedding;
  return {
    userId: String(row.user_id),
    promptHash: String(row.prompt_hash),
    prompt: String(row.prompt),
    response: String(row.response),
    embedding: Array.isArray(embedding) ? (embedding as number[]).map(Number) : undefined,
    createdAt: iso(row.created_at),
    hits: Number(row.hits ?? 0),
  };
}

function mapToolCall(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    name: String(row.name),
    arguments: row.arguments,
    status: row.status as ToolCallRecord["status"],
    result: row.result as ToolCallRecord["result"],
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
  };
}
