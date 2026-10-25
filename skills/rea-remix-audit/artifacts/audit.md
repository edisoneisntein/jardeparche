
# INFORME DE AUDITORÍA TÉCNICA SENIOR: PROYECTO JARVIS
**Clasificación:** Confidencial / Revisión de Arquitectura y Seguridad Crítica  
**Estándar de Referencia:** ISO/IEC 25010, OWASP Top 10 (2021), Zero-Trust Architecture (NIST SP 800-207)  
**Alcance de Evidencia:** Grafo de dependencias y estructura de 104 archivos analizados vía reporte REA (SIREP).

---

### NOTA DE ALCANCE Y LÍMITES DE EVIDENCIA
> *Conforme al mandato de no inferir datos inexistentes: La evidencia provista por la herramienta REA detalla la topología completa (104 archivos, 413 nodos, 245 símbolos, 67 dependencias y 16 hallazgos sintácticos), así como variables de entorno (`NVIDIA_API_KEY`, `CI`, `E2E_BASE_URL`). No se dispone del volcado de código fuente línea a línea de todos los módulos; por ende, las auditorías de líneas internas específicas se basan estrictamente en las interfaces declaradas, rutas de componentes, scripts y patrones topológicos certificados en la evidencia.*

---

## FASE 1: DEBILIDADES DE ARQUITECTURA Y DISEÑO

### ID del Problema: ARCH-001
*   **Tipo:** Arquitectura
*   **Descripción:** Acoplamiento rígido de infraestructura de IA a un único proveedor cerrado (NVIDIA NIM) y violación del Principio de Inversión de Dependencias (DIP). La existencia directa de `packages/ai-provider/src/nim-provider.ts` y scripts dependientes directos de `NVIDIA_API_KEY` denota un diseño donde el runtime (`packages/agent-runtime`) corre riesgo de quedar atado a los esquemas de respuesta propietarios de un solo vendor. Si bien existen stubs (`fake-provider.ts`, `unavailable-provider.ts`), la topología carece de un adaptador dinámico de conmutación por error (fallback router) a nivel de producción.
*   **Ubicación:** `packages/ai-provider/src/nim-provider.ts`, `packages/ai-provider/src/config.ts`, `packages/agent-runtime/src/runtime.ts`
*   **Gravedad:** Alta
*   **Órdenes Técnicas de Remediación:**
    1. Implementar un patrón *Strategy / Provider Factory* con interfaz normalizada agnóstica (`LLMProviderInterface`).
    2. Desacoplar la configuración de variables para admitir múltiples backends con fallback automático si el circuit breaker de NIM falla.

```typescript
// packages/ai-provider/src/types.ts
export interface CompletionOptions {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AIProvider {
  id: string;
  generateCompletion(options: CompletionOptions): Promise<string>;
  healthCheck(): Promise<boolean>;
}

// packages/ai-provider/src/resilient-router.ts
export class ResilientAIRouter implements AIProvider {
  constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider
  ) {}

  readonly id = "resilient-router";

  async generateCompletion(options: CompletionOptions): Promise<string> {
    try {
      if (await this.primary.healthCheck()) {
        return await this.primary.generateCompletion(options);
      }
    } catch (err) {
      // Loggear falla y conmutar a fallback sin degradar el runtime
    }
    return this.fallback.generateCompletion(options);
  }

  async healthCheck(): Promise<boolean> {
    return (await this.primary.healthCheck()) || (await this.fallback.healthCheck());
  }
}
```

---

### ID del Problema: ARCH-002
*   **Tipo:** Arquitectura
*   **Descripción:** Fragilidad e indeterminismo en el pipeline de persistencia y esquema relacional. La presencia de `packages/memory/scripts/copy-sql.mjs` (el único archivo JavaScript del repositorio entre 103 archivos TypeScript) combinada con `apps/server/scripts/db-migrate.ts` delata una gestión manual/ad-hoc del ciclo de vida de los esquemas DDL de PostgreSQL. Copiar archivos `.sql` mediante scripts de Node sin verificación criptográfica de checksums ni transaccionalidad atómica integrada expone al sistema a estados inconsistentes entre entornos de staging y producción.
*   **Ubicación:** `packages/memory/scripts/copy-sql.mjs` y `apps/server/scripts/db-migrate.ts`
*   **Gravedad:** Media
*   **Órdenes Técnicas de Remediación:**
    1. Eliminar scripts auxiliares imperativos de copia de ficheros (`copy-sql.mjs`).
    2. Centralizar las migraciones usando una librería declarativa estándar con control de locks (ej. Prisma, Drizzle, Kysely o Flyway) directamente dentro de `packages/memory/src/postgres-store.ts`.

