#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Prueba de extremo a extremo de las tools que nunca habían pasado por el
 * modelo real. Responde automáticamente a las aprobaciones (file.io y
 * shell.execute las piden) y comprueba el resultado.
 */

const BASE = process.env.JARVIS_URL ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

const CASOS = [
  {
    nombre: "file.io (escribe y lee un archivo)",
    peticion: "Escribe en un archivo llamado nota-prueba.txt el texto 'hola desde JARVIS' y luego léelo y dime qué pone.",
    tools: ["file.io"],
  },
  {
    nombre: "shell.execute (comando en la terminal)",
    peticion: "Ejecuta en la terminal el comando pwd y dime el directorio de trabajo.",
    tools: ["shell.execute"],
  },
  {
    nombre: "code.execute_interpreter (python)",
    peticion: "Ejecuta en Python: print(6*7) y dime el resultado.",
    tools: ["code.execute_interpreter"],
  },
  {
    nombre: "code.compile_and_run (C++)",
    peticion: "Compila y ejecuta un programa en C++ que imprima 'hola desde C++'.",
    tools: ["code.compile_and_run"],
  },
  {
    nombre: "memoria propia (memory.search / rag.local_search)",
    peticion: "Busca en mi memoria qué sabes de mí.",
    tools: ["memory.search", "rag.local_search"],
  },
];

function probar(caso) {
  return new Promise((resolve) => {
    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${sessionId}&userId=local`);
    const usadas = new Set();
    const aprobaciones = new Set();
    let ultima = "";
    const t0 = Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ya cerrada */ }
      resolve({ usadas: [...usadas], aprobaciones: [...aprobaciones], ultima, timeout: true });
    }, 180000);

    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "chat.send", sessionId, text: caso.peticion })));
    ws.addEventListener("message", (event) => {
      let p;
      try { p = JSON.parse(String(event.data)); } catch { return; }
      if (p.type === "tool.started") usadas.add(p.name);
      if (p.type === "tool.awaiting_approval" && !aprobaciones.has(p.approvalId)) {
        aprobaciones.add(p.approvalId);
        // Se aprueba: el broker registra la decisión y la tool se ejecuta.
        ws.send(JSON.stringify({ type: "approval.respond", sessionId, approvalId: p.approvalId, approve: true }));
      }
      if (p.type === "tool.completed") ultima = `${p.name}: ${String(p.summary).slice(0, 110)}`;
      if (p.type === "assistant.message_completed") {
        clearTimeout(timer);
        const texto = p.text ?? "";
        try { ws.close(); } catch { /* ya cerrada */ }
        resolve({ usadas: [...usadas], aprobaciones: [...aprobaciones], ultima, texto, ms: Date.now() - t0 });
      }
      if (p.type === "agent.error") {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ya cerrada */ }
        resolve({ usadas: [...usadas], aprobaciones: [...aprobaciones], ultima, error: p.message, ms: Date.now() - t0 });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ usadas: [...usadas], aprobaciones: [...aprobaciones], ultima, error: "error de socket" });
    });
  });
}

let fallos = 0;
console.log("\n=== tools por el modelo real (con aprobación automática) ===\n");
for (const caso of CASOS) {
  const r = await probar(caso);
  // Varias tools pueden servir legitimately el mismo propósito (p. ej. las
  // dos de memoria): basta con que se use ALGUNA de las admitidas.
  const ok = caso.tools.some((t) => r.usadas.some((u) => u.includes(t.replace(".", "_")) || u === t));
  if (!ok) fallos += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${caso.nombre}`);
  console.log(`      tools usadas: ${r.usadas.join(", ") || "NINGUNA"}`);
  console.log(`      aprobaciones: ${r.aprobaciones.length}`);
  if (r.ultima) console.log(`      resultado    : ${r.ultima}`);
  if (r.texto) console.log(`      respuesta    : ${r.texto.replace(/\s+/g, " ").slice(0, 150)}`);
  if (r.error) console.log(`      ERROR        : ${r.error.slice(0, 140)}`);
  console.log(`      (${r.ms ?? "?"} ms)`);
}
console.log(`\n  ${fallos === 0 ? "TODAS LAS TOOLS FUNCIONAN" : `${fallos} CASO(S) CON FALLOS`}\n`);
process.exit(fallos === 0 ? 0 : 1);
