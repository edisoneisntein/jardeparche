import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@jarvis/shared";
import { ALL_RISK_LEVELS, autoApproveAll, humanApprovalAlways, riskTieredApproval } from "./approval-policy.js";

/**
 * Caracterización de la POLÍTICA de aprobación.
 *
 * `requiresApproval` solo significa algo si la política que lo aplica no
 * anula todos los niveles de riesgo por omisión. Estos tests congelan los
 * tres perfiles de despliegue.
 */
function tool(risk: ToolDefinition["risk"], requiresApproval = true): ToolDefinition {
  return {
    name: "tool",
    title: "tool",
    description: "tool",
    risk,
    requiresApproval,
    timeoutMs: 1_000,
    parameters: { type: "object", properties: {} },
    parse: (raw) => raw,
    availability: () => ({ available: true }),
    execute: async () => ({ ok: true, summary: "ok", unavailable: false }),
  };
}

describe("políticas de aprobación", () => {
  it("humanApprovalAlways exige confirmación para toda tool que lo pida", () => {
    const policy = humanApprovalAlways();
    expect(policy.requiresHumanApproval(tool("public_read"))).toBe(true);
    expect(policy.requiresHumanApproval(tool("destructive"))).toBe(true);
    // Una tool que no pide aprobación, no la exige.
    expect(policy.requiresHumanApproval(tool("destructive", false))).toBe(false);
  });

  it("riskTieredApproval solo auto-aprueba los niveles permitidos", () => {
    const policy = riskTieredApproval(["public_read", "local_reversible"]);
    expect(policy.requiresHumanApproval(tool("public_read"))).toBe(false);
    expect(policy.requiresHumanApproval(tool("local_reversible"))).toBe(false);
    expect(policy.requiresHumanApproval(tool("external_effect"))).toBe(true);
    expect(policy.requiresHumanApproval(tool("destructive"))).toBe(true);
  });

  it("autoApproveAll conserva el comportamiento histórico", () => {
    const policy = autoApproveAll();
    expect(policy.requiresHumanApproval(tool("destructive"))).toBe(false);
  });

  it("cubrir todos los niveles equivale a auto-aprobar todo", () => {
    const policy = riskTieredApproval(ALL_RISK_LEVELS);
    for (const risk of ALL_RISK_LEVELS) {
      expect(policy.requiresHumanApproval(tool(risk))).toBe(false);
    }
  });
});
