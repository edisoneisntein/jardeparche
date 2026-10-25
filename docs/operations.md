# Operación de JARVIS

Salud, logs, ids de correlación, métricas, retención/purga, backup/restore de PostgreSQL y procedimiento de cambio de modelo.

> Honestidad: no existe todavía un exportador de métricas (Prometheus/OTel). Este documento distingue entre lo que **ya se mide en código** (disponible para instrumentar) y lo que es **objetivo** pendiente de implementar en `apps/server`.

---

## 1. Endpoints de salud

| Endpoint | Qué responde | Semántica |
| --- | --- | --- |
| `GET /health` | `HealthReport` agregado | Agrega todos los componentes |
| `GET /health/live` | `200` si el proceso responde | Liveness: no toca dependencias |
| `GET /health/ready` | `200` si DB y provider están listos; `503` si no | Readiness: sí toca dependencias |

Agregación (`aggregateStatus`): `down` > `degraded` > `unknown` > `up`. **`unknown` nunca se reporta como `up`.** Si un componente no se ha medido, su estado es `unknown`, no una suposición.

Detalle de qué sondea cada componente en [`infra/monitoring/healthcheck.md`](../infra/monitoring/healthcheck.md).

---

## 2. Logs

Formato previsto (JSON por línea). Campos estables:

| Campo | Descripción |
| --- | --- |
| `ts` | Marca temporal ISO-8601 |
| `level` | `debug` \| `info` \| `warn` \| `error` |
| `component` | Subsistema emisor (`server`, `provider`, `memory`, `tools`, `runtime`) |
| `msg` | Mensaje legible |
| `correlationId` | Id de la tool call / turno que originó el evento |
| `sessionId` | Sesión asociada |
| `taskId` | Tarea/turno asociado |
| `toolCallId` | Llamada concreta a tool |
| `event` | `ServerEvent["type"]` relacionado, si aplica |
| `model` | Modelo NIM usado |
| `durationMs` | Duración de la operación |
| `errorKind` | `ProviderErrorKind` (`auth`, `rate_limit`, `timeout`, `network`, `invalid_request`, `unavailable`, `aborted`, `unknown`) |
| `retryable` | Si el error admite reintento |

Reglas:

- `LOG_LEVEL` controla el verbosidad (`debug`..`error`).
- **Nunca** se registran `NVIDIA_API_KEY`, cabeceras `Authorization` ni `JARVIS_ACCESS_TOKEN`.
- Los hallazgos de seguridad (transición ilegal, argumentos inválidos) se registran como `warn`/`error` y también en auditoría.

---

## 3. Ids de correlación

- `sessionId`: sesión de usuario.
- `taskId`: un turno completo (desde `chat.send` hasta `assistant.message_completed`).
- `correlationId`: **id de la tool call** (`toolCallId`), que enlaza logs, `ServerEvent`, `jarvis_tool_calls` y `jarvis_audit_log`.
- Regla práctica: para investigar una ejecución, busca por `correlationId`/`toolCallId` en logs, en `jarvis_tool_calls` y en `jarvis_audit_log`.

---

## 4. Métricas

### Ya disponibles en código (listas para instrumentar)

| Métrica | Origen |
| --- | --- |
| Latencia total de inferencia | `ChatResponse.totalLatencyMs` (`nim-provider.ts`) |
| Latencia hasta el primer token | `ChatResponse.firstTokenLatencyMs` (streaming) |
| Duración de tool | `durationMs` en `tool.completed` y `jarvis_tool_calls.duration_ms` |
| Uso de tokens | `usage` (`promptTokens`, `completionTokens`, `totalTokens`) |
| Reintentos/errores del provider | `withRetry` + `ProviderError.kind`/`retryable` |
| Tareas activas | `AgentRuntime.activeTaskCount()` |
| Resultado de tareas | `task.completed`/`task.cancelled`/`task.failed` en auditoría |

### Objetivo (pendiente de implementar)

