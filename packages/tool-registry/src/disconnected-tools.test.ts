import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileIoTool, isInside } from "./builtin/file-io.js";
import { createSafeShellTool } from "./builtin/safe-shell.js";
import { createComputerUseTool } from "./builtin/computer-use.js";
import { effectiveToolConfig, type ToolConfig } from "./types.js";
import type { ToolContext } from "@jarvis/shared";

const workspace = mkdtempSync(join(tmpdir(), "jarvis-fileio-test-"));
writeFileSync(join(workspace, "notas.txt"), "linea1\nlinea2\n", "utf8");

const config: ToolConfig = effectiveToolConfig({
  documentsRoots: [],
  webSearch: {},
  maxResultBytes: 256 * 1024,
  workspaceRoot: workspace,
  shellAllowlist: ["ls", "pwd", "env", "sleep", "cat", "python3", "find", "npm", "git"],
  computerUseDriver: join(process.cwd(), "infra", "computer-use", "driver.py"),
});

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "test",
  correlationId: "test",
  now: () => new Date(),
};

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe("file.io", () => {
  const tool = createFileIoTool(config);

  it("lee un archivo real del workspace", async () => {
    const result = await tool.execute({ action: "read", path: "notas.txt" }, ctx);
    expect(result.ok).toBe(true);
    expect((result.data as { content: string }).content).toContain("linea1");
  });

  it("escribe y relee un archivo real", async () => {
    const written = await tool.execute({ action: "write", path: "sub/nuevo.txt", content: "hola\n" }, ctx);
    expect(written.ok).toBe(true);
    const read = await tool.execute({ action: "read", path: "sub/nuevo.txt" }, ctx);
    expect((read.data as { content: string }).content).toBe("hola\n");
  });

  it("rechaza el escape del workspace", async () => {
    const result = await tool.execute({ action: "read", path: "../../../../etc/passwd" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
  });

  it("rechaza las rutas absolutas", async () => {
    const result = await tool.execute({ action: "read", path: "/etc/passwd" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
  });

  it("detecta la escapada por prefijo (el fallo de startsWith)", () => {
    expect(isInside("/tmp/workspace", "/tmp/workspace/file.txt")).toBe(true);
    expect(isInside("/tmp/workspace", "/tmp/workspace-evil/file.txt")).toBe(false);
    expect(isInside("/tmp/workspace", "/etc/passwd")).toBe(false);
  });

  it("rechaza leer a través de un enlace simbólico que sale del workspace", async () => {
    const secreto = join(tmpdir(), "jarvis-fuera-de-workspace.txt");
    writeFileSync(secreto, "TOP-SECRETO\n", "utf8");
    symlinkSync(secreto, join(workspace, "escape.txt"));
    const result = await tool.execute({ action: "read", path: "escape.txt" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
    expect(JSON.stringify(result)).not.toContain("TOP-SECRETO");
    rmSync(secreto, { force: true });
  });

  it("rechaza escribir a través de un enlace simbólico que sale del workspace", async () => {
    const fuera = join(tmpdir(), "jarvis-fuera-escritura.txt");
    rmSync(fuera, { force: true });
    symlinkSync(fuera, join(workspace, "escape-write.txt"));
    const result = await tool.execute({ action: "write", path: "escape-write.txt", content: "inyectado" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
    expect(existsSync(fuera)).toBe(false);
  });

  it("rechaza escribir dentro de un directorio enlazado fuera del workspace", async () => {
    const fueraDir = mkdtempSync(join(tmpdir(), "jarvis-fuera-dir-"));
    symlinkSync(fueraDir, join(workspace, "enlace-dir"));
    const result = await tool.execute({ action: "write", path: "enlace-dir/nuevo.txt", content: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
    expect(existsSync(join(fueraDir, "nuevo.txt"))).toBe(false);
    rmSync(fueraDir, { recursive: true, force: true });
  });
});

describe("shell.execute", () => {
  const tool = createSafeShellTool(config);

  it("ejecuta un comando permitido de verdad", async () => {
    const result = await tool.execute({ command: ["pwd"], timeout_seconds: 10 }, ctx);
    expect(result.ok).toBe(true);
    expect((result.data as { stdout: string }).stdout).toContain("jarvis-fileio-test");
  });

  it("rechaza un binario fuera de la lista blanca", async () => {
    const result = await tool.execute({ command: ["curl", "https://example.com"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("command_not_allowed");
  });

  it("NO filtra las credenciales del servidor al hijo", async () => {
    process.env.JARVIS_TEST_SECRET = "no-debe-aparecer";
    const result = await tool.execute({ command: ["env"], timeout_seconds: 10 }, ctx);
    delete process.env.JARVIS_TEST_SECRET;
    const stdout = (result.data as { stdout: string }).stdout;
    expect(stdout).not.toContain("no-debe-aparecer");
    expect(stdout).not.toContain("NVIDIA_API_KEY");
  });

  it("mata el grupo de procesos al vencer el tiempo", async () => {
    const result = await tool.execute({ command: ["sleep", "30"], timeout_seconds: 2 }, ctx);
    expect(result.ok).toBe(false);
    const data = result.data as { timed_out: boolean; exit_code: number };
    expect(data.timed_out).toBe(true);
    expect(data.exit_code).toBe(-1);
  });

  it("impide salir del workspace con el directorio de trabajo", async () => {
    const result = await tool.execute({ command: ["ls"], working_directory: "/etc", timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
  });

  it("rechaza leer rutas fuera del workspace", async () => {
    const result = await tool.execute({ command: ["cat", "/etc/passwd"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
  });

  it("rechaza las rutas relativas que suben del workspace", async () => {
    const result = await tool.execute({ command: ["cat", "../../etc/hosts"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("path_outside_workspace");
  });

  it("rechaza el código en línea de los intérpretes", async () => {
    const result = await tool.execute({ command: ["python3", "-c", "print(1)"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("inline_code_rejected");
  });

  it("rechaza que find delegue la ejecución", async () => {
    const result = await tool.execute({ command: ["find", ".", "-exec", "sh", "-c", "id"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("delegated_execution_rejected");
  });

  it("rechaza descargar y ejecutar paquetes", async () => {
    const result = await tool.execute({ command: ["npm", "exec", "--", "curl"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("download_and_execute_rejected");
  });

  it("rechaza la inyección de configuración en git", async () => {
    const result = await tool.execute({ command: ["git", "-c", "core.pager=id", "log"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("git_execution_vector_rejected");
  });

  it("permite los comandos de lectura dentro del workspace", async () => {
    const result = await tool.execute({ command: ["ls", "-la"], timeout_seconds: 5 }, ctx);
    expect(result.ok).toBe(true);
  });
});

describe("computer.use", () => {
  const configBase = { ...config };
  const tool = createComputerUseTool(config);

  it("está apagado por defecto y se puede activar", () => {
    const apagado = createComputerUseTool({ ...configBase, enableComputerUse: false });
    expect(apagado.availability().available).toBe(false);
    expect(apagado.availability().reason).toContain("JARVIS_ENABLE_COMPUTER_USE");

    const encendido = createComputerUseTool({ ...configBase, enableComputerUse: true });
    const availability = encendido.availability();
    if (process.platform !== "darwin") {
      expect(availability.available).toBe(false);
      expect(availability.reason).toContain("macOS");
    } else {
      expect(typeof availability.available).toBe("boolean");
    }
  });

  it("rechaza en el borde las acciones fuera del contrato (validación zod)", () => {
    expect(() => tool.parse({ action: "teletransport" })).toThrow();
    expect(() => tool.parse({ action: "type_text" })).toThrow();
  });

  it("lee el tamaño de pantalla REAL cuando el driver está disponible", async () => {
    if (process.platform !== "darwin") return;
    const availability = tool.availability();
    if (!availability.available) return;
    const result = await tool.execute({ action: "get_screen_info" }, ctx);
    expect(result.ok).toBe(true);
    const screen = (result.data as { screen: { width: number; height: number } }).screen;
    expect(screen.width).toBeGreaterThan(0);
    expect(screen.height).toBeGreaterThan(0);
  });
});
