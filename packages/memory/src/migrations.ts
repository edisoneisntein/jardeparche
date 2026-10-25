/**
 * ARCH-002 · Migraciones del esquema, en una sola fuente de verdad.
 *
 * Antes el DDL vivía en ficheros `.sql` que había que COPIAR al `dist` con
 * un script aparte (`copy-sql.mjs`). Eso era una fuente duplicada: el build
 * podía fallar (y fallaba en silencio) y el esquema de producción no era el
 * mismo que el del repositorio.
 *
 * Ahora el DDL está aquí, en TypeScript, y el gestor de migraciones lo
 * aplica dentro de UNA transacción:
 *
 *  · Si una migración falla (DDL con error de sintaxis), se hace `ROLLBACK`
 *    y la base de datos queda EXACTAMENTE como estaba: nunca a medias.
 *  · Cada migración aplicada se registra en `jarvis_schema_migrations`, así
 *    que el proceso es idempotente y solo se aplica lo que falta.
 *  · No depende de ficheros físicos en el `dist`: el mismo código que
 *    arranca el servidor es el que migra.
 */

/** Una migración: identificador estable y su DDL. */
export interface Migration {
  /** Identificador estable: nunca se reutiliza ni se renombra. */
  readonly id: string;
  /** DDL idempotente. */
  readonly sql: string;
}

/** Migraciones en orden de aplicación. */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_init",
    sql: `
-- JARVIS base schema. Idempotent: safe to run on every boot.
CREATE TABLE IF NOT EXISTS jarvis_users (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jarvis_sessions (
  id           uuid PRIMARY KEY,
  user_id      text NOT NULL,
  title        text NOT NULL DEFAULT 'Nueva sesión',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jarvis_sessions_user_idx ON jarvis_sessions (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS jarvis_messages (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES jarvis_sessions(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  task_id      text,
  kind         text NOT NULL,
  role         text NOT NULL,
  text         text NOT NULL DEFAULT '',
  content      jsonb,
  name         text,
  tool_call_id text,
  tool_calls   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jarvis_messages_session_idx ON jarvis_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS jarvis_messages_user_idx ON jarvis_messages (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jarvis_episodic_memories (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  session_id  uuid,
  task_id     text,
  summary     text NOT NULL,
  outcome     text NOT NULL,
  tools_used  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jarvis_episodic_user_idx ON jarvis_episodic_memories (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jarvis_tasks (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  title       text NOT NULL,
  notes       text,
  status      text NOT NULL DEFAULT 'open',
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jarvis_tasks_user_idx ON jarvis_tasks (user_id, status);
CREATE TABLE IF NOT EXISTS jarvis_audit_log (
  id             uuid PRIMARY KEY,
  user_id        text NOT NULL,
  session_id     uuid,
  task_id        uuid,
  correlation_id text,
  action         text NOT NULL,
  risk           text,
  tool_call_id   text,
  detail         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jarvis_audit_user_idx ON jarvis_audit_log (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jarvis_approvals (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  session_id  uuid NOT NULL,
  task_id     text NOT NULL,
  tool_call_id text NOT NULL,
  tool_name   text NOT NULL,
  arguments   jsonb,
  risk        text NOT NULL,
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS jarvis_approvals_session_idx ON jarvis_approvals (session_id, status);
CREATE TABLE IF NOT EXISTS jarvis_tool_calls (
  id          text PRIMARY KEY,
  task_id     text NOT NULL,
  session_id  uuid NOT NULL,
  user_id     text NOT NULL,
  name        text NOT NULL,
  arguments   jsonb,
  status      text NOT NULL,
  result      jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);
CREATE INDEX IF NOT EXISTS jarvis_tool_calls_task_idx ON jarvis_tool_calls (task_id);
`,
  },
  {
    id: "002_semantic",
    sql: `
-- Semantic memory with real embeddings. Requires the pgvector extension.
-- The \`vector\` type is intentionally dimension-less so a model swap does not
-- require a destructive migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS jarvis_semantic_memories (
  id         uuid PRIMARY KEY,
  user_id    text NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  source     text NOT NULL,
  embedding  vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS jarvis_semantic_user_idx ON jarvis_semantic_memories (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS jarvis_semantic_fts_idx ON jarvis_semantic_memories
  USING gin (to_tsvector('simple', key || ' ' || value));
`,
  },
  {
    id: "003_tool_call_ids",
    sql: `
-- Provider tool call ids are opaque strings (e.g. "call_abc"), not UUIDs.
-- Applied to databases created before this rule; safe to run repeatedly.
ALTER TABLE jarvis_tool_calls ALTER COLUMN id TYPE text USING id::text;
`,
  },
  {
    id: "004_response_cache",
    sql: `
-- PERF-002 · Caché de respuestas del modelo.
--
-- Es una caché, NO memoria: guarda respuestas completas para no repetir una
-- inferencia idéntica. La columna "embedding" permite además encontrar
-- coincidencias semánticas (pgvector). El "prompt_hash" da la coincidencia
-- exacta, que es la más barata.
CREATE TABLE IF NOT EXISTS jarvis_response_cache (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  prompt_hash text NOT NULL,
  prompt      text NOT NULL,
  response    text NOT NULL,
  embedding   vector,
  hits        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prompt_hash)
);
CREATE INDEX IF NOT EXISTS jarvis_response_cache_user_idx ON jarvis_response_cache (user_id, created_at DESC);
`,
  },
  {
    id: "005_vector_ann_index",
    sql: `
-- PERF · Índice vectorial ANN (HNSW) para las columnas de embedding.
--
-- pgvector exige una dimensión FIJA (vector(N)) para crear un índice HNSW, y
-- las columnas se declararon deliberadamente sin dimensión para que cambiar
-- de modelo de embeddings no exija una migración destructiva. Por eso el
-- bloque siguiente sólo actúa si algún día la columna tiene dimensión fija
-- (ALTER TABLE ... ALTER COLUMN embedding TYPE vector(N)): entonces crea el
-- índice automáticamente, sin intervención manual.
--
-- Mientras la columna no tenga dimensión, el coste de la búsqueda está
-- acotado por el índice b-tree de user_id: el escaneo y la ordenación se
-- hacen sobre las filas de ESE usuario, no sobre toda la tabla.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname IN ('jarvis_semantic_memories', 'jarvis_response_cache')
      AND a.attname = 'embedding'
      AND a.atttypmod > 0
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (%I vector_cosine_ops)',
      target.table_name || '_embedding_hnsw',
      target.table_name,
      target.column_name
    );
  END LOOP;
END $$;
`,
  },
];

/** Tabla donde se registra qué migraciones se han aplicado. */
export const MIGRATIONS_TABLE = "jarvis_schema_migrations";
