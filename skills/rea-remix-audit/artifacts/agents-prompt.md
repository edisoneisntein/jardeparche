# PLAN MAESTRO DE EJECUCIÓN: REMEDIACIÓN TÉCNICA JARVIS

El presente documento establece el marco formal de orquestación, gobernanza, ejecución modular y handoff criptográfico/estructurado para mitigar los hallazgos identificados en la auditoría técnica del repositorio JARVIS.

---

## 1. INSTRUCCIONES DEL AGENTE COORDINADOR

### 1.1 Rol y Mandato Operativo
* **Identidad:** Lead Enterprise Orchestrator (`ORCHESTRATOR-AGENT-01`).
* **Misión:** Supervisar, despachar, auditar y consolidar de forma secuencial y atómica la ejecución de tareas de ingeniería sobre el monorepo JARVIS, garantizando *Zero Regressions*, tipado estricto (`no-implicit-any`, `strict: true`) y cumplimiento estricto de las especificaciones ISO/IEC 25010 y NIST SP 800-207.
* **Alcance Técnico:** Gobernanza absoluta sobre los paquetes `packages/agent-runtime`, `packages/ai-provider`, `packages/memory`, `packages/tool-registry`, `packages/shared` y la aplicación `apps/web` y `apps/server`.

### 1.2 Reglas de Decisión Inflexibles
1. **Inmutabilidad de Topología:** Queda terminantemente prohibido crear rutas de directorios, módulos o scripts fuera de las dependencias e interfaces descritas en el informe de auditoría.
2. **Priorización por Severidad (Topological Sort):**
   * Fase P0: `SEC-002` (Aislamiento y tokens en Tool Registry) $\rightarrow$ `SEC-001` (Saneamiento y validación de variables de entorno).
   * Fase P1: `ARCH-001` (Inversión de dependencias de IA / Resilient Router) $\rightarrow$ `PERF-001` (Sustitución de polling por SSE/Streams).
   * Fase P2: `ARCH-002` (Eliminación de scripts ad-hoc y DDL declarativo) $\rightarrow$ `PERF-002` (Capa de caché semántica y hash de embeddings).
3. **Bloqueo Transaccional (Fail-Stop Policy):** Si un subagente devuelve un estado `FAILED` o un incumplimiento en los criterios de aceptación verificables, se detiene inmediatamente el pipeline, se revierte el workspace con Git (`git checkout -- . && git clean -fd`) y no se delega la siguiente tarea.
4. **Barrera de Tipos y Pruebas:** Ningún commit ni handoff será aceptado si `pnpm turbo run build` o `pnpm typecheck` arrojan advertencias o errores.

### 1.3 Matriz de Delegación
* **Delegar a `SUBAGENT-SEC-002` si:** Existen mutaciones de estado no firmadas o falta de sandboxing de parámetros en `packages/agent-runtime` y `packages/tool-registry`.
* **Delegar a `SUBAGENT-SEC-001` si:** Se detecta lectura de `process.env` desprotegida o riesgo de fuga de `NVIDIA_API_KEY` en `packages/ai-provider` y `apps/web`.
* **Delegar a `SUBAGENT-ARCH-001` si:** `packages/agent-runtime/src/runtime.ts` consume directamente `nim-provider.ts` sin pasar por la interfaz desacoplada.
* **Delegar a `SUBAGENT-PERF-001` si:** El cliente web `apps/web` ejecuta bucles de intervalos (`setInterval`) para sincronización de salud contra el backend.
* **Delegar a `SUBAGENT-ARCH-002` si:** El pipeline de compilación o inicio depende de `packages/memory/scripts/copy-sql.mjs`.
* **Delegar a `SUBAGENT-PERF-002` si:** `packages/memory` no implementa deduplicación ni validación de embeddings previa para las llamadas a inferencia.

---

## 2. SUBAGENTES DE REMEDIACIÓN TÉCNICA

