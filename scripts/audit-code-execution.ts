/* eslint-disable no-console */
/**
 * Verificación empírica del aislamiento y del contrato de las tools de
 * ejecución de código. Ejecuta código REAL en contenedores docker reales y
 * comprueba las propiedades declaradas por la directiva EJ-01.
 */

import { createExecuteCodeInterpreterTool, createCompileAndRunTool } from "../packages/tool-registry/src/builtin/code-execution.js";
import { ToolRegistry } from "../packages/tool-registry/src/registry.js";
import type { ToolContext } from "../packages/shared/src/index.js";

const config = {
  documentsRoots: [],
  webSearch: {},
  maxResultBytes: 256 * 1024,
  sandboxImages: {},
};

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "audit-task",
  correlationId: "audit-correlation",
  now: () => new Date(),
};

const interpreter = createExecuteCodeInterpreterTool(config);
const compiler = createCompileAndRunTool(config);
const registry = new ToolRegistry({ maxResultBytes: config.maxResultBytes }).registerAll([interpreter, compiler]);

function show(label: string, result: Awaited<ReturnType<typeof registry.execute>>) {
  const data = (result.data ?? {}) as Record<string, unknown>;
  const stdout = typeof data.stdout === "string" ? data.stdout.trim() : "";
  const stderr = typeof data.stderr === "string" ? data.stderr.trim().split("\n").slice(0, 3).join(" | ") : "";
  console.log(
    JSON.stringify({
      label,
      ok: result.ok,
      error: result.error,
      exit_code: data.exit_code,
      timed_out: data.timed_out,
      oom_killed: data.oom_killed,
      truncated: data.truncated,
      execution_time_ms: data.execution_time_ms,
      stdout: stdout.slice(0, 160),
      stderr: stderr.slice(0, 160),
      sandbox: data.sandbox,
    }),
  );
}

console.log("=== disponibilidad (lo que el modelo ve) ===");
console.log("interpreter:", JSON.stringify(interpreter.availability()));
console.log("compiler   :", JSON.stringify(compiler.availability()));
console.log("provider tools:", registry.toProviderTools().map((t) => t.function.name).join(", "));

console.log("\n=== 1. ejecución correcta ===");
show("python correcto", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import sys\nprint('hola sandbox', sys.version.split()[0])\nprint(2**64)\n",
}, ctx));

console.log("\n=== 2. identidad del usuario dentro del contenedor ===");
show("uid", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import os,subprocess\nprint('uid=', os.getuid())\nprint(subprocess.run(['id'],capture_output=True,text=True).stdout.strip())\n",
}, ctx));

console.log("\n=== 3. red: el sandbox no puede salir ===");
show("red bloqueada", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import socket\ntry:\n    socket.create_connection(('1.1.1.1',443),timeout=3)\n    print('CONECTADO')\nexcept Exception as e:\n    print('BLOQUEADO:', type(e).__name__, e)\n",
}, ctx));

console.log("\n=== 4. filesystem de solo lectura ===");
show("escritura fuera de /tmp", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "try:\n    open('/opt/jarvis-test','w').write('x')\n    print('ESCRIBIO')\nexcept Exception as e:\n    print('BLOQUEADO:', type(e).__name__, e)\n",
}, ctx));

console.log("\n=== 5. /tmp es escribible ===");
show("escritura en /tmp", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "open('/tmp/x.txt','w').write('ok')\nprint('ESCRIBIO', open('/tmp/x.txt').read())\n",
}, ctx));

console.log("\n=== 6. limite de memoria (OOM) ===");
show("oom", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "x = bytearray(600 * 1024 * 1024)\nprint('nunca llega aquí')\n",
  memory_limit_mb: 128,
  timeout_seconds: 20,
}, ctx));

console.log("\n=== 7. timeout ===");
show("timeout", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import time\ntime.sleep(60)\nprint('nunca')\n",
  timeout_seconds: 3,
}, ctx));

console.log("\n=== 8. el gate estático bloquea antes del sandbox ===");
show("gate: rm -rf", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import shutil\nshutil.rmtree('/')\n",
}, ctx));
show("gate: red", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "import urllib.request\nurllib.request.urlopen('http://example.com')\n",
}, ctx));

console.log("\n=== 9. salida enorme: truncado CON bandera ===");
show("truncado", await registry.execute("code.execute_interpreter", {
  language: "python",
  code_string: "print('x' * 900000)\n",
}, ctx));

console.log("\n=== 10. nodejs ===");
show("node", await registry.execute("code.execute_interpreter", {
  language: "nodejs",
  code_string: "console.log('hola node', process.version);\nconsole.log(Buffer.from('abc').toString('base64'));\n",
}, ctx));

console.log("\n=== 11. compilador: fases separadas ===");
show("cpp", await registry.execute("code.compile_and_run", {
  language: "cpp",
  code_string: "#include <cstdio>\nint main(){ std::printf(\"hola cpp\\n\"); return 0; }\n",
}, ctx));
show("rust", await registry.execute("code.compile_and_run", {
  language: "rust",
  code_string: "fn main(){ println!(\"hola rust\"); }\n",
}, ctx));
show("go", await registry.execute("code.compile_and_run", {
  language: "go",
  code_string: "package main\nimport \"fmt\"\nfunc main(){ fmt.Println(\"hola go\") }\n",
}, ctx));

console.log("\n=== 12. compilacion fallida: fase build identificada ===");
show("cpp roto", await registry.execute("code.compile_and_run", {
  language: "cpp",
  code_string: "int main(){ return undefined_symbol; }\n",
}, ctx));
