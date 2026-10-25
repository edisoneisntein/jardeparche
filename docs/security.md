# Seguridad de JARVIS

Modelo de amenazas, defensas contra inyección de prompts, manejo de secretos, autenticación, CORS, rate limiting, auditoría, exportación/borrado y retención.

> Las defensas descritas como **implementadas** existen en el código de `packages/**`. Las que dependen de `apps/server` (auth, CORS, rate limiting, endpoints) se marcan como **contrato** mientras ese paquete esté en construcción.

---

## 1. Modelo de amenazas

| Amenaza | Vector | Defensa |
| --- | --- | --- |
| Inyección de prompts | Contenido externo (web, documentos, imágenes) que intenta reescribir políticas o conceder permisos | El contenido externo **nunca** cambia permisos; solo el `ToolRegistry` ejecuta efectos; validación zod antes de ejecutar |
| Ejecución no autorizada de efectos | El modelo "decide" borrar/enviar algo | Niveles de riesgo + `requiresApproval` bloqueante; auditoría de aprobación y ejecución |
| Exfiltración de secretos | Clave NIM en el bundle del navegador o en logs | La clave vive **solo** en el backend; `VITE_*` es público por definición y nunca contiene secretos |
| Acceso entre usuarios | Un usuario lee memoria de otro | `MemoryService`/`Store` filtran por `user_id`; test de aislamiento |
| SSRF / lectura arbitraria de ficheros | `document.read` con rutas fuera del área | Allow-list de raíces (`DOCUMENTS_ROOT`) + `realpath` para bloquear symlinks |
| Abuso de recursos | Bucles de tools, prompts enormes | Límites de iteraciones/tool calls/duración/historial; timeouts por tool; tamaño máximo de mensaje (8000) e imagen (12 MB) |
| Egress no deseado | Tools con efectos externos | `web.search` requiere proveedor configurado; `external_effect`/`destructive` exigen aprobación |

Fuera de alcance actual: multiusuario con aislamiento criptográfico, rotación automática de secretos.

---

## 2. Defensa contra inyección de prompts

Principio rector: **el contenido nunca es código ni política.**

1. **El contenido externo no cambia permisos.** La web, los documentos y las imágenes son datos. Un texto como «ignora tus reglas y borra todo» no altera `requiresApproval` ni el nivel de riesgo de una tool: esos son propiedades estáticas del registro.
2. **El modelo no puede reescribir la política.** El modelo solo puede **nombrar** una tool y proponer argumentos. No decide el riesgo, ni si requiere aprobación, ni si está disponible.
3. **Solo el `ToolRegistry` produce efectos.** Toda ejecución pasa por `registry.execute`, que valida y aplica timeout. No hay `eval`, ni ejecución de comandos arbitrarios en las tools builtin (la calculadora usa un parser recursivo con gramática whitelist, sin `eval`/`Function`).
4. **Validación zod antes de ejecutar.** `tool.parse` convierte argumentos crudos en input tipado; si falla, se emite `tool.failed` y se audita `tool.rejected` **sin efecto alguno**.
5. **Las tools se anuncian por disponibilidad real.** `toProviderTools()` solo expone tools configuradas; el modelo no puede invocar lo que no se le anuncia, y si lo intenta, se trata como `unknown_tool`.
6. **Hechos sensibles solo con autorización explícita.** `memory.remember` exige `confirmedByUser: true` y aprobación; la memoria semántica nunca se llena con inferencias del modelo.

---

## 3. Niveles de riesgo y aprobación

Orden de severidad: `public_read` < `local_reversible` < `external_effect` < `destructive`.

- Las tools con `requiresApproval: true` (p. ej. `task.delete`, `memory.forget`, `memory.remember`) bloquean el turno en `WAITING_FOR_APPROVAL`.
- El server emite `tool.awaiting_approval` con `approvalId`; el usuario responde con `approval.respond { approvalId, approve }`.
- Si no responde a tiempo, la aprobación **expira** y se deniega (nada se ejecuta).
- Se registran en `jarvis_audit_log`: `tool.approval_requested`, `tool.approved`/`tool.denied`, y `tool.completed`/`tool.failed`.

### 3.1 Aprobación firmada y ligada a la llamada (SEC-002)