```
                     ┌───────────────────────────────┐
                     │   ORCHESTRATOR-AGENT-01       │
                     └──────────────┬────────────────┘
                                    │
         ┌──────────────┬───────────┴──────────┬──────────────┐
         ▼              ▼                      ▼              ▼
   [P0: SEGURIDAD] [P0: SEGURIDAD]       [P1: ARQUITECTURA][P1: RENDIMIENTO]
    SEC-002        SEC-001                ARCH-001         PERF-001
         │              │                      │              │
         └──────────────┴───────────┬──────────┴──────────────┘
                                    │
                      ┌─────────────┴─────────────┐
                      ▼                           ▼
               [P2: ARQUITECTURA]          [P2: RENDIMIENTO]
                ARCH-002                    PERF-002
```

---

### SUBAGENTE: `SUBAGENT-SEC-002`
* **Prioridad:** P0 (Crítico)
* **Objetivo:** Implementar sandboxing estricto, validación de esquemas Zod en tool calling y verificación criptográfica asimétrica de tokens de aprobación emitidos por el usuario antes de la ejecución de herramientas del agente.
* **Archivos Permitidos Exclusivamente:**
  * `packages/agent-runtime/src/approval-broker.ts`
  * `packages/tool-registry/src/registry.ts`
* **Pasos de Ejecución:**
  1. Refactorizar `packages/agent-runtime/src/approval-broker.ts` implementando la interfaz `ExecutionRequest` y la verificación criptográfica del payload `userApprovalToken` para herramientas mutativas.
  2. Implementar un validador de esquemas con parsing defensivo en `packages/tool-registry/src/registry.ts` previo al despacho del método de ejecución.
  3. Denegar por defecto (*fail-closed*) cualquier ejecución si la herramienta no está registrada o si el token presenta inconsistencia temporal o de firma.
* **Criterios de Aceptación Verificables:**
  * 0 usos de tipo `any` en `approval-broker.ts` y `registry.ts`.
  * Toda llamada a herramientas con mutación sin token válido debe rechazar la promesa con `Error: ACCESO DENEGADO`.
  * Validación de tipos en tiempo de compilación pasando al 100%.
* **Comandos de Verificación:**
  ```bash
  pnpm --filter @jarvis/agent-runtime test
  pnpm --filter @jarvis/tool-registry test
  pnpm typecheck
  ```

---

### SUBAGENTE: `SUBAGENT-SEC-001`
* **Prioridad:** P0 (Alto)
* **Objetivo:** Centralizar, aislar y validar con tipado estricto en runtime las variables de entorno (`NVIDIA_API_KEY`, etc.) mediante esquemas inmutables, neutralizando fugas hacia el frontend y scripts de diagnóstico.
* **Archivos Permitidos Exclusivamente:**
  * `packages/ai-provider/src/config.ts`
  * `packages/ai-provider/scripts/probe.ts`
  * `apps/web/vite.config.ts`
* **Pasos de Ejecución:**
  1. Instalar/Configurar validación declarativa con `zod` dentro de `packages/ai-provider/src/config.ts`, exportando un tipo sellado e inmutable `EnvConfig`.
  2. Modificar `packages/ai-provider/scripts/probe.ts` para que consuma la configuración validada a través de `loadConfig()` y nunca acceda de forma directa a `process.env`.
  3. Configurar `apps/web/vite.config.ts` para restringir el prefijo expuesto al cliente estrictamente a `VITE_` y bloquear expresamente el paso de secretos del servidor.
* **Criterios de Aceptación Verificables:**
  * Si `NVIDIA_API_KEY` está ausente o vacía en el entorno de ejecución, el proceso debe abortar con un código de salida `1` y un mensaje descriptivo controlado sin volcar volcados de memoria de secretos.
  * Análisis estático libre de apariciones de `process.env.NVIDIA_API_KEY` fuera de `config.ts`.
* **Comandos de Verificación:**
  ```bash
  pnpm --filter @jarvis/ai-provider test
  grep -rn "process.env.NVIDIA_API_KEY" packages/ai-provider/src/ | grep -v "config.ts" || true
  ```

