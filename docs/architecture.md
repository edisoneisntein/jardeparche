# Arquitectura de JARVIS

Documento técnico de subsistemas, flujo de datos, máquina de estados, esquema de persistencia, pipeline de ejecución de herramientas y modelo de degradación.

> Honestidad: este documento describe el **contrato** y los paquetes **presentes**. Todo lo listado como «Presente» tiene su código en el repositorio y, cuando la capacidad depende de un servicio externo, se declara el estado real (incluido `unavailable`). No se documenta como funcionando nada cuyo código no exista.

---

## 1. Subsistemas

| Paquete | Responsabilidad | Estado |
| --- | --- | --- |
| `@jarvis/shared` | Contratos y validación: `AgentState` + transiciones, `ServerEvent`/`ClientCommand` (zod), `RiskLevel`, `ToolResult`, `HealthReport`. Fuente de verdad de tipos. | Presente |
| `@jarvis/ai-provider` | Adaptador NVIDIA NIM (API compatible OpenAI): `chat`, `stream` (SSE), `tool_calls`, `embed`, `health`, reintentos/backoff, cancelación, `probeCapabilities`. Incluye `FakeProvider` para tests. | Presente |
| `@jarvis/memory` | `Store` (contrato), `MemoryStore` (in-process), `PostgresStore` (pg + pgvector), `MemoryService` (recall, hechos autorizados, aislamiento por usuario, export/delete). | Presente |
| `@jarvis/tool-registry` | `ToolRegistry`: **única vía autorizada de efectos**. Herramientas builtin con `risk`, `requiresApproval`, `timeoutMs`, validación zod y `availability()`. Gate estático de código + sandbox de ejecución en contenedor efímero. | Presente |
| `@jarvis/agent-runtime` | Orquestador del turno: interpretar → recall → plan → (aprobar) → ejecutar → observar → responder. Límites y broker de aprobaciones. | `runtime.ts` presente; faltan `state-machine.ts`, `prompt.ts`, `approval-broker.ts` |
| `@jarvis/voice` | STT/TTS. El navegador provee la voz vía Web Speech API; el server solo publica hints. | Presente |
| `@jarvis/perception` | Análisis de imágenes bajo demanda (una captura, nunca captura continua). | Presente |
| `@jarvis/server` | Fastify, HTTP + WebSocket en `8787`. Valida commands, emite eventos, persiste. | Presente |
| `@jarvis/web` | React + Vite + react-three-fiber. HUD, chat, voz, cámara. Puerto 5173. | Presente |

---

## 2. Flujo de datos

1. El navegador abre un WebSocket contra el server y envía `chat.send { sessionId, text }`.
2. El server crea una tarea (`taskId`) y llama a `AgentRuntime.runTurn(actor, text, taskId)`.
3. El runtime:
   - persiste el mensaje de usuario (`MemoryService.recordUserMessage`);
   - recupera contexto acotado (`memory.recall`: últimos mensajes + episodios + hechos semánticos autorizados);
   - construye `system + historial + user` y consulta al provider con las tools **disponibles**.
4. Si el modelo pide tool calls, el runtime entra en el pipeline de tools (sección 5) y devuelve los resultados al modelo como mensajes `role: "tool"`.
5. El runtime emite deltas (`assistant.delta`), el mensaje final (`assistant.message_completed`) y registra el episodio y la auditoría.
6. El server reenvía los eventos al navegador, que actualiza el HUD.

Todo el estado observable se emite como `ServerEvent` (misma unión zod que valida el navegador).

---

## 3. Máquina de estados del agente

Estados (`AGENT_STATES`):

`IDLE`, `LISTENING`, `UNDERSTANDING`, `PLANNING`, `WAITING_FOR_APPROVAL`, `EXECUTING`, `SPEAKING`, `INTERRUPTED`, `COMPLETED`, `FAILED`.

Transiciones legales (`AGENT_TRANSITIONS`, de `packages/shared/src/state.ts`):