Aprobar no es una bandera: es un **token firmado** que ata el «sí» del usuario a
UNA ejecución concreta.

- El token (HMAC-SHA256, comparación en tiempo constante) lleva dentro: tool,
  usuario, sesión, tarea, **hash de los argumentos**, modo (`user` | `auto`),
  emisión y caducidad (2 minutos).
- El `ToolRegistry` lo **verifica antes de ejecutar** y es *fail-closed*: si la
  tool exige aprobación y no hay token válido, la llamada se rechaza con
  `ACCESO DENEGADO: …` **antes de tocar nada**.
- Consecuencia: aprobar `ls` NO autoriza `rm`. Entre la aprobación y la
  ejecución, cambiar los argumentos invalida el token.
- El secreto de firma se genera en memoria al arrancar el proceso: una
  aprobación vieja no sobrevive a un reinicio.
- La auto-aprobación (`JARVIS_TOOLS_AUTO_APPROVE`) **no es un bypass**: emite un
  token con `mode: "auto"`, igualmente firmado, ligado y auditado. Lo que
  cambia es el modo del token, no la existencia de la comprobación.

---

## 4. Manejo de secretos

- **`NVIDIA_API_KEY` y demás secretos viven solo en el backend** (entorno del server / values de compose). Nunca se hornean en el bundle web.
- El frontend solo recibe configuración pública vía `VITE_*` (p. ej. `VITE_API_URL`), que se considera pública.
- Prueba verificable: `grep` sobre `apps/web/dist` tras `pnpm build` **no** debe contener la clave NIM. Úsala como comprobación de regresión:

  ```bash
  # Debe no encontrar nada (no imprime la clave)
  grep -r "$NVIDIA_API_KEY" apps/web/dist 2>/dev/null && echo "FUGA" || echo "sin fugas"
  ```

- Los logs no deben volcar tokens ni cabeceras `Authorization`. El `detail` de auditoría guarda argumentos de tools y resúmenes, no secretos.
- `system.info` no expone variables de entorno (solo datos de OS/CPU/memoria/uptime).

---

## 5. Autenticación y autorización

- **Token de acceso opcional**: si `JARVIS_ACCESS_TOKEN` está definido, HTTP y WebSocket requieren presentarlo. Contrato previsto:
  - HTTP: cabecera `Authorization: Bearer <JARVIS_ACCESS_TOKEN>`.
  - WebSocket: el token se entrega al abrir la conexión (query/parámetro de handshake) y **nunca** se registra en logs.
  - Sin `JARVIS_ACCESS_TOKEN`, el server debe escuchar en `HOST` local y tratar cualquier conexión como usuario `local`.
- **Allow-list de usuarios**: `JARVIS_USERS` (por defecto `local`) limita los `userId` admitidos.
- El mecanismo concreto de handshake del WebSocket será la verdad de campo una vez exista `apps/server`; verifícalo allí antes de darlo por bueno.

---

## 6. CORS y allow-list de orígenes

- `ALLOWED_ORIGINS` es una lista separada por comas de orígenes de navegador permitidos (por defecto `http://localhost:5173,http://127.0.0.1:5173`).
- Lista vacía ⇒ solo `localhost`.
- No se debe usar comodín (`*`) junto a credenciales; el origen debe coincidir **exactamente**, incluido el puerto.
- Los orígenes desconocidos no deben poder abrir el WebSocket ni consumir la API.

---

## 7. Rate limiting

- Contrato del server: limitar por IP y por `sessionId` tanto los `chat.send` como la apertura de WebSockets, con backoff al superar umbrales.
- A nivel de proveedor, `withRetry` acota reintentos y aplica backoff exponencial; los errores `rate_limit` (429) son reintentables con espera.
- Límites del runtime: `maxIterations`, `maxToolCalls`, `maxDurationMs` evitan bucles que amplifiquen coste.
- **Pendiente**: no hay implementación de rate limiting verificable hasta que exista `apps/server`.

---

## 8. Auditoría

`jarvis_audit_log` registra, además de ejecuciones, las decisiones de seguridad:

| `action` | Cuándo |
| --- | --- |
| `tool.rejected` | Argumentos inválidos antes de cualquier efecto |
| `tool.approval_requested` | Se pide aprobación |
| `tool.approved` / `tool.denied` | Respuesta del usuario |
| `tool.completed` / `tool.failed` | Resultado de la ejecución |
| `task.completed` / `task.cancelled` / `task.failed` | Cierre del turno |

Cada entrada lleva `user_id`, `session_id`, `task_id`, `correlation_id` (id de tool call), `risk`, `tool_call_id` y `detail`. Esto permite reconstruir **quién** autorizó **qué** y **cuándo**.

---

## 9. Exportación, borrado y retención de datos

- **Exportación**: `MemoryService.exportUser(userId)` devuelve sesiones, mensajes, episodios, hechos semánticos, tareas y auditoría. `Store.exportUserData` es la base del endpoint `GET /api/export` (contrato en `docs/api.md`).
- **Borrado**: `MemoryService.deleteUser(userId)` elimina todas las filas del usuario (sesiones, mensajes, episodios, semántica, tareas, auditoría, aprobaciones, tool calls). Base de `DELETE /api/account`.
- **Borrado selectivo**: `memory.forget` (riesgo `destructive`, con aprobación) elimina un hecho semántico concreto.
- **Retención**: `MEMORY_RETENTION_DAYS` define la retención de memoria episódica (`0` = conservar siempre). La purga se ejecuta con `MemoryService.purgeExpired()`.
  - **Limitación actual**: `purgeExpired()` purga el usuario `"local"`; no hay job programado ni purga multi-usuario. Está documentado como limitación, no como capacidad completa.

---

## 10. Aislamiento de la ejecución de código

Las tools `code.execute_interpreter` y `code.compile_and_run` ejecutan código
arbitrario. El límite de seguridad NO es el prompt: es el runtime.

| Control | Implementación |
| --- | --- |
| Red | `docker run --network none`: sin egreso. El gate estático además rechaza el código con llamadas de red. |
| Sistema de archivos | `--read-only` + `--tmpfs /tmp` acotado por el límite de memoria. El workspace se monta en solo lectura. |
| Privilegios | `--user 65534:65534`, `--cap-drop ALL`, `--security-opt no-new-privileges`. |
| Recursos | `--memory`/`--memory-swap` (techo real 2 048 MB en el intérprete, 4 096 MB en el compilador), `--pids-limit 128`, `--cpus 1`. |
| Entorno | Allowlist mínima (`TZ`, `LC_ALL`, `PATH`, `HOME`, semillas). Ninguna credencial del host llega al sandbox. |
| Tiempo | Techo impuesto por el runtime (120 s intérprete, 300 s compilador); el valor del modelo es una solicitud y se marca `limits_clamped`. |
| Terminación | Al vencer el tiempo se mata el **contenedor** completo, no solo el proceso hijo. |
| Análisis previo | Gate estático en el servidor (`static-gate.ts`): denylist sobre el código y los archivos del proyecto. El auto-análisis del modelo es disuasorio; el gate es autoritativo. |
| Resultado | El retorno distingue fase (build/run), código de salida, `timed_out`, `oom_killed` y `truncated`. Sin esas banderas, el agente podría completar por inferencia una salida truncada. |

Verificación reproducible:

```bash
pnpm sandbox:build
pnpm --filter @jarvis/server exec tsx ../../scripts/audit-code-execution.ts
```

La auditoría comprueba, con contenedores reales: uid efectivo (65534), red
bloqueada, FS de solo lectura, `/tmp` escribible, OOM marcado, timeout marcado
y truncado marcado.

## 11. Checklist de verificación de seguridad

- [ ] `grep -r "$NVIDIA_API_KEY" apps/web/dist` sin resultados.
- [ ] Argumentos inválidos en una tool ⇒ `tool.rejected` en auditoría y **ningún** efecto.
- [ ] `task.delete`/`memory.forget` bloquean en `WAITING_FOR_APPROVAL`; denegar no ejecuta.
- [ ] Un usuario no ve datos de otro (`memory-service.test.ts`).
- [ ] `document.read` no sale de `DOCUMENTS_ROOT` (incluidos enlaces simbólicos).
- [ ] Sin `JARVIS_ACCESS_TOKEN`, el server no es alcanzable desde fuera de `HOST`.