---

### SUBAGENTE: `SUBAGENT-ARCH-001`
* **Prioridad:** P1 (Alto)
* **Objetivo:** Desacoplar el proveedor de IA aplicando el Principio de Inversión de Dependencias (DIP) mediante la implementación de una interfaz estandarizada `AIProvider` y un enrutador con tolerancia a fallos (`ResilientAIRouter`).
* **Archivos Permitidos Exclusivamente:**
  * `packages/ai-provider/src/types.ts`
  * `packages/ai-provider/src/resilient-router.ts`
  * `packages/ai-provider/src/nim-provider.ts`
  * `packages/ai-provider/src/config.ts`
  * `packages/agent-runtime/src/runtime.ts`
* **Pasos de Ejecución:**
  1. Definir los contratos unificados `AIProvider` y `CompletionOptions` en `packages/ai-provider/src/types.ts`.
  2. Implementar `ResilientAIRouter` en `packages/ai-provider/src/resilient-router.ts` encapsulando la lógica primaria (NIM) y secundaria (fallback/stubs locales) con invocación defensiva del `healthCheck`.
  3. Modificar `packages/ai-provider/src/nim-provider.ts` para que implemente formalmente la interfaz `AIProvider`.
  4. Refactorizar el constructor de `packages/agent-runtime/src/runtime.ts` para que acepte la abstracción `AIProvider` en lugar de una clase concreta.
* **Criterios de Aceptación Verificables:**
  * Desacoplamiento total: Si el método `healthCheck()` del proveedor primario falla, `ResilientAIRouter` redirige de manera asíncrona la finalización al fallback sin lanzar excepción al runtime.
  * Compatibilidad estricta con TypeScript 5.x sin advertencias de interfaz.
* **Comandos de Verificación:**
  ```bash
  pnpm --filter @jarvis/ai-provider build
  pnpm --filter @jarvis/agent-runtime build
  pnpm typecheck
  ```

---

### SUBAGENTE: `SUBAGENT-PERF-001`
* **Prioridad:** P1 (Medio)
* **Objetivo:** Eliminar la degradación del hilo principal del cliente y reducir la saturación de I/O de red sustituyendo el sondeo periódico de HTTP por Server-Sent Events (SSE) y pausando animaciones WebGL/Canvas en segundo plano.
* **Archivos Permitidos Exclusivamente:**
  * `apps/web/src/hooks/useHealthPolling.ts`
  * `apps/web/src/components/reactor/ReactorScene.tsx`
  * `apps/web/src/components/fx/ParticleVeil.tsx`
* **Pasos de Ejecución:**
  1. Refactorizar `apps/web/src/hooks/useHealthPolling.ts` renombrando lógicamente a consumo reactivo de SSE contra `/api/health/stream` implementando reconexión exponencial y limpieza de `EventSource` en desmontaje.
  2. Modificar los bucles de renderizado (requestAnimationFrame) en `ReactorScene.tsx` y `ParticleVeil.tsx` para subscribirse a la API del DOM `document.visibilityState`, suspendiendo la ejecución gráfica cuando la pestaña se encuentre oculta.
* **Criterios de Aceptación Verificables:**
  * 0 llamadas de sondeo mediante `setInterval` en la inspección estática del código del cliente web.
  * Consumo nulo de ciclos de GPU/CPU en canvas cuando la pestaña pasa al estado de invisibilidad (`document.hidden === true`).
* **Comandos de Verificación:**
  ```bash
  pnpm --filter @jarvis/web build
  pnpm --filter @jarvis/web test
  ```

---

### SUBAGENTE: `SUBAGENT-ARCH-002`
* **Prioridad:** P2 (Medio)
* **Objetivo:** Establecer un pipeline determinista y atómico de persistencia relacional, eliminando scripts manuales y no reproducibles de manipulación de ficheros SQL.
* **Archivos Permitidos Exclusivamente:**
  * `packages/memory/scripts/copy-sql.mjs` (Eliminación)
  * `apps/server/scripts/db-migrate.ts`
  * `packages/memory/src/postgres-store.ts`
