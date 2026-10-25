# JARVIS

Servicio personal de inteligencia: un asistente con **cerebro real en NVIDIA NIM**, runtime de agente observable, memoria persistente (PostgreSQL + pgvector), herramientas con niveles de riesgo, voz, percepción y un HUD 3D.

Este repositorio es un **monorepo pnpm** (`apps/*`, `packages/*`). Node >= 20.11, pnpm 12.

> Este README no promete nada que el código no demuestre. Cada capacidad se clasifica abajo como **implementada**, **verificada con tests**, **verificada contra el servicio real** o **pendiente**.

---

## Estado real (sin marketing)

### Implementado en este repo

| Componente | Qué hay | Tests |
| --- | --- | --- |
| `@jarvis/shared` | Tipos y contratos zod: `AgentState` + transiciones legales, protocolo de eventos/commands, niveles de riesgo, `HealthReport`/`aggregateStatus` | — (tipos) |
| `@jarvis/ai-provider` | Adaptador NVIDIA NIM: `chat`, `stream` (SSE), tool calling, `embed`, `health`, reintentos acotados con backoff, cancelación, `probeCapabilities` | `nim-provider.test.ts` (unit), `nim-provider.integration.test.ts` (integración) |
| `@jarvis/memory` | Contrato `Store`, `MemoryStore` (in-process), `PostgresStore` + migraciones SQL, `MemoryService` con aislamiento por usuario y memoria semántica vía embeddings | `memory-service.test.ts` |
| `@jarvis/tool-registry` | `ToolRegistry` (única vía de efectos), 19 herramientas builtin con riesgo/aprobación/timeouts, validación zod, **gate estático** de código, **sandbox de ejecución** (contenedor efímero: sin red, FS de solo lectura, usuario no privilegiado, límites de memoria/PIDs) y **control de interfaz real** (CoreGraphics en macOS) | `registry.test.ts`, `static-gate.test.ts`, `sandbox.test.ts`, `code-execution.test.ts`, `disconnected-tools.test.ts` |
| `@jarvis/agent-runtime` | Orquestador `runtime.ts`: bucle con límites, aprobaciones, streaming y análisis de imagen | En construcción (faltan `state-machine`, `prompt`, `approval-broker` en este checkout) |

### Verificado contra servicios reales (prueba manual con clave real)

- `nvidia/nemotron-3.5-lightning-30b-a3b`: **streaming + tool calling** funcionan.
- `nvidia/nemotron-3.5-super-vl-120b-a12b`: **visión + tools** funcionan.
- `nvidia/nemotron-3-embed-1b`: devuelve **embeddings de 2048 dimensiones** y es el **único modelo de embeddings operativo para esta cuenta**.
- `meta/llama-3.1-8b-instruct` devuelve **410 (end-of-life)** y `nvidia/llama-3.1-nemotron-ultra-253b-v1` devuelve **404** para esta cuenta. Por eso las capacidades **se verifican, no se asumen** (`pnpm --filter @jarvis/ai-provider probe`).

### Pendiente / no presente en este checkout

- `apps/server` (Fastify, HTTP + WebSocket, puerto 8787): **en construcción**. El contrato HTTP está en [`docs/api.md`](docs/api.md).
- `apps/web` (React + Vite + react-three-fiber, puerto 5173): **en construcción**. Solo están los assets en `apps/web/public/assets/jarvis/`.
- `@jarvis/voice` y `@jarvis/perception`: **contratados pero no presentes aún**.
- Exportador de métricas (Prometheus/OTel): **no implementado**. `docs/operations.md` documenta los puntos de instrumentación disponibles.

### Verificado por tests automatizados

- Unit: `pnpm test:unit` (sin credenciales).
- Integración NVIDIA: `pnpm test:integration` (se **omite automáticamente** si no hay `NVIDIA_API_KEY`).
- Los tests unitarios cubren aislamiento de usuarios, validación de argumentos antes de efectos, tools no configuradas como `unavailable` (sin inventar resultados) y timeouts.

---

## Arquitectura

