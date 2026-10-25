# API de JARVIS

Contrato HTTP y protocolo WebSocket. Los eventos y comandos son **exactamente** la unión zod definida en `packages/shared/src/events.ts`; el navegador los valida con el mismo esquema que el server.

> Estado: `apps/server` está **en construcción** en este checkout. La sección WebSocket (eventos/comandos) es el contrato congelado y verificable en `@jarvis/shared`. La sección HTTP es el **contrato objetivo**; verifica la implementación real en `apps/server` antes de asumirla. No se documenta como funcionando nada cuyo código no exista.

---

## 1. Transports

| Transporte | Dirección por defecto |
| --- | --- |
| HTTP | `http://localhost:8787` |
| WebSocket | `ws://localhost:8787/ws` |

Autenticación: si `JARVIS_ACCESS_TOKEN` está definido, las peticiones requieren `Authorization: Bearer <token>`. Ver `docs/security.md`.

---

## 2. HTTP (contrato objetivo)

Todas las respuestas son JSON. `GET /health` es el único endpoint que no requiere autenticación (para sondas).

| Método | Ruta | Descripción | Estado |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `HealthReport` agregado (ver §4). Sin autenticación. | **Implementado** |
| `GET` | `/api/health/stream` | `HealthReport` en streaming (SSE): un evento `data:` al abrir y otro cada 5 s. Sin autenticación. | **Implementado** |
| `GET` | `/api/metrics` | Contadores y latencias del servidor (`turn.duration`, `tool.duration`), conexiones y tareas activas. | **Implementado** |
| `GET` | `/api/users` | Usuarios que el servidor autoriza (`JARVIS_USERS`). | **Implementado** |
| `GET` | `/api/voice` | Proveedores STT/TTS declarados y su estado. | **Implementado** |
| `GET` | `/api/capabilities` | Capacidades del modelo, catálogo de tools y proveedores de voz. | **Implementado** |
| `GET` | `/api/sessions?limit=` | Sesiones del usuario. | **Implementado** |
| `POST` | `/api/sessions` | Crea una sesión (`{ title? }`). | **Implementado** |
| `DELETE` | `/api/sessions/:id` | Borra una sesión. | **Implementado** |
| `GET` | `/api/sessions/:id/messages?limit=` | Mensajes de una sesión. | **Implementado** |
| `GET` | `/api/tasks?status=open\|done\|all` | Tareas del usuario. | **Implementado** |
| `GET` | `/api/memory/facts?limit=` | Hechos semánticos autorizados. | **Implementado** |
| `DELETE` | `/api/memory/facts/:id` | Borra un hecho semántico. | **Implementado** |
| `GET` | `/api/memory/episodes?limit=` | Episodios del usuario. | **Implementado** |
| `GET` | `/api/memory/export` | Exporta todos los datos del usuario. | **Implementado** |
| `DELETE` | `/api/memory` | Borra todos los datos del usuario. | **Implementado** |
| `GET` | `/api/audit?limit=` | Entradas de `jarvis_audit_log`. | **Implementado** |
| `GET` | `/api/governance` | Niveles de riesgo, tools que requieren aprobación y reglas. | **Implementado** |
| `POST` | `/api/perception/analyze` | Analiza UN fotograma (`{ sessionId, dataUrl, prompt? }`). | **Implementado** |
| `GET` | `/health/live` | Liveness: `200` si el proceso responde. | Objetivo (no implementado) |
| `GET` | `/health/ready` | Readiness: `200` si DB y provider están listos. | Objetivo (no implementado) |
| `GET` | `/api/export` | Alias de `/api/memory/export`. | Objetivo (no implementado) |
| `DELETE` | `/api/account` | Alias de `DELETE /api/memory`. | Objetivo (no implementado) |

Códigos de error previstos: `400` argumentos inválidos, `401` token ausente/incorrecto, `404` recurso inexistente, `409` conflicto, `429` rate limit, `500` error interno, `503` dependencia no lista.

Ejemplo de `/api/health` degradado:

```json
{ "status": "degraded", "components": [
  { "component": "brain", "status": "up", "checkedAt": "2026-10-19T10:00:00.000Z", "latencyMs": 412 },
  { "component": "database", "status": "degraded", "detail": "postgres: connection slow", "checkedAt": "2026-10-19T10:00:00.000Z" }
], "checkedAt": "2026-10-19T10:00:00.000Z" }
```

---

## 3. WebSocket: sobre común

Cada mensaje es un objeto JSON con discriminante `type`. **Sobre del evento** (ver `events.ts`):

```ts
{ sessionId: string, taskId?: string, ts: string /* ISO-8601 */, ... }
```

- `sessionId` y `ts` están **siempre** presentes.
- `taskId` está presente en eventos ligados a un turno/tarea (todos los `assistant.*`, `tool.*`, `voice.*`, `perception.*`, `task.cancelled`, `agent.error`). El esquema lo declara opcional porque `session.created` y algunos eventos de sistema son de sesión, no de tarea.

Los comandos entrantes se validan con `ClientCommandSchema`; un command inválido debe rechazarse sin efectos.

---

## 4. Eventos del servidor (`ServerEvent`)

