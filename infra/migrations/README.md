# Migraciones de base de datos

## Dónde viven

Las migraciones SQL **no** están en esta carpeta: viven en el paquete de memoria.

```
packages/memory/src/sql/
├── 001_init.sql       # esquema base (usuarios, sesiones, mensajes, memoria, tareas, auditoría)
└── 002_semantic.sql   # memoria semántica + extensión pgvector
```

## Cómo se aplican

- **Al arrancar**: `PostgresStore.init()` lee `packages/memory/src/sql`, ordena los ficheros por nombre y ejecuta cada uno. Esto ocurre cuando `PERSISTENCE=postgres` y se crea el store.
- **Manualmente**: `pnpm db:migrate` (equivale a `pnpm --filter @jarvis/server db:migrate`; requiere `apps/server`).
- El build de `@jarvis/memory` copia los `.sql` a `dist` (`scripts/copy-sql.mjs`), de modo que se aplican igual desde código compilado.

## Garantías

- **Idempotentes**: todo usa `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` y `CREATE EXTENSION IF NOT EXISTS`. Es seguro re-aplicarlas en cada arranque.
- **Sin `down`**: no hay migraciones de reversión. El rollback se hace restaurando un backup (ver `docs/operations.md`).
- **Orden por nombre**: `001_` antes que `002_`, etc. Añade nuevas migraciones con el siguiente prefijo numérico.
- **Requieren pgvector**: `002_semantic.sql` ejecuta `CREATE EXTENSION IF NOT EXISTS vector`. Usa la imagen `pgvector/pgvector:pg16` (ya publicada en `localhost:55432`). Con una imagen Postgres normal, esa migración falla.

## Detalle de las migraciones

### `001_init.sql`
Crea `jarvis_users`, `jarvis_sessions`, `jarvis_messages`, `jarvis_episodic_memories`, `jarvis_tasks`, `jarvis_audit_log`, `jarvis_approvals`, `jarvis_tool_calls`, con sus índices. `jarvis_messages.session_id` referencia `jarvis_sessions(id)` con `ON DELETE CASCADE`.

### `002_semantic.sql`
`CREATE EXTENSION IF NOT EXISTS vector`, crea `jarvis_semantic_memories` con `embedding vector` (dimensionless a propósito), `UNIQUE (user_id, key)` e índice GIN de texto completo.

## Cómo añadir una migración

1. Crea `packages/memory/src/sql/003_mi_cambio.sql` (siguiente número).
2. Usa `IF NOT EXISTS`/`IF EXISTS` para mantener la idempotencia.
3. Reinicia el server o ejecuta `pnpm db:migrate`.
4. Haz backup antes de cambios destructivos (`ALTER TABLE`, `DROP`).

## Verificación rápida

```bash
docker exec -it jarvis-db psql -U jarvis -d jarvis -c "\dt" -c "\dx"
```

Deben aparecer todas las tablas `jarvis_*` y la extensión `vector`.
