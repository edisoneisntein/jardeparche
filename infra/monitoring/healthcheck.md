# Health checks

Qué sondea **realmente** cada componente, cómo se agregan los estados y cómo se debe mostrar `degraded`/`unknown`. Regla de oro: **`unknown` nunca se disfraza de `up`**.

---

## 1. Agregación

`aggregateStatus(components)` (en `packages/shared/src/health.ts`):

1. Sin componentes ⇒ `unknown`.
2. Algún `down` ⇒ `down`.
3. Si no, algún `degraded` ⇒ `degraded`.
4. Si no, algún `unknown` ⇒ `unknown`.
5. Si todo `up` ⇒ `up`.

`HealthReport` = `{ status, components[], checkedAt }`. Cada `ComponentHealth` = `{ component, status, detail?, checkedAt, latencyMs? }`.

---

## 2. Qué sondea cada componente

| Componente | Sonda real | `up` | `degraded` | `down` | `unknown` |
| --- | --- | --- | --- | --- | --- |
| `brain` (NVIDIA NIM) | `GET {NVIDIA_BASE_URL}/models` con `Authorization: Bearer` (`NvidiaNimProvider.health()`) + `capabilities()` | `200` y modelo configurado | respuesta lenta o fallo intermitente | `401`/`403` (auth), `404`/`410`/`5xx` | sonda no ejecutada aún, timeout sin resultado |
| `database` | `SELECT 1` (`PostgresStore.health()` / `MemoryStore.health()`) | consulta OK | latencia alta / reconexión | conexión rechazada, query falla | store no inicializado |
| `tools` | `ToolRegistry.available()`: ¿hay tools configuradas? | ≥1 tool disponible | todas `unavailable` por falta de config | — | registro no inicializado |
| `voice` | Estado declarado de los proveedores STT/TTS (`VoiceService.status()`) | — | — | — | siempre `unknown`: el navegador no es verificable desde el servidor |
| `perception` | `PerceptionService.health()`: el proveedor de visión responde y el modelo está configurado | proveedor accesible | proveedor accesible sin visión operativa | sonda fallida | análisis deshabilitado |
| `runtime` | `AgentRuntime.health()`: fallos consecutivos del último turno | sin fallos | último turno fallido | ≥3 turnos fallidos seguidos | — |

Los componentes que se emitían como constantes se sustituyeron por sondas
reales: `perception` consultaba al proveedor de visión y `runtime` refleja los
últimos turnos ejecutados.

### 2.1 Salud en vivo

`HealthRegistry.checkAndEmit()` compara cada informe con el anterior y emite
`system.health_changed` **solo** para los componentes cuyo estado cambió. El
servidor lo ejecuta cada `JARVIS_HEALTH_WATCH_MS` (20 s por defecto) y difunde
el evento a las conexiones abiertas. El cliente lo aplica en vivo; el sondeo
`GET /api/health` sigue siendo la fuente de arranque.

Notas importantes:

- `provider.health()` solo comprueba **alcanzabilidad y autenticación**, **no** que el modelo elegido exista o soporte streaming/tools. Para eso está `probeCapabilities()` / `pnpm --filter @jarvis/ai-provider probe` (que sí hace una llamada real con streaming y tool calling).
- Un modelo `404`/`410` aparece como `unavailable` en el provider, no como `down` de la red. El detalle debe indicar el `ProviderErrorKind`.
- `memory.health()` devuelve `{ ok, detail }`; `ok: false` ⇒ `down` con `detail`.

---

## 3. Cómo debe mostrarse el estado

- **`up`**: verde, con `latencyMs` si existe.
- **`degraded`**: ámbar, **siempre con `detail`** (p. ej. "connection slow", "web.search no configurada"). Nunca como verde.
- **`down`**: rojo, con `detail` (causa: auth, conexión, etc.).
- **`unknown`**: gris/neutro con texto explícito tipo «sin datos» / «no comprobado». **Prohibido** representarlo como operativo.

Reglas de producto:

1. El HUD de arranque debe mostrar el estado **real** de cada componente; no un "todo operativo" hardcodeado.
2. Si el provider no se ha sondeado, se muestra `unknown`, no `up`.
3. Los cambios se emiten como `system.health_changed { component, status, detail? }` para que el HUD actualice sin recargar.

---

## 4. Health check de Docker (compose)

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U jarvis -d jarvis"]
  interval: 5s
  timeout: 5s
  retries: 10
  start_period: 10s
```

- El contenedor `db` se considera `healthy` cuando `pg_isready` responde.
- Los servicios `server`/`web` (perfil `app`) dependen de `db` con `condition: service_healthy`.
- **No hay healthcheck de contenedor para `server`** en el compose actual; la salud del server se expone por `GET /health`. Añadir un healthcheck HTTP requiere que `apps/server` implemente ese endpoint (contrato en `docs/api.md`).

---

## 5. Diagnóstico rápido

```bash
# ¿Está la base sana?
docker compose ps
docker exec -it jarvis-db pg_isready -U jarvis -d jarvis

# ¿Responde el cerebro?
pnpm --filter @jarvis/ai-provider probe

# ¿Health agregado (si el server está levantado)?
curl -s http://localhost:8787/health | jq .
```

Si un componente queda `degraded` o `unknown`, la app debe decirlo con su `detail`; nunca ocultarlo ni presentarlo como `up`.