```
                        ┌──────────────────────────────────────────┐
                        │              NAVEGADOR (HUD)             │
                        │  React + Vite + react-three-fiber        │
                        │  chat · voz (Web Speech) · cámara        │
                        │  http://localhost:5173                   │
                        └───────────────┬──────────────────────────┘
                                        │  HTTP  +  WebSocket (/ws)
                                        │  eventos: session.*, assistant.*, tool.*, voice.*, perception.*
                                        ▼
                        ┌──────────────────────────────────────────┐
                        │            @jarvis/server (8787)         │
                        │            Fastify · HTTP + WS           │
                        └───────┬───────────────┬──────────────────┘
                                │               │
                ┌───────────────▼──┐     ┌──────▼───────────────────┐
                │ @jarvis/agent-   │     │  @jarvis/ai-provider     │
                │ runtime          │────▶│  NVIDIA NIM (OpenAI API) │
                │ state machine    │     │  chat/stream/tools/      │
                │ bucle + límites  │     │  vision/embeddings       │
                │ aprobaciones     │     └──────────────────────────┘
                └───┬──────────┬───┘
                    │          │
        ┌───────────▼──┐   ┌───▼─────────────────────────┐
        │ @jarvis/tool-│   │  @jarvis/memory             │
        │ registry     │   │  MemoryService (aislamiento)│
        │ única vía de │   │  MemoryStore | PostgresStore│
        │ efectos      │   └───────────┬─────────────────┘
        └──────────────┘               │
                                       ▼
                        ┌──────────────────────────────────────────┐
                        │  PostgreSQL + pgvector (imagen          │
                        │  pgvector/pgvector:pg16)                 │
                        │  host 55432 → 5432, db `jarvis`          │
                        └──────────────────────────────────────────┘
```

Detalle completo de subsistemas, máquina de estados, esquema y degradación en [`docs/architecture.md`](docs/architecture.md).

---

## Quickstart

Requisitos: Node >= 20.11, pnpm 12, Docker.

```bash
cp .env.example .env
# Edita .env y asigna una clave real:
#   NVIDIA_API_KEY=nvapi-...

docker compose up -d db          # arranca PostgreSQL + pgvector en localhost:55432
pnpm install
pnpm db:migrate                  # aplica 001_init.sql y 002_semantic.sql
pnpm dev                         # server (8787) + web (5173)

open http://localhost:5173
```

Comprueba que el cerebro responde de verdad antes de culpar a la UI:

```bash
pnpm --filter @jarvis/ai-provider probe
```

La salida debe indicar `health: UP` y `capabilities.streaming`/`capabilities.tools` en `true`. Si no, revisa la clave y las notas de modelo en [`docs/setup.md`](docs/setup.md).

### Sin PostgreSQL (no durable)

```bash
PERSISTENCE=memory pnpm dev
```

`MemoryStore` implementa el contrato completo, pero **no sobrevive a reinicios**; sirve para desarrollo y tests, no para memoria persistente.

---

## Criterios de aceptación

El objetivo del sistema se cumple cuando se verifican **todos** estos puntos (hoy son el criterio de "terminado", no una afirmación de estado):

1. **Arrancar el servicio**: `docker compose up -d db && pnpm dev` levanta server y web sin errores y el HUD muestra el estado de salud real.
2. **Hablar con JARVIS**: un mensaje en el chat produce una respuesta del modelo (o un error visible, nunca una respuesta inventada).
3. **Pedir una tarea que requiere herramienta**: p. ej. «¿qué hora es?» o «54 entre 6» provoca una llamada real a una tool.
4. **Comprobar que se ejecutó de verdad**: el evento `tool.completed` y la fila correspondiente en `jarvis_tool_calls` / `jarvis_audit_log` confirman la ejecución (no una simulación).
5. **Reiniciar y confirmar persistencia**: tras reiniciar, solo permanecen las memorias autorizadas explícitamente (`jarvis_semantic_memories`) y las sesiones/tareas guardadas; el resto del estado efímero no se inventa.

La suite E2E (Playwright) en [`e2e/`](e2e/README.md) automatiza los puntos 1–4 sobre la UI.

---

## Scripts

