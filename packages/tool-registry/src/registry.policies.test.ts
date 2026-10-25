import { describe, expect, it } from "vitest";
import type { ToolDefinition, ToolResult } from "@jarvis/shared";
import { capResult, ToolRegistry, ToolValidationError } from "./registry.js";

/**
 * Caracterización de las POLÍTICAS del registro (nombres seguros, recorte de
 * resultados, gate estático, validación).
 *
 * Congela el comportamiento que debe sobrevivir a la extracción de cada
 * política a su propia unidad (SRP) sin cambiar el contrato público.
 */

const ctx = {
  userId: "alice",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "t1",
  correlationId: "c1",
  now: () => new Date("2026-01-02T03:04:05.000Z"),
};

function tool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    title: name,
    description: name,
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 1_000,
    parameters: { type: "object", properties: {} },
    parse: (raw) => raw,
    availability: () => ({ available: true }),
    execute: async () => ({ ok: true, summary: "ok", unavailable: false }),
    ...overrides,
  };
}

describe("ToolRegistry · nombres seguros para OpenAI", () => {
  it("sustituye los caracteres no permitidos por guion bajo", () => {
    const registry = new ToolRegistry().register(tool("memoria.avanzada"));
    expect(registry.toProviderTools()[0]?.function.name).toBe("memoria_avanzada");
  });

  it("resuelve el nombre publicado por el modelo al nombre real de la tool", () => {
    const registry = new ToolRegistry().register(tool("memoria.avanzada"));
    expect(registry.resolveName("memoria_avanzada")).toBe("memoria.avanzada");
    expect(registry.get("memoria_avanzada")?.name).toBe("memoria.avanzada");
    expect(registry.get("memoria.avanzada")?.name).toBe("memoria.avanzada");
  });

  it("desambigua dos tools que colapsan al mismo nombre publicado", () => {
    const registry = new ToolRegistry().register(tool("a.b")).register(tool("a_b"));
    const names = registry.toProviderTools().map((t) => t.function.name);
    expect(names).toEqual(["a_b", "a_b_2"]);
    // Cada nombre publicado sigue apuntando a su tool real.
    expect(registry.get("a_b")?.name).toBe("a.b");
    expect(registry.get("a_b_2")?.name).toBe("a_b");
  });

  it("el nombre publicado es estable entre llamadas", () => {
    const registry = new ToolRegistry().register(tool("a.b"));
    const first = registry.toProviderTools()[0]?.function.name;
    const second = registry.toProviderTools()[0]?.function.name;
    expect(first).toBe(second);
  });
});

describe("ToolRegistry · validación antes de cualquier efecto", () => {
  it("una tool inexistente se rechaza con ToolValidationError", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("no.existe", {}, ctx)).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("los argumentos se validan con el parse de la tool", async () => {
    const registry = new ToolRegistry().register(
      tool("echo", { parse: (raw) => { const v = raw as { n?: number }; if (typeof v.n !== "number") throw new Error("n must be a number"); return v; } }),
    );
    await expect(registry.execute("echo", { n: "texto" }, ctx)).rejects.toThrow(/n must be a number/);
  });

  it("una tool no configurada se reporta como unavailable, sin inventar resultado", async () => {
    const registry = new ToolRegistry().register(
      tool("sin.config", { availability: () => ({ available: false, reason: "falta la clave" }) }),
    );
    const result = await registry.execute("sin.config", {}, ctx);
    expect(result.unavailable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("falta la clave");
  });
});

describe("ToolRegistry · el gate estático va antes que la disponibilidad", () => {
  it("rechaza el código destructivo aunque la tool no esté disponible", async () => {
    const registry = new ToolRegistry().register(
      tool("code.execute_interpreter", {
        availability: () => ({ available: false, reason: "no hay imagen de sandbox" }),
      }),
    );
    const result = await registry.execute(
      "code.execute_interpreter",
      { code_string: "import shutil\nshutil.rmtree('/importante')" },
      ctx,
    );
    // La capa autoritativa es el gate: el mensaje NO puede ser «no disponible».
    expect(result.error).toBe("static_gate_rejected");
    expect(result.unavailable).toBe(false);
  });

  it("una tool no gateada se ejecuta aunque su availability sea falsa", async () => {
    const registry = new ToolRegistry().register(
      tool("code.otra", { availability: () => ({ available: false, reason: "no configurada" }) }),
    );
    const result = await registry.execute("code.otra", {}, ctx);
    expect(result.error).toBe("no configurada");
    expect(result.unavailable).toBe(true);
  });
});

describe("capResult · recorte del payload", () => {
  const result = (data: unknown): ToolResult => ({ ok: true, summary: "s", unavailable: false, data });

  it("marca el truncamiento cuando una cadena supera el límite", () => {
    const capped = capResult(result({ texto: "x".repeat(100) }), 10);
    const data = capped.data as Record<string, unknown>;
    expect((data.texto as string).length).toBeLessThan(100);
    expect((data.texto as string)).toContain("salida truncada");
    expect(data.truncated).toBe(true);
  });

  it("no marca truncamiento cuando todo cabe", () => {
    const capped = capResult(result({ texto: "corto" }), 100);
    expect((capped.data as Record<string, unknown>).truncated).toBeUndefined();
  });

  it("deja intacto un payload que no es un objeto", () => {
    const original = result("texto plano");
    expect(capResult(original, 10).data).toBe("texto plano");
  });

  it("conserva las claves no textuales tal cual", () => {
    const capped = capResult(result({ total: 42, okFlag: true }), 10);
    expect(capped.data).toMatchObject({ total: 42, okFlag: true });
  });
});