* **Pasos de Ejecución:**
  1. Purgar el script residual `packages/memory/scripts/copy-sql.mjs` de la raíz del monorepo y desasociarlo de los comandos del `package.json`.
  2. Implementar la ejecución de esquemas y migraciones con transacción atómica directa (`BEGIN...COMMIT`) dentro de `packages/memory/src/postgres-store.ts`.
  3. Modificar `apps/server/scripts/db-migrate.ts` para que invoque el gestor unificado de migraciones sin depender de la existencia física de ficheros duplicados en el build output.
* **Criterios de Aceptación Verificables:**
  * Eliminación confirmada de `packages/memory/scripts/copy-sql.mjs`.
  * Ejecución idempotente y transaccional del pipeline de migración; ante un fallo de sintaxis DDL, se ejecuta `ROLLBACK` sin dejar el esquema en estado inconsistente.
* **Comandos de Verificación:**
  ```bash
  test ! -f packages/memory/scripts/copy-sql.mjs
  pnpm --filter @jarvis/memory build
  pnpm --filter @jarvis/server test
  ```

---

### SUBAGENTE: `SUBAGENT-PERF-002`
* **Prioridad:** P2 (Medio)
* **Objetivo:** Mitigar los costes financieros y computacionales de inferencia implementando un mecanismo de caché semántica determinista basado en hashing y similitud de embeddings antes del despacho al LLM.
* **Archivos Permitidos Exclusivamente:**
  * `packages/agent-runtime/src/runtime.ts`
  * `packages/memory/src/memory-service.ts`
  * `packages/memory/src/postgres-store.ts`
* **Pasos de Ejecución:**
  1. Diseñar el método `findSemanticMatch(prompt: string, threshold: number)` en `packages/memory/src/memory-service.ts` interactuando con la persistencia relacional/vectorial de `postgres-store.ts`.
  2. Modificar el flujo de inferencia en `packages/agent-runtime/src/runtime.ts` para consultar el caché semántico con un umbral de similitud estricto $\ge 0.98$. Si existe coincidencia (*cache hit*), retornar la respuesta inmediatamente sin consultar a `AIProvider`.
  3. Almacenar asíncronamente las respuestas recién generadas por el proveedor en el almacén de memoria semántica.
* **Criterios de Aceptación Verificables:**
  * Dos solicitudes de inferencia consecutivas con prompts funcional o literalmente idénticos deben resultar en exactamente una sola llamada al proveedor de IA subyacente.
  * La resolución por coincidencia de caché debe ocurrir con una latencia significativamente inferior a la inferencia del backend.
* **Comandos de Verificación:**
  ```bash
  pnpm --filter @jarvis/memory test
  pnpm --filter @jarvis/agent-runtime test
  ```

---

## 3. CONTRATO DE HANDOFF ENTRE COORDINADOR Y SUBAGENTES

Todo subagente debe retornar obligatoriamente su informe de cierre en el formato canónico estructurado que se define a continuación. Si el informe no supera este esquema, el Agente Coordinador rechazará el resultado y revertirá los cambios de forma automática.