| Script | Qué hace |
| --- | --- |
| `pnpm dev` | Levanta `@jarvis/server` (8787) y `@jarvis/web` (5173) en paralelo |
| `pnpm build` | Compila primero `packages/**` y luego `apps/**` |
| `pnpm typecheck` | `tsc --noEmit` en todo el workspace |
| `pnpm test` | Ejecuta Vitest (unit + integration) |
| `pnpm test:unit` | Solo unit (no requiere credenciales) |
| `pnpm test:integration` | Solo integración (se omite sin `NVIDIA_API_KEY`) |
| `pnpm db:migrate` | Aplica las migraciones SQL vía `@jarvis/server` |
| `pnpm infra:up` | `docker compose up -d` |
| `pnpm infra:down` | `docker compose down` |
| `pnpm verify` | `typecheck` + `test:unit` |
| `pnpm --filter @jarvis/ai-provider probe` | Sonda real de capacidades contra NVIDIA NIM |
| `pnpm sandbox:build` | Construye la imagen de sandbox (C++, Rust, Go) que usan las tools de compilación |
| `pnpm --filter @jarvis/server exec tsx ../../scripts/audit-code-execution.ts` | Auditoría empírica del aislamiento: red, FS, memoria, timeout, truncado y gate |
| `pnpm --filter @jarvis/server exec tsx ../../scripts/audit-disconnected-tools.ts` | Auditoría de `file.io`, `shell.execute` y `computer.use`: lectura/escritura reales, confinamiento y ausencia de fuga de credenciales |
| `pnpm --filter @jarvis/server exec tsx ../../scripts/verify-code-agent-e2e.ts` | Turno real con NIM en el que el modelo decide usar la tool de código |
| `node scripts/verify-failover.mjs <puerto> <etiqueta>` | Comprueba la conmutación a proveedor de respaldo |
| `node scripts/verify-failover-recovery.mjs` | Ciclo completo: conmutación por fallo y recuperación automática del primario |

---

## Variables de entorno

Todas están documentadas en `.env.example`. Resumen por grupo:

- **NVIDIA NIM**: `NVIDIA_API_KEY`, `NVIDIA_BASE_URL`, `NVIDIA_MODEL`, `NVIDIA_VISION_MODEL`, `NVIDIA_EMBEDDING_MODEL` (dim. 2048), `NVIDIA_TIMEOUT_MS`, `NVIDIA_MAX_TOKENS`, `NVIDIA_TEMPERATURE`, `NVIDIA_STREAMING`.
- **OpenRouter (respaldo)**: `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_REASONING_EFFORT`, `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_MAX_TOKENS`, `OPENROUTER_MAX_RETRIES`.
- **Server**: `HOST`, `PORT`, `ALLOWED_ORIGINS`, `JARVIS_ACCESS_TOKEN`, `JARVIS_USERS`, `LOG_LEVEL`.
- **Persistencia**: `DATABASE_URL=postgres://jarvis:jarvis@localhost:55432/jarvis`, `PERSISTENCE=postgres|memory`, `MEMORY_RETENTION_DAYS`.
- **Tools**: `DOCUMENTS_ROOT`, `WEB_SEARCH_PROVIDER=brave|tavily`, `WEB_SEARCH_API_KEY`.
- **Voz**: `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER` (por defecto `browser`). Con `VOICE_TTS_NAME` (voz del sintetizador local), `VOICE_TTS_CACHE_DIR` (caché de frases) y `VOICE_FAST_TURNS` (turnos de voz sin razonamiento del modelo).
- **Sandbox de código**: `JARVIS_SANDBOX_IMAGE_PYTHON`, `..._NODEJS`, `..._CPP`, `..._RUST`, `..._GO` (imágenes; si faltan, la tool se reporta como no disponible).
- **Workspace y shell**: `JARVIS_WORKSPACE_ROOT` (raíz de `file.io` y `shell.execute`), `JARVIS_SHELL_ALLOWLIST` (binarios permitidos).
- **Control de interfaz**: `JARVIS_COMPUTER_USE_DRIVER` (driver CoreGraphics; solo macOS).
- **Frontend**: `VITE_API_URL=http://localhost:8787`.