| Desde | Hacia |
| --- | --- |
| `IDLE` | `LISTENING`, `UNDERSTANDING`, `FAILED` |
| `LISTENING` | `UNDERSTANDING`, `INTERRUPTED`, `IDLE`, `FAILED` |
| `UNDERSTANDING` | `PLANNING`, `SPEAKING`, `INTERRUPTED`, `FAILED` |
| `PLANNING` | `EXECUTING`, `WAITING_FOR_APPROVAL`, `SPEAKING`, `UNDERSTANDING`, `INTERRUPTED`, `FAILED` |
| `WAITING_FOR_APPROVAL` | `EXECUTING`, `INTERRUPTED`, `COMPLETED`, `FAILED` |
| `EXECUTING` | `PLANNING`, `UNDERSTANDING`, `SPEAKING`, `INTERRUPTED`, `COMPLETED`, `FAILED` |
| `SPEAKING` | `IDLE`, `COMPLETED`, `INTERRUPTED`, `LISTENING`, `FAILED` |
| `INTERRUPTED` | `IDLE`, `LISTENING`, `UNDERSTANDING`, `FAILED` |
| `COMPLETED` | `IDLE`, `LISTENING`, `UNDERSTANDING`, `FAILED` |
| `FAILED` | `IDLE`, `LISTENING`, `UNDERSTANDING` |

Reglas:

- Una transición fuera de la tabla es un **bug**: `canTransition` debe rechazarla y el runtime lo registra como `warn` en el log de auditoría (comportamiento de `runtime.ts`).
- Cada cambio de estado corresponde a un **paso real**. **No hay timers decorativos**.
- El estado se emite como `assistant.state_changed { state, detail? }`, con `ts` y `taskId`.

---

## 4. Esquema de persistencia (PostgreSQL + pgvector)

Migraciones idempotentes aplicadas al arrancar (`packages/memory/src/sql`):

### `jarvis_users`
`id` (text, PK), `created_at`.

### `jarvis_sessions`
`id` (uuid PK), `user_id`, `title`, `created_at`, `updated_at`, `last_seen_at`. Índice `(user_id, updated_at DESC)`.

### `jarvis_messages`
`id` (uuid PK), `session_id` (FK → `jarvis_sessions`, `ON DELETE CASCADE`), `user_id`, `task_id`, `kind` (`user|assistant|tool|system|summary`), `role`, `text` (texto buscable redactado), `content` (jsonb), `name`, `tool_call_id`, `tool_calls` (jsonb), `created_at`.

### `jarvis_episodic_memories`
`id`, `user_id`, `session_id`, `task_id`, `summary`, `outcome` (`completed|failed|cancelled`), `tools_used` (jsonb), `created_at`.

### `jarvis_semantic_memories`
`id`, `user_id`, `key`, `value`, `source` (`explicit_user|user_document`), `embedding vector` (sin dimensión declarada), `created_at`, `updated_at`. `UNIQUE (user_id, key)`. Índice GIN de texto. **Solo contiene hechos que el usuario autorizó explícitamente** (`memory.remember` exige `confirmedByUser: true` y `requiresApproval`).

### `jarvis_tasks`
`id`, `user_id`, `title`, `notes`, `status` (`open|done`), `due_at`, `created_at`, `updated_at`.

### `jarvis_audit_log`
`id`, `user_id`, `session_id`, `task_id`, `correlation_id`, `action`, `risk`, `tool_call_id`, `detail` (jsonb), `created_at`. Registra aprobaciones y ejecuciones.

### `jarvis_approvals`
`id`, `user_id`, `session_id`, `task_id`, `tool_call_id`, `tool_name`, `arguments` (jsonb), `risk`, `description`, `status` (`pending|approved|denied|expired`), `requested_at`, `resolved_at`.

### `jarvis_tool_calls`
`id`, `task_id`, `session_id`, `user_id`, `name`, `arguments` (jsonb), `status` (`started|awaiting_approval|completed|failed|denied|unavailable`), `result` (jsonb), `started_at`, `finished_at`, `duration_ms`.

Aislamiento: casi todas las consultas filtran por `user_id`; `MemoryService` nunca mezcla usuarios (cubierto por `memory-service.test.ts`).

> Sobre `embedding vector`: se declara **sin dimensión** a propósito para que un cambio de modelo de embeddings no obligue a una migración destructiva. Ver la advertencia de re-embedding en `docs/operations.md`.