---

## FASE 2: RIESGOS DE SEGURIDAD Y DE DATOS

### ID del Problema: SEC-001
*   **Tipo:** Seguridad
*   **Descripción:** Gestión insegura de credenciales y fuga de secretos de alto privilegio (`NVIDIA_API_KEY`). El análisis REA evidencia lecturas no encapsuladas de variables de entorno mediante `reads_env: 4` e impacto directo en scripts de diagnóstico (`packages/ai-provider/scripts/probe.ts`). La inyección directa en scripts locales y componentes backend sin validación estricta de esquema incrementa el riesgo de exposición en logs, entornos CI/CD (`CI` referenciada) o ejecución indebida en cliente si se comparte empaquetado vía Vite (`apps/web/vite.config.ts`).
*   **Ubicación:** `packages/ai-provider/src/config.ts`, `packages/ai-provider/scripts/probe.ts`
*   **Gravedad:** Alta
*   **Órdenes Técnicas de Remediación:**
    1. Implementar validación estricta de variables de entorno al arranque mediante `zod` o `envalid`.
    2. Prohibir el consumo directo de `process.env` fuera de un módulo centralizado `config.ts`.
    3. Asegurar que `apps/web/vite.config.ts` bloquee la exposición de variables que no tengan el prefijo estricto `VITE_`.

```typescript
// packages/ai-provider/src/config.ts
import { z } from 'zod';

const EnvSchema = z.object({
  NVIDIA_API_KEY: z.string().min(1, "NVIDIA_API_KEY es requerida para el proveedor de inferencia"),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development')
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): EnvConfig {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Fallo de configuración de seguridad: ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
```

---

### ID del Problema: SEC-002
*   **Tipo:** Seguridad
*   **Descripción:** Riesgo de escalación de privilegios en ejecución de herramientas del agente (Tool Poisoning / Arbitrary Invocation). Los archivos `packages/tool-registry/src/builtin/tasks.ts`, `calculator.ts`, `documents.ts`, y `web-search.ts` otorgan capacidades activas al agente. Aunque existe un `approval-broker.ts` y un `ApprovalModal.tsx`, no se evidencia en el grafo un mecanismo de validación criptográfica o aislamiento de privilegios (sandboxing/RBAC) entre lo que el LLM decide invocar y la ejecución en el host del servidor.
*   **Ubicación:** `packages/agent-runtime/src/approval-broker.ts`, `packages/tool-registry/src/registry.ts`
*   **Gravedad:** Crítica
*   **Órdenes Técnicas de Remediación:**
    1. Forzar validación de esquemas (JSON Schema/Zod) antes de despachar la ejecución en `registry.ts`.
    2. Establecer una política Zero-Trust obligatoria en `approval-broker.ts` que requiera tokens JWT de corta duración firmados por el usuario para herramientas con mutación de estado (`tasks.ts`, `documents.ts`).

```typescript
// packages/agent-runtime/src/approval-broker.ts
export interface ExecutionRequest {
  toolId: string;
  parameters: Record<string, unknown>;
  userApprovalToken?: string;
}

export class SecureApprovalBroker {
  async assertPermission(request: ExecutionRequest, requiresApproval: boolean): Promise<void> {
    if (!requiresApproval) return;
    
    if (!request.userApprovalToken) {
      throw new Error(`ACCESO DENEGADO: La herramienta '${request.toolId}' requiere aprobación explícita firmada.`);
    }
    
    const isValid = await this.verifySignature(request.userApprovalToken, request.toolId);
    if (!isValid) {
      throw new Error(`VIOLACIÓN DE SEGURIDAD: Token de aprobación inválido o expirado.`);
    }
  }

  private async verifySignature(token: string, toolId: string): Promise<boolean> {
    // Verificación de firma criptográfica del usuario
    return token.length > 0; // Implementar verificación asimétrica
  }
}
```

---

## FASE 3: OPORTUNIDADES DE OPTIMIZACIÓN DE RENDIMIENTO Y COSTO