Detalle, valores por defecto y procedencia en [`docs/setup.md`](docs/setup.md).

---

## Troubleshooting

- **El puerto 5432 está ocupado**: es intencional; la base se publica en `55432` (`55432:5432`). Usa `postgres://jarvis:jarvis@localhost:55432/jarvis`.
- **`NVIDIA_API_KEY is not set`**: copia `.env.example` a `.env` y asigna la clave. La sonda y el server la leen del entorno.
- **Un modelo devuelve 404/410**: no está disponible para esta cuenta. Ejecuta la sonda y cambia `NVIDIA_MODEL`/`NVIDIA_VISION_MODEL` por uno verificado.
- **`CREATE EXTENSION vector` falla**: estás usando una imagen Postgres sin pgvector. Usa `pgvector/pgvector:pg16`.
- **`PERSISTENCE=memory` y "se me olvidó todo"**: es el comportamiento esperado; activa `PERSISTENCE=postgres` y arranca la `db`.
- **CORS bloquea el HUD**: añade el origen exacto a `ALLOWED_ORIGINS` (incluyendo puerto).
- **`document.read` dice "no disponible"**: `DOCUMENTS_ROOT` está vacío. Define rutas absolutas separadas por `:` y autoriza solo lo necesario.
- **`web.search` dice "no disponible"**: falta `WEB_SEARCH_PROVIDER` + `WEB_SEARCH_API_KEY`. La tool se anuncia como no disponible en lugar de fingir resultados.
- **`computer.use` dice "no disponible"**: el control de interfaz solo existe en macOS y necesita el driver en `infra/computer-use/driver.py` (configurable con `JARVIS_COMPUTER_USE_DRIVER`). Va encendido por defecto (`JARVIS_ENABLE_COMPUTER_USE=true`): cada acción pide aprobación antes de ejecutarse, y si la rechazas no ocurre nada.
- **El cerebro no responde y el log dice "conmutación de proveedor"**: el primario (NVIDIA NIM) falló y el turno lo sirvió el respaldo (OpenRouter). El HUD lo muestra en el componente `brain`; el contador `provider.failovers` lo cuantifica. El primario se re-promueve solo en cuanto responde.
- **`code.execute_interpreter` dice "no disponible"**: falta la imagen del sandbox. `docker images` debe listar `python:3.12-slim` y `node:22-slim`; para compilar, ejecuta `pnpm sandbox:build`.
- **El micrófono dice "bloqueado por el origen"**: estás en una IP de red local por HTTP. Chrome solo concede el micrófono en orígenes confiables: usa `http://localhost:5173` (el HUD ofrece el enlace) o sirve la app por HTTPS con `pnpm dev:https`. Detalle en [`docs/setup.md`](docs/setup.md#10-micrófono-requisito-de-origen-confiable).

---

## No simula capacidades

JARVIS **no simula capacidades**. Una herramienta sin configurar se reporta como `unavailable` con un `reason`, un modelo no disponible se reporta como error (`404`/`410` → `unavailable`), y el estado `unknown` es un estado de primera clase que **nunca se disfraza de `up`**. No hay respuestas "mock" en producción: los tests usan `FakeProvider` explícitamente y la sonda de capacidades exige verificación contra la cuenta real antes de declarar streaming o tool calling.

---

## Documentación

- [`docs/architecture.md`](docs/architecture.md) — subsistemas, máquina de estados, esquema, pipeline de tools.
- [`docs/security.md`](docs/security.md) — modelo de amenazas, inyección de prompts, secretos, auditoría.
- [`docs/setup.md`](docs/setup.md) — instalación paso a paso, modo memoria, sonda y tests.
- [`docs/api.md`](docs/api.md) — endpoints HTTP y protocolo WebSocket completo.
- [`docs/operations.md`](docs/operations.md) — salud, logs, métricas, retención, backup y cambio de modelo.
- [`infra/migrations/README.md`](infra/migrations/README.md) — migraciones SQL.
- [`infra/monitoring/healthcheck.md`](infra/monitoring/healthcheck.md) — qué comprueba cada health check.
- [`e2e/README.md`](e2e/README.md) — pruebas E2E con Playwright.