- Histogramas de latencia de inferencia y de primer token.
- Contador de tool calls por `name`/`status`.
- Contador de tareas por `outcome` (`completed`/`failed`/`cancelled`).
- Gauge de tareas activas y de aprobaciones pendientes.
- Contador de errores del provider por `kind`.

Mientras no exista exportador, estas métricas se pueden reconstruir desde `jarvis_tool_calls`, `jarvis_audit_log` y los `ServerEvent` capturados por un cliente.

---

## 5. Retención y purga

- `MEMORY_RETENTION_DAYS` controla la retención de **memoria episódica**. `0` = conservar siempre.
- `MemoryService.purgeExpired()` borra episodios anteriores al corte (`purgeEpisodicBefore`).
- **Limitación actual**: `purgeExpired()` opera sobre el usuario `"local"` y no hay job programado; para multi-usuario o programación, hay que invocarla explícitamente. Documentado como limitación, no como capacidad.

Purga manual:

```bash
docker exec -it jarvis-db psql -U jarvis -d jarvis -c \
  "DELETE FROM jarvis_episodic_memories WHERE created_at < now() - interval '30 days';"
```

---

## 6. Backup y restauración de PostgreSQL

### Backup

```bash
docker exec -t jarvis-db pg_dump -U jarvis -d jarvis -Fc -f /tmp/jarvis.dump
docker cp jarvis-db:/tmp/jarvis.dump ./jarvis-$(date +%Y%m%d).dump
```

### Restauración

```bash
docker compose up -d db
docker cp ./jarvis-YYYYMMDD.dump jarvis-db:/tmp/jarvis.dump
docker exec -t jarvis-db pg_restore -U jarvis -d jarvis --clean --if-exists /tmp/jarvis.dump
```

Notas:

- Restaura sobre una base ya migrada; si partes de cero, arranca `db`, aplica `pnpm db:migrate` y luego restaura los datos (`--data-only` si quieres conservar el esquema actual).
- El volumen es `jarvis_pgdata`. Para un backup frío, `docker compose stop db` antes de copiar el volumen.
- Verifica tras restaurar: `SELECT count(*) FROM jarvis_semantic_memories;` y que `CREATE EXTENSION vector` sigue presente (`\dx`).

---

## 7. Procedimiento de cambio de modelo

Los modelos **se verifican, no se asumen**. Algunos devuelven `404`/`410` para esta cuenta.

1. **Elegir** el nuevo id de modelo.
2. **Probar** con la sonda:

   ```bash
   NVIDIA_MODEL=nvidia/nuevo-modelo pnpm --filter @jarvis/ai-provider probe
   ```

   Debe reportar `source: "probe"`, `streaming: true` y `tools: true` (o el subconjunto que necesites).
3. **Actualizar** `.env` (`NVIDIA_MODEL` o `NVIDIA_VISION_MODEL`).
4. **Reiniciar** el server y comprobar `GET /api/capabilities` (o `probeCapabilities`).
5. **Rollback**: vuelve al valor anterior del `.env` y reinicia. No hay migración de datos asociada al cambio de modelo de chat/visión.

### Cambio del modelo de embeddings (cuidado)

- La columna `jarvis_semantic_memories.embedding` es `vector` **sin dimensión declarada**, así que un cambio de dimensión no rompe el esquema.
- Pero las búsquedas comparan vectores entre sí: si cambias de dimensión (p. ej. de 2048 a otra), las filas antiguas **dejan de ser comparables** con las nuevas consultas.
- Procedimiento seguro: tras cambiar `NVIDIA_EMBEDDING_MODEL`, **re-embeder** los hechos semánticos (o vaciar esa tabla si no importan) antes de confiar en la búsqueda por similitud.
- Recuerda: `nvidia/nemotron-3-embed-1b` (2048 dim) es el único modelo de embeddings operativo para esta cuenta.

---

## 8. Parada y limpieza

```bash
pnpm infra:down            # detiene y elimina contenedores (conserva el volumen)
docker compose down -v     # ⚠️ elimina también jarvis_pgdata (borra la memoria)
```
