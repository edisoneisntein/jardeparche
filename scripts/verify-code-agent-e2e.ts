/* eslint-disable no-console */
/**
 * Prueba de extremo a extremo del subagente de ejecución: un turno real contra
 * NVIDIA NIM en el que el modelo debe DECIDIR usar la tool de código, el
 * gate debe dejarla pasar, el sandbox debe ejecutarla y la respuesta debe
 * incorporar la stdout real.
 */

import { readFileSync } from "node:fs";
import { NvidiaNimProvider } from "../packages/ai-provider/src/nim-provider.js";
import { loadNvidiaConfig } from "../packages/ai-provider/src/config.js";
import { createToolRegistry } from "../packages/tool-registry/src/builtin/index.js";
import { MemoryService } from "../packages/memory/src/memory-service.js";
import { MemoryStore } from "../packages/memory/src/memory-store.js";
import { AgentRuntime } from "../packages/agent-runtime/src/runtime.js";
import { buildCodeExecutionPrompt } from "../packages/agent-runtime/src/code-execution-prompt.js";
import type { ServerEvent } from "../packages/shared/src/index.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const provider = new NvidiaNimProvider(loadNvidiaConfig(env));
const store = new MemoryStore();
const memory = new MemoryService({ store, embedder: provider });
const registry = createToolRegistry({ memory, config: { documentsRoots: [], webSearch: {}, maxResultBytes: 256 * 1024 } });

const events: ServerEvent[] = [];
const runtime = new AgentRuntime({
  provider,
  registry,
  memory,
  emit: (event) => {
    events.push(event);
    if (event.type === "tool.started") console.log("  [tool.started]", event.name, JSON.stringify(event.arguments).slice(0, 160));
    if (event.type === "tool.completed") console.log("  [tool.completed]", event.name, "→", event.summary.slice(0, 120));
    if (event.type === "tool.failed") console.log("  [tool.failed]", event.name, "→", event.error);
  },
  log: () => {},
});

const sessionId = "00000000-0000-4000-8000-000000000001";
const actor = { userId: "local", sessionId };

console.log("=== turno real: el modelo debe usar la tool de código ===");
const result = await runtime.runTurn(actor, "Escribe y ejecuta un programa en Python que imprima los 10 primeros números primos, uno por línea.");

console.log("\n=== respuesta final ===");
console.log(result.text.slice(0, 700));

console.log("\n=== traza de tools ===");
for (const event of events) {
  if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") {
    console.log(` - ${event.type}: ${event.name}`);
  }
}

console.log("\n=== la directiva EJ-01 refleja el registro real ===");
const directive = buildCodeExecutionPrompt(registry.list());
console.log("directiva:", directive.length, "caracteres ·", directive.includes("code.execute_interpreter") ? "incluye el contrato real" : "NO incluye el contrato");
