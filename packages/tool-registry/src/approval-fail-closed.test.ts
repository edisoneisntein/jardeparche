import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/registry.js";
import type { ToolDefinition } from "@jarvis/shared";

const SECRET = "secreto-de-prueba";

const ctx = {
  userId: "alice",
  sessionId: "11111111-1111-1111-1111-111111111111",
  taskId: "t1",
  correlationId: "c1",
  now: () => new Date(),
};

const mutating: ToolDefinition<{ id: string }> = {
  name: "test.dangerous",
  title: "Tool de prueba",
  description: "Tool mutativa de prueba",
  risk: "destructive",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  parse: (raw: unknown) => raw as { id: string },
  timeoutMs: 1000,
  requiresApproval: true,
  availability: () => ({ available: true }),
  execute: async () => ({ ok: true, summary: "hecho", unavailable: false }),
};

function registryWith(tool: ToolDefinition<{ id: string }> = mutating): ToolRegistry {
  return new ToolRegistry({ approvalSecret: SECRET }).register(tool);
}

function grantFor(registry: ToolRegistry, args: unknown): string {
  return registry.issueGrant({
    toolName: "test.dangerous",
    userId: "alice",
    sessionId: ctx.sessionId,
    taskId: "t1",
    toolCallId: "c1",
    arguments: args,
    mode: "user",
  });
}

describe("SEC-002 · el registro es fail-closed", () => {
  it("una tool que exige aprobación NO se ejecuta sin token", async () => {
    const registry = registryWith();
    await expect(registry.execute("test.dangerous", { id: "abc" }, ctx)).rejects.toThrow(/ACCESO DENEGADO/);
  });

  it("se ejecuta si el token vale para esa llamada exacta", async () => {
    const registry = registryWith();
    const token = grantFor(registry, { id: "abc" });
    const result = await registry.execute("test.dangerous", { id: "abc" }, ctx, token);
    expect(result.ok).toBe(true);
  });

  it("el token de una llamada no sirve para otra con otros argumentos", async () => {
    const registry = registryWith();
    const token = grantFor(registry, { id: "abc" });
    await expect(registry.execute("test.dangerous", { id: "otro" }, ctx, token)).rejects.toThrow(/ACCESO DENEGADO/);
  });

  it("un token emitido por otro registro no vale", async () => {
    const registry = registryWith();
    const otro = new ToolRegistry({ approvalSecret: "otro-secreto" }).register(mutating);
    const token = grantFor(otro, { id: "abc" });
    await expect(registry.execute("test.dangerous", { id: "abc" }, ctx, token)).rejects.toThrow(/ACCESO DENEGADO/);
  });

  it("una tool que NO exige aprobación se ejecuta sin token", async () => {
    const registry = registryWith({ ...mutating, requiresApproval: false });
    const result = await registry.execute("test.dangerous", { id: "abc" }, ctx);
    expect(result.ok).toBe(true);
  });

  it("una tool inexistente se rechaza (fail-closed por nombre)", async () => {
    const registry = registryWith();
    await expect(registry.execute("test.inexistente", { id: "abc" }, ctx)).rejects.toThrow(/unknown tool/);
  });
});
