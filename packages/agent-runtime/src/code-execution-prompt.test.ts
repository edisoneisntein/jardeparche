import { describe, expect, it } from "vitest";
import { buildCodeExecutionPrompt, CODE_EXECUTION_TOOL_NAMES } from "./code-execution-prompt.js";
import type { ToolDefinition } from "@jarvis/shared";

const TOOLS: ToolDefinition[] = [
  {
    name: "code.execute_interpreter",
    title: "Intérprete de código aislado",
    description: "Ejecuta código Python o Node.js en un contenedor efímero y aislado.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: 125_000,
    parameters: {
      type: "object",
      properties: { language: { type: "string", enum: ["python", "nodejs"] }, code_string: { type: "string" } },
      required: ["language", "code_string"],
      additionalProperties: false,
    },
    parse: (raw) => raw,
    availability: () => ({ available: true }),
    execute: async () => ({ ok: true, summary: "", unavailable: false }),
  },
  {
    name: "code.compile_and_run",
    title: "Compilación y ejecución aislada",
    description: "Compila un proyecto pequeño y ejecuta el binario resultante.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: 310_000,
    parameters: {
      type: "object",
      properties: { language: { type: "string", enum: ["cpp", "rust", "go"] } },
      required: ["language", "code_string"],
      additionalProperties: false,
    },
    parse: (raw) => raw,
    availability: () => ({ available: true }),
    execute: async () => ({ ok: true, summary: "", unavailable: false }),
  },
];

describe("directiva EJ-01", () => {
  const prompt = buildCodeExecutionPrompt(TOOLS);

  it("incluye el contrato real de cada herramienta registrada", () => {
    for (const tool of TOOLS) {
      expect(prompt).toContain(tool.name);
      expect(prompt).toContain(tool.description);
      expect(prompt).toContain(JSON.stringify(tool.parameters, null, 2));
    }
  });

  it("el contrato no puede divergir del JSON Schema publicado al modelo", () => {
    for (const tool of TOOLS) {
      const block = prompt.split(`### ${tool.name}`)[1] ?? "";
      expect(block).toContain('"required"');
      for (const required of (tool.parameters.required as string[])) {
        expect(block).toContain(`"${required}"`);
      }
    }
  });

  it("declara el ciclo ReAct y sus cinco fases", () => {
    for (const phase of ["FASE A", "FASE B", "FASE C", "FASE D", "FASE E"]) {
      expect(prompt).toContain(phase);
    }
    expect(prompt).toContain("máximo 3 iteraciones");
  });

  it("fija la regla de cero simulación y el formato de entrega", () => {
    expect(prompt).toContain("cero simulación");
    expect(prompt).toContain("VERIFICADO");
    expect(prompt).toContain("INFERIDO");
    for (const block of ["ENFOQUE ALGORÍTMICO", "CÓDIGO EJECUTADO FINAL", "SALIDA EMPÍRICA VERIFICADA", "VERIFICACIÓN ANALÍTICA"]) {
      expect(prompt).toContain(block);
    }
  });

  it("declara las banderas de integridad que el agente necesita", () => {
    for (const flag of ["truncated", "timed_out", "oom_killed", "run_id", "limits_clamped"]) {
      expect(prompt).toContain(flag);
    }
  });

  it("falla si no hay herramientas de ejecución registradas", () => {
    expect(() => buildCodeExecutionPrompt([])).toThrow();
  });

  it("los nombres de tool son los esperados por el runtime", () => {
    expect(CODE_EXECUTION_TOOL_NAMES).toContain("code.execute_interpreter");
    expect(CODE_EXECUTION_TOOL_NAMES).toContain("code.compile_and_run");
  });
});