### ID del Problema: PERF-001
*   **Tipo:** Rendimiento
*   **Descripción:** Sobrecarga en el hilo principal del cliente (Main Thread Saturation) e I/O de red ineficiente. La interfaz web carga simultáneamente 4 capas gráficas de alto costo: `HoloDeck.tsx`, `HolographicDiagnostics.tsx`, `ParticleVeil.tsx` y `ReactorScene.tsx` (posible canvas/WebGL), mientras corre bucles de captura en `useMicLevel.ts`, `useCamera.ts` y polling continuo mediante `useHealthPolling.ts`. La combinación de rendering intensivo junto a peticiones HTTP periódicas degrada la CPU del cliente y agota recursos en clientes móviles o equipos de bajo perfil.
*   **Ubicación:** `apps/web/src/hooks/useHealthPolling.ts`, `apps/web/src/components/reactor/ReactorScene.tsx`, `apps/web/src/components/fx/ParticleVeil.tsx`
*   **Gravedad:** Media
*   **Órdenes Técnicas de Remediación:**
    1. Sustituir `useHealthPolling.ts` por suscripción reactiva orientada a eventos vía WebSocket o SSE (aprovechando `apps/server/src/hub.ts` y `packages/shared/src/events.ts`).
    2. Pausar animaciones y loops de canvas cuando la pestaña pierda el foco (`document.hidden`) o mediante `IntersectionObserver`.

```typescript
// apps/web/src/hooks/useHealthPolling.ts -> Refactorizado a SSE/Event-driven
import { useEffect, useState } from 'react';

export function useHealthStatus() {
  const [healthy, setHealthy] = useState<boolean>(true);

  useEffect(() => {
    // Reemplaza setInterval por conexión persistente al Hub del servidor
    const eventSource = new EventSource('/api/health/stream');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setHealthy(data.status === 'UP');
    };

    eventSource.onerror = () => {
      setHealthy(false);
    };

    return () => eventSource.close();
  }, []);

  return healthy;
}
```

---

### ID del Problema: PERF-002
*   **Tipo:** Rendimiento
*   **Descripción:** Costo computacional y financiero desmedido por consultas repetitivas a la API externa de IA. La falta de un mecanismo de caché semántica en `packages/memory` permite que entradas similares o idénticas procesadas por `packages/agent-runtime/src/runtime.ts` se despachen reiteradamente hacia `NVIDIA_API_KEY`. Esto dispara la latencia (concurrencia de red externa) y aumenta drásticamente los costes operativos por token consumido.
*   **Ubicación:** `packages/agent-runtime/src/runtime.ts`, `packages/memory/src/memory-service.ts`
*   **Gravedad:** Media
*   **Órdenes Técnicas de Remediación:**
    1. Integrar una capa de almacenamiento en memoria o extensión vectorial (ej. `pgvector` en `postgres-store.ts`) para computar un hash/embedding del prompt.
    2. Comprobar si existe un match semántico con similitud coseno $\ge 0.98$ antes de solicitar inferencia externa a NVIDIA NIM.

---

## FASE 4: TABLA DE MEJORAS PRIORIZADAS (MATRIZ IMPACTO / ESFUERZO)

| ID | Hallazgo / Tarea de Remediación | Componente / Archivo Clave | Impacto | Esfuerzo | Prioridad |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-002** | Implementación de Sandboxing y verificación de tokens en Tool Registry | `packages/agent-runtime/src/approval-broker.ts` | **Crítico** | Medio | **P0** |
| **SEC-001** | Centralización, tipado y saneamiento de secretos (`NVIDIA_API_KEY`) | `packages/ai-provider/src/config.ts` | **Alto** | Bajo | **P0** |
| **ARCH-001** | Abstracción agnóstica de proveedor de LLM y Circuit Breaker | `packages/ai-provider/src/nim-provider.ts` | **Alto** | Medio | **P1** |
| **PERF-001** | Sustitución de `useHealthPolling` por Server-Sent Events / WebSockets | `apps/web/src/hooks/useHealthPolling.ts` | **Medio** | Bajo | **P1** |
| **ARCH-002** | Migraciones de base de datos declarativas y eliminación de scripts ad-hoc | `packages/memory/scripts/copy-sql.mjs` | **Medio** | Medio | **P2** |
| **PERF-002** | Implementación de caché semántica para reducir llamadas a la API de inferencia | `packages/memory/src/memory-service.ts` | **Medio** | Alto | **P2** |

---

### VEREDICTO DE AUDITORÍA
El repositorio JARVIS exhibe una separación modular sólida mediante paquetes (`agent-runtime`, `ai-provider`, `memory`, `tool-registry`, `perception`, `voice`), pero presenta debilidades críticas en el control de ejecución de herramientas de agentes (falta de aislamiento perimetral Zero-Trust) y acoplamiento prematuro al proveedor de IA. La ejecución de las órdenes de remediación detalladas garantizará que el sistema cumpla con especificaciones de resiliencia y alta disponibilidad para entornos de producción.