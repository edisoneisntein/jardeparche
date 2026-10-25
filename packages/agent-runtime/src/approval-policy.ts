/**
 * Políticas de aprobación de herramientas.
 *
 * La seguridad de JARVIS no depende del prompt: depende de QUIÉN puede
 * autorizar un efecto. Por eso la política es un contrato inyectable y no un
 * `if` enterrado en el runtime.
 *
 * Tres políticas, tres perfiles de despliegue:
 *   - `humanApprovalAlways`: nada se auto-aprueba (máxima garantía).
 *   - `riskTieredApproval`: solo lo inocuo se auto-aprueba (equilibrio).
 *   - `autoApproveAll`: todo se auto-aprueba (laboratorio, sin efectos reales).
 */
import type { RiskLevel, ToolDefinition } from "@jarvis/shared";
import type { ApprovalPolicy } from "./contracts.js";

/** Todos los niveles de riesgo:equivale a no restringir la auto-aprobación. */
export const ALL_RISK_LEVELS: readonly RiskLevel[] = ["public_read", "local_reversible", "external_effect", "destructive"];

/** Toda tool que lo pida exige confirmación humana. */
export function humanApprovalAlways(): ApprovalPolicy {
  return {
    requiresHumanApproval: (tool: ToolDefinition) => tool.requiresApproval,
  };
}

/** Ninguna tool exige confirmación humana (solo para entornos de prueba). */
export function autoApproveAll(): ApprovalPolicy {
  return {
    requiresHumanApproval: () => false,
  };
}

/**
 * Política por niveles de riesgo.
 *
 * Args:
 *   auto_approvable: Niveles que la auto-aprobación puede cubrir.
 *
 * Returns:
 *   Una política que exige confirmación humana para todo lo que no esté en
 *   la lista.
 */
export function riskTieredApproval(autoApprovable: readonly RiskLevel[]): ApprovalPolicy {
  const allowed = new Set<RiskLevel>(autoApprovable);
  return {
    requiresHumanApproval: (tool: ToolDefinition) => tool.requiresApproval && !allowed.has(tool.risk),
  };
}