```markdown
### AGENT HANDOFF REPORT
- **Subagent ID:** [SUBAGENT-SEC-001 | SUBAGENT-SEC-002 | SUBAGENT-ARCH-001 | SUBAGENT-ARCH-002 | SUBAGENT-PERF-001 | SUBAGENT-PERF-002]
- **Target Finding ID:** [SEC-001 | SEC-002 | ARCH-001 | ARCH-002 | PERF-001 | PERF-002]
- **Execution Status:** [SUCCESS | FAILED]
- **Timestamp:** YYYY-MM-DDTHH:mm:ssZ

#### 1. Archivos Modificados / Eliminados
- `[ruta/del/archivo]` (MODIFIED | DELETED | CREATED)

#### 2. Matriz de Cumplimiento de Criterios
- [x] Criterio de Aceptación 1: [Descripción y Evidencia]
- [x] Criterio de Aceptación 2: [Descripción y Evidencia]

#### 3. Trazabilidad de Verificación de Integridad
- **Comando Ejecutado:** `[comando de verificación]`
- **Código de Retorno (Exit Code):** 0
- **Salida de Consola (Truncada a puntos críticos):**
  ```text
  [Output verificado de compilación o test suite]
  ```

#### 4. Análisis de Regresiones y Seguridad
- **Tipado Estricto Verificado:** [SI | NO]
- **Nuevas Dependencias Introducidas:** [Ninguna | Nombre y Versión Precisa]
- **Riesgo Residual Identificado:** [Ninguno | Descripción del trade-off técnico]
```

---

### Explicación

#### Decisiones de Arquitectura y Patrones Aplicados
1. **Patrón Orquestador-Especialista con Fronteras Aisladas (Bounded Contexts):** Para mitigar el riesgo de inconsistencias en una base de código compleja, se establece una clara separación de responsabilidades entre el agente coordinador (que mantiene el estado global, el orden topológico y el control de transacciones) y los subagentes especializados, quienes operan con un alcance limitado a su contexto.
2. **Principio de Mínimo Privilegio sobre el Sistema de Archivos:** Cada subagente tiene una lista blanca estricta y cerrada de rutas sobre las cuales puede operar. Esto previene colisiones de edición y asegura que ningún agente modifique archivos fuera de su dominio auditado.
3. **Fail-Closed y Sandboxing en IA Runtime (SEC-002):** Se aplica el principio Zero-Trust para la ejecución de herramientas del LLM. Las acciones con efectos secundarios (mutaciones en el sistema de tareas o documentos) exigen comprobación asimétrica obligatoria de la firma del usuario mediante tokens criptográficos, imposibilitando la explotación por inyección indirecta de prompts (Prompt Injection / Tool Poisoning).
4. **Patrón Strategy y Circuit Breaker (ARCH-001):** El desacoplamiento del SDK de NVIDIA NIM mediante una interfaz neutral (`AIProvider`) y la introducción del `ResilientAIRouter` permiten conmutación automática ante indisponibilidad del servicio externo, protegiendo al sistema contra caídas del proveedor.

#### Funcionamiento Lógico Detallado
* **Pipeline Secuencial:** El coordinador ejecuta los subagentes respetando las dependencias estructurales. La seguridad de la ejecución (P0) precede a las mejoras de arquitectura (P1) y las optimizaciones de costo/rendimiento (P2).
* **Validación en Dos Fases:** Cada subagente ejecuta su lógica localmente y autoverifica el compilador de TypeScript y las pruebas unitarias. Si el resultado es exitoso, emite el `AGENT HANDOFF REPORT`. El coordinador valida el reporte; si todos los criterios son marcados con éxito y el código de retorno es `0`, confirma los cambios en el control de versiones y autoriza el inicio del siguiente subagente.

#### Instrucciones de Integración de Bajo Nivel
1. **Inicialización:** Cargar estas directivas en el motor de orquestación de LLM (ej. AutoGen, CrewAI o scripts de automatización con Claude Code/Cursor).
2. **Inicialización de Variables:** Exportar en el shell las variables validadas por el esquema:
   ```bash
   export NVIDIA_API_KEY="nvapi-test-signature"
   export NODE_ENV="development"
   ```
3. **Flujo de Ejecución:** Iniciar al Agente Coordinador pasando el informe `audit.md`. El orquestador consumirá el archivo, evaluará los criterios de handoff para cada uno de los 6 subagentes y no marcará la remediación como completa hasta que el comando global:
   ```bash
   pnpm turbo run build test typecheck
   ```
   retorne con código de salida `0` libre de warnings.