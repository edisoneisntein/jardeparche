import { describe, expect, it } from "vitest";
import { MemoryService, MemoryStore } from "@jarvis/memory";
import { evaluateExpression } from "../src/builtin/calculator.js";
import { createToolRegistry } from "../src/builtin/index.js";
import { ToolRegistry, ToolValidationError } from "../src/registry.js";
import type { ToolServices } from "../src/types.js";

async function services(overrides: Partial<ToolServices["config"]> = {}): Promise<ToolServices> {
  const store = new MemoryStore();
  await store.init();
  return {
    memory: new MemoryService({ store }),
    config: { documentsRoots: [], webSearch: {}, maxResultBytes: 64 * 1024, ...overrides },
  };
}

const ctx = {
  userId: "alice",
  sessionId: "00000000-0000-0000-0000-000000000000",
  taskId: "t1",
  correlationId: "c1",
  now: () => new Date("2026-01-02T03:04:05.000Z"),
};

describe("evaluateExpression", () => {
  it.each([
    ["2+2", 4],
    ["(2+3)*sqrt(16)", 20],
    ["2^10", 1024],
    ["10 % 3", 1],
    ["max(1, 5, 3)", 5],
    ["round(3.14159, 2)", 3.14],
    ["-2 + 5", 3],
    ["pi", Math.PI],
  ])("evaluates %s", (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected as number, 10);
  });

  it.each([["2/0"], ["alert(1)"], ["process.exit()"], ["2 +"], ["(2+3"], ["1;2"], ["$x"]])(
    "rejects unsafe or invalid expression %s",
    (expression) => {
      expect(() => evaluateExpression(expression)).toThrow();
    },
  );
});

describe("ToolRegistry", () => {
  it("only advertises configured tools to the model", async () => {
    const registry = createToolRegistry(await services());
    const names = registry.toProviderTools().map((tool) => tool.function.name);
    expect(names).toContain("time_now");
    expect(names).toContain("math_calculate");
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("document_read");
  });

  it("advertises provider-safe names and still resolves them back to the real tools", async () => {
    const registry = createToolRegistry(await services());
    for (const tool of registry.toProviderTools()) {
      expect(tool.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect(registry.resolveName("math_calculate")).toBe("math.calculate");
    expect(registry.get("math_calculate")?.name).toBe("math.calculate");
    expect(registry.get("math.calculate")?.name).toBe("math.calculate");
  });

  it("executes the calculator tool and returns a structured result", async () => {
    const registry = createToolRegistry(await services());
    const result = await registry.execute("math.calculate", { expression: "(2+3)*sqrt(16)" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ expression: "(2+3)*sqrt(16)", value: 20 });
  });

  it("rejects invalid arguments before side effects", async () => {
    const registry = createToolRegistry(await services());
    await expect(registry.execute("math.calculate", { expression: 42 }, ctx)).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("reports unconfigured tools as unavailable without faking output", async () => {
    const registry = createToolRegistry(await services());
    const result = await registry.execute("web.search", { query: "nvidia" }, ctx);
    expect(result.unavailable).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("flags destructive tools as requiring approval", async () => {
    const registry = createToolRegistry(await services());
    expect(registry.get("task.delete")?.requiresApproval).toBe(true);
    expect(registry.get("memory.remember")?.requiresApproval).toBe(true);
    expect(registry.get("task.create")?.requiresApproval).toBe(false);
  });

  it("persists tasks created through the authorized path", async () => {
    const registry = createToolRegistry(await services());
    const created = await registry.execute("task.create", { title: "comprar café" }, ctx);
    expect(created.ok).toBe(true);
    const listed = await registry.execute("task.list", {}, ctx);
    expect(JSON.stringify(listed.data)).toContain("comprar café");
  });

  it("blocks document reads outside the authorized roots", async () => {
    const registry = createToolRegistry(await services({ documentsRoots: ["/tmp/jarvis-allowed"] }));
    const result = await registry.execute("document.read", { path: "/etc/passwd" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_not_allowed");
  });

  it("enforces the per-tool timeout budget", async () => {
    const registry = new ToolRegistry().register({
      name: "slow.tool",
      title: "Slow",
      description: "never resolves in time",
      risk: "public_read",
      requiresApproval: false,
      timeoutMs: 20,
      parameters: { type: "object", properties: {} },
      parse: (raw) => raw,
      availability: () => ({ available: true }),
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: "late", unavailable: false }), 200)),
    });
    await expect(registry.execute("slow.tool", {}, ctx)).rejects.toThrow(/exceeded its 20 ms budget/);
  });
});
