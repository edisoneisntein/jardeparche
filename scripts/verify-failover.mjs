#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Verificación de extremo a extremo del FAILOVER:
 *   1. Con NIM operativo, la respuesta la produce NIM.
 *   2. Con NIM caído (base URL a un puerto muerto), la respuesta la produce
 *      el proveedor de respaldo y el servidor NO muere.
 *
 * Usa el WebSocket global de Node 22 (API estándar, sin dependencias).
 */

const PORT = Number(process.argv[2] ?? 8788);
const LABEL = process.argv[3] ?? "escenario";

function turn(text) {
  return new Promise((resolve) => {
    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?sessionId=${sessionId}&userId=local`);
    const events = [];
    const finish = (result) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ya cerrada */
      }
      resolve({ events, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, timeout: true }), 90_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.send", sessionId, text }));
    });
    ws.addEventListener("message", (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      events.push(parsed);
      if (parsed.type === "assistant.message_completed") finish({ ok: true, text: parsed.text });
      if (parsed.type === "agent.error") finish({ ok: false, error: parsed.message });
    });
    ws.addEventListener("error", () => finish({ ok: false, error: "error de socket" }));
  });
}

const result = await turn("di hola en una frase");
console.log(`\n=== ${LABEL} ===`);
console.log("respuesta :", (result.text ?? result.error ?? "SIN RESPUESTA").slice(0, 140));
console.log("eventos   :", result.events.map((e) => e.type).join(", ").slice(0, 220));
const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
const brain = health.components.find((c) => c.component === "brain");
console.log("brain     :", brain.status, "|", brain.detail);
const metrics = await fetch(`http://127.0.0.1:${PORT}/api/metrics`).then((r) => r.json());
console.log("failovers :", metrics.counters["provider.failovers"] ?? 0);