---

## 5. Pipeline de ejecución de herramientas

```
modelo propone tool_call
        │
        ▼
1. ¿Existe la tool?           no → tool.failed(unknown_tool)
        │ sí
        ▼
2. parse/validación zod       inválido → tool.failed + audit tool.rejected
   (tool.parse)                (nunca hay efecto antes de validar)
        │ ok
        ▼
3. ¿Llamada repetida?         sí → tool.failed (anti-bucle)
        │ no
        ▼
4. availability()             no configurada → ToolResult{ok:false, unavailable:true}
        │ disponible
        ▼
5. requiresApproval?          sí → WAITING_FOR_APPROVAL
        │                            ├─ emite tool.awaiting_approval
        │                            ├─ audit tool.approval_requested
        │                            ├─ espera approval.respond
        │                            └─ denied/expired → tool.failed + audit tool.denied
        │ no / aprobado
        ▼
6. EXECUTING: tool.started   (audit + jarvis_tool_calls status=started)
        │
        ├─ timeout → ToolTimeoutError → tool.failed
        ▼
7. ToolResult validado con ToolResultSchema
        │
        ▼
8. tool.completed | tool.failed  + recordToolMessage + audit
        │
        ▼
9. el resultado vuelve al modelo como mensaje role:"tool"
```

Herramientas builtin y riesgo:

| Tool | Riesgo | Aprobación |
| --- | --- | --- |
| `time.now`, `system.info`, `math.calculate`, `task.list`, `memory.search` | `public_read` | No |
| `document.list` | `public_read` | No |
| `document.read`, `task.create`, `task.complete` | `local_reversible` | No |
| `memory.remember` | `local_reversible` | **Sí** |
| `task.delete`, `memory.forget` | `destructive` | **Sí** |
| `web.search` | `public_read` | No (no disponible sin proveedor) |

`external_effect` existe en el modelo de riesgo pero ninguna tool builtin lo usa todavía.

Límites del bucle (`DEFAULT_LIMITS`): `maxIterations: 6`, `maxToolCalls: 8`, `maxDurationMs: 120000`, `maxHistoryMessages: 16`.

---

## 6. Modelo de fallo y degradación

- **`unknown` es un estado de primera clase.** `aggregateStatus` prioriza `down` > `degraded` > `unknown` > `up`, y `unknown` **nunca** se reporta como `up`. Si no se ha medido un componente, su estado es `unknown`, no una suposición.
- **Proveedor**: errores clasificados por `classifyHttp` en `auth`, `rate_limit`, `timeout`, `network`, `invalid_request`, `unavailable`, `aborted`, `unknown`. Solo `rate_limit`, `timeout`, `network` y `unavailable` son reintentables, con backoff exponencial acotado (`maxRetries`, por defecto 2).
- **Tools**: una tool sin configurar devuelve `{ ok: false, unavailable: true, error: "not_configured" }`; nunca un resultado falso. Un timeout produce `ToolTimeoutError`.
- **Interrupción**: `chat.cancel` aborta la tarea (`AbortController`) → estado `INTERRUPTED`, evento `task.cancelled`.
- **Errores del turno**: estado `FAILED`, evento `agent.error { message, recoverable }`, episodio `outcome: "failed"` y auditoría `task.failed`. El bucle vuelve a `IDLE`.
- **Sin métricas**: no hay exportador Prometheus/OTel; los puntos de medición disponibles (latencias, duraciones) están descritos en `docs/operations.md`.

---

## 7. Percepción y voz (contrato)

- `perception.image` (command) envía una imagen como data URL (> tamaño máximo 12 MB). El runtime la analiza **una vez** con el modelo de visión y responde con `assistant.message_completed`. No hay captura continua ni grabación en background.
- La voz vive en el navegador (Web Speech API). El server emite `voice.*` y acepta `voice.transcript`; los proveedores server-side (`VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER`) son opcionales y hoy por defecto `browser`.
- `@jarvis/voice` y `@jarvis/perception` **no existen todavía** como paquetes; el contrato está congelado en `@jarvis/shared`.
