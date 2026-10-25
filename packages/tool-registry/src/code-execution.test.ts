import { describe, expect, it } from "vitest";
import { createCompileAndRunTool, createExecuteCodeInterpreterTool } from "./builtin/code-execution.js";
import { setContainerImageProbe, warmupContainerImages } from "./sandbox.js";
import { ToolRegistry } from "./registry.js";
import type { ToolContext } from "@jarvis/shared";

const config = { documentsRoots: [], webSearch: {}, maxResultBytes: 256 * 1024, sandboxImages: {} };

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "task",
  correlationId: "correlation",
  now: () => new Date(),
};

function registry() {
  return new ToolRegistry({ maxResultBytes: config.maxResultBytes }).registerAll([
    createExecuteCodeInterpreterTool(config),
    createCompileAndRunTool(config),
  ]);
}

describe("contrato de las tools de ejecución", () => {
  it("el gate estático rechaza código destructivo ANTES del sandbox", async () => {
    const result = await registry().execute(
      "code.execute_interpreter",
      { language: "python", code_string: "import shutil\nshutil.rmtree('/important')" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("static_gate_rejected");
    const findings = (result.data as { findings: Array<{ ruleId: string; severity: string; line: number }> }).findings;
    expect(findings.some((f) => f.ruleId === "fs.rm_rf" && f.severity === "reject")).toBe(true);
  });

  it("el gate también bloquea el egreso de red", async () => {
    const result = await registry().execute(
      "code.execute_interpreter",
      { language: "python", code_string: "import urllib.request\nurllib.request.urlopen('http://x')" },
      ctx,
    );
    expect(result.error).toBe("static_gate_rejected");
  });

  it("el gate revisa también los archivos adicionales del proyecto", async () => {
    const result = await registry().execute(
      "code.compile_and_run",
      { language: "cpp", code_string: "int main(){return 0;}", files: { "evil.sh": "rm -rf / --no-preserve-root" } },
      ctx,
    );
    expect(result.error).toBe("static_gate_rejected");
  });

  it("el contrato declara las banderas de integridad que exige la directiva", () => {
    const tool = createExecuteCodeInterpreterTool(config);
    const properties = tool.parameters.properties as Record<string, unknown>;
    for (const field of ["language", "code_string", "timeout_seconds", "memory_limit_mb"]) {
      expect(properties[field]).toBeDefined();
    }
    expect(tool.parameters.required).toEqual(["language", "code_string"]);
    // El techo lo impone el runtime: el valor del modelo está acotado.
    expect((properties.timeout_seconds as { maximum: number }).maximum).toBe(120);
    expect((properties.memory_limit_mb as { maximum: number }).maximum).toBe(2048);
  });

  it("los parametros se validan antes de ejecutar", async () => {
    await expect(
      registry().execute("code.execute_interpreter", { language: "brainfuck", code_string: "x" }, ctx),
    ).rejects.toThrow();
  });

  it("las tools no se anuncian al modelo si el sandbox no está disponible", () => {
    const sinImagen = createExecuteCodeInterpreterTool({
      ...config,
      sandboxImages: { python: "jarvis-imagen-inexistente:latest" },
    });
    const availability = sinImagen.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain("jarvis-imagen-inexistente");
  });

  it("el nombre publicado al modelo es compatible con OpenAI", async () => {
    // El sondeo de imágenes se inyecta y se precalienta: el test no depende de
    // que este entorno tenga las imágenes de sandbox construidas, y reproduce
    // el arranque real del servidor.
    setContainerImageProbe(async () => true);
    try {
      await warmupContainerImages(["python:3.12-slim", "node:22-slim", "jarvis-sandbox:latest"]);
      const names = registry().toProviderTools().map((tool) => tool.function.name);
      for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(names).toContain("code_execute_interpreter");
    } finally {
      setContainerImageProbe(null);
    }
  });
});