| `type` | Campos además del sobre | Significado |
| --- | --- | --- |
| `session.created` | `userId` | Sesión abierta. |
| `assistant.state_changed` | `state` (uno de los 10 estados), `detail?` | Transición real del agente. |
| `assistant.delta` | `text` | Fragmento de la respuesta en streaming. |
| `assistant.message_completed` | `text`, `usage?` (`promptTokens`,`completionTokens`,`totalTokens`) | Respuesta final del turno. |
| `tool.started` | `toolCallId`, `name`, `arguments`, `risk` | La tool empieza a ejecutarse. |
| `tool.awaiting_approval` | `toolCallId`, `name`, `arguments`, `risk`, `approvalId`, `description` | Se requiere aprobación del usuario. |
| `tool.completed` | `toolCallId`, `name`, `summary`, `data?`, `durationMs` | Tool ejecutada con éxito. |
| `tool.failed` | `toolCallId`, `name`, `error`, `unavailable` | Tool falló o no está configurada. |
| `voice.input_started` | — | Llega una transcripción de voz: el servidor abre el turno. |
| `voice.transcript` | `text`, `final` | Transcripción (parcial o final). |
| `voice.output_started` | `generationId`, `text` | Empieza la síntesis de voz. |
| `voice.output_stopped` | `generationId`, `reason` | Termina la síntesis (`completed` / `interrupted`). |
| `perception.image_received` | `width`, `height`, `bytes`, `cameraActive` | Imagen recibida para análisis puntual. |
| `perception.camera_state` | `cameraActive` | Estado de la cámara. |
| `system.health_changed` | `component`, `status` (`up\|degraded\|down\|unknown`), `detail?` | Cambio de salud de un componente. |
| `task.cancelled` | — | Turno cancelado por el usuario. |
| `agent.error` | `message`, `recoverable` | Error del agente. |

Ejemplos:

```json
{ "type": "assistant.state_changed", "sessionId": "s1", "taskId": "t1", "ts": "2026-10-19T10:00:01.000Z", "state": "PLANNING", "detail": "decidiendo si uso herramientas" }
```

```json
{ "type": "tool.awaiting_approval", "sessionId": "s1", "taskId": "t1", "ts": "2026-10-19T10:00:02.000Z", "toolCallId": "call_1", "name": "task.delete", "arguments": { "id": "a1b2" }, "risk": "destructive", "approvalId": "appr_9", "description": "Ejecutar Eliminar tarea (destructive) con los argumentos indicados." }
```

```json
{ "type": "tool.completed", "sessionId": "s1", "taskId": "t1", "ts": "2026-10-19T10:00:03.000Z", "toolCallId": "call_2", "name": "time.now", "summary": "domingo, 19 de octubre de 2026, 12:00:00 (2026-10-19T10:00:00.000Z)", "data": { "iso": "2026-10-19T10:00:00.000Z" }, "durationMs": 2 }
```

---

## 5. Comandos del cliente (`ClientCommand`)

| `type` | Campos | Efecto |
| --- | --- | --- |
| `chat.send` | `sessionId`, `text` (1–8000) | Envía un turno al agente. |
| `chat.cancel` | `sessionId`, `taskId?` | Cancela el turno (→ `task.cancelled`, estado `INTERRUPTED`). |
| `approval.respond` | `sessionId`, `approvalId`, `approve` | Aprueba/deniega una acción pendiente. |
| `voice.transcript` | `sessionId`, `text`, `final` | Entrega una transcripción al agente: con `final: true` el servidor ABRE el turno (no hay que enviar además un `chat.send`). |
| `perception.image` | `sessionId`, `dataUrl` (≤ 12 MB), `prompt?` (≤ 2000), `cameraActive` | Analiza **una** imagen con el modelo de visión. |
| `session.describe` | `sessionId` | Solicita un resumen/estado de la sesión. |
| `ping` | — | Comprobación de vida. |

Ejemplos:

```json
{ "type": "chat.send", "sessionId": "s1", "text": "¿qué hora es?" }
```

```json
{ "type": "approval.respond", "sessionId": "s1", "approvalId": "appr_9", "approve": false }
```

---

## 6. Secuencia típica con tool y aprobación

```
cliente → chat.send
server  → session.created (si es nueva)
server  → assistant.state_changed { UNDERSTANDING }
server  → assistant.state_changed { PLANNING }
server  → tool.started { time.now, risk: public_read }
server  → tool.completed { summary, durationMs }
server  → assistant.state_changed { PLANNING }
server  → assistant.delta { text }
server  → assistant.message_completed { text }
server  → assistant.state_changed { COMPLETED }
server  → assistant.state_changed { IDLE }
```

Con tool destructiva, entre `PLANNING` y `EXECUTING` aparecen `assistant.state_changed { WAITING_FOR_APPROVAL }` y `tool.awaiting_approval`; el turno se reanuda solo con `approval.respond { approve: true }`.

---

## 7. Notas de compatibilidad

- Los tipos de `@jarvis/shared` son la única fuente de verdad; si un evento no está en `ServerEventSchema`, no existe.
- `taskId` y `ts` son strings ISO-8601; `data`/`arguments`/`detail` son `unknown` sobre el cable (validados por cada tool).
- No se garantiza orden entre `assistant.delta` de tareas distintas; sí dentro de una misma tarea.
