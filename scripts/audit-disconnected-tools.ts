/* eslint-disable no-console */
/**
 * Auditoría empírica de las tools que estaban desconectadas o simuladas:
 * file.io, shell.execute y computer.use. Verifica que ejecutan de verdad y que
 * fallan de verdad cuando deben.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createToolRegistry } from "../packages/tool-registry/src/builtin/index.js";
import { MemoryService } from "../packages/memory/src/memory-service.js";
import { MemoryStore } from "../packages/memory/src/memory-store.js";
import type { ToolContext } from "../packages/shared/src/index.js";

const workspace = join(homedir(), ".jarvis", "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "notas.txt"), "linea1\nlinea2\nlinea3\n", "utf8");

const store = new MemoryStore();
const memory = new MemoryService({ store });
const registry = createToolRegistry({
  memory,
  config: {
    documentsRoots: [],
    webSearch: {},
    maxResultBytes: 256 * 1024,
    workspaceRoot: workspace,
    shellAllowlist: ["ls", "pwd", "cat", "grep", "echo", "sleep", "env"],
    computerUseDriver: fileURLToPath(new URL("../infra/computer-use/driver.py", import.meta.url)),
  },
});

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "audit",
  correlationId: "audit",
  now: () => new Date(),
};

async function run(name: string, tool: string, args: unknown) {
  let result;
  try {
    // La auditoría emite la aprobación de la llamada concreta (como haría el
    // broker tras la confirmación humana).
    const token = registry.issueGrant({
      toolName: tool,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      toolCallId: `audit-${name}`,
      arguments: args,
      mode: "user",
    });
    result = await registry.execute(tool, args, ctx, token);
  } catch (error) {
    console.log(JSON.stringify({ name, ok: false, error: "validation_error", summary: (error as Error).message.slice(0, 160) }));
    return null;
  }
  const data = (result.data ?? {}) as Record<string, unknown>;
  console.log(
    JSON.stringify({
      name,
      ok: result.ok,
      error: result.error,
      summary: result.summary?.slice(0, 150),
      data: Object.fromEntries(Object.entries(data).filter(([k]) => k !== "stdout" && k !== "stderr").slice(0, 6)),
      stdout: typeof data.stdout === "string" ? data.stdout.slice(0, 120) : undefined,
      stderr: typeof data.stderr === "string" ? data.stderr.slice(0, 120) : undefined,
    }),
  );
  return result;
}

console.log("=== file.io ===");
await run("leer real", "file.io", { action: "read", path: "notas.txt" });
await run("leer con rango", "file.io", { action: "read", path: "notas.txt", start_line: 2, end_line: 2 });
await run("escribir real", "file.io", { action: "write", path: "sub/nuevo.txt", content: "hola\n" });
await run("verificar escritura", "file.io", { action: "read", path: "sub/nuevo.txt" });
await run("editar real", "file.io", { action: "edit", path: "notas.txt", old_text: "linea2", new_text: "LINEA-2" });
await run("listar", "file.io", { action: "list", path: "." });
await run("ESCAPE del workspace", "file.io", { action: "read", path: "../../../../etc/passwd" });
await run("ruta absoluta", "file.io", { action: "read", path: "/etc/passwd" });
await run("bloque no encontrado", "file.io", { action: "edit", path: "notas.txt", old_text: "NO_EXISTE", new_text: "x" });

console.log("\n=== shell.execute ===");
await run("ls real", "shell.execute", { command: ["ls", "-1"], timeout_seconds: 10 });
await run("pwd real", "shell.execute", { command: ["pwd"], timeout_seconds: 10 });
await run("binario NO permitido", "shell.execute", { command: ["curl", "https://example.com"] });
await run("timeout + kill de grupo", "shell.execute", { command: ["sleep", "30"], timeout_seconds: 2 });
await run("fuera del workspace", "shell.execute", { command: ["ls"], working_directory: "/etc" });

console.log("\n=== ¿el entorno del hijo filtra credenciales? ===");
await run("env del hijo", "shell.execute", { command: ["env"], timeout_seconds: 10 });

console.log("\n=== computer.use ===");
await run("información de pantalla", "computer.use", { action: "get_screen_info" });
await run("acción inexistente", "computer.use", { action: "teletransport" });
