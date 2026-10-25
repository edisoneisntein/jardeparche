#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Ciclo completo de failover: conmutación por fallo y RECUPERACIÓN AUTOMÁTICA
 * del primario (sin reiniciar el servidor).
 *
 *   1. Primario (mock A) operativo  → la respuesta la produce el primario.
 *   2. Primario caído               → conmutación al respaldo (contador +1).
 *   3. Primario restaurado          → el vigilante de salud lo re-promueve
 *                                     y la siguiente respuesta vuelve al
 *                                     primario (sin tocar nada a mano).
 */

import { spawn } from "node:child_process";

const MOCK_A_PORT = 8898;
const MOCK_B_PORT = 8899;
const SERVER_PORT = 8790;
const ROOT = "/Users/edisonrodriguez/Documents/jarvis-main";

function startMock(port, label) {
  const child = spawn("node", [`${ROOT}/scripts/mock-openrouter.mjs`, String(port)], {
    env: { ...process.env, MOCK_MODEL: label },
    stdio: "ignore",
  });
  return child;
}

function turn(text) {
  return new Promise((resolve) => {
    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?sessionId=${sessionId}&userId=local`);
    const events = [];
    const finish = (result) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ya cerrada */ }
      resolve({ events, ...result });
    };
    const timer = setTimeout(() => finish({ ok: false, timeout: true }), 90_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "chat.send", sessionId, text })));
    ws.addEventListener("message", (event) => {
      let parsed;
      try { parsed = JSON.parse(String(event.data)); } catch { return; }
      events.push(parsed);
      if (parsed.type === "assistant.message_completed") finish({ ok: true, text: parsed.text });
      if (parsed.type === "agent.error") finish({ ok: false, error: parsed.message });
    });
    ws.addEventListener("error", () => finish({ ok: false, error: "error de socket" }));
  });
}

const metrics = async () => {
  const data = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/metrics`).then((r) => r.json());
  return data.counters["provider.failovers"] ?? 0;
};
const brain = async () => {
  const data = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`).then((r) => r.json());
  return data.components.find((c) => c.component === "brain");
};

const mockA = startMock(MOCK_A_PORT, "PRIMARIO/MOCK-A");
const mockB = startMock(MOCK_B_PORT, "RESPALDO/MOCK-B");
await new Promise((r) => setTimeout(r, 1500));

const server = spawn("node", [`${ROOT}/apps/server/dist/index.js`], {
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    NVIDIA_BASE_URL: `http://127.0.0.1:${MOCK_A_PORT}/v1`,
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_B_PORT}/v1`,
    OPENROUTER_MODEL: "minimax/minimax-m3.1-flash",
    PERSISTENCE: "memory",
    LOG_LEVEL: "info",
  },
  stdio: "ignore",
});

try {
  await new Promise((r) => setTimeout(r, 6000));
  console.log("\n[1] PRIMARIO OPERATIVO");
  let t = await turn("hola");
  console.log("    respuesta  :", (t.text ?? t.error).slice(0, 60));
  console.log("    modelo     :", t.events.filter((e) => e.type === "assistant.message_completed").length ? "ok" : "?");
  console.log("    failovers  :", await metrics());
  console.log("    brain      :", (await brain()).detail.slice(0, 110));

  console.log("\n[2] PRIMARIO CAÍDO (mock A apagado)");
  mockA.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 2000));
  t = await turn("hola otra vez");
  console.log("    respuesta  :", (t.text ?? t.error).slice(0, 60));
  console.log("    failovers  :", await metrics(), "(debe ser 1)");
  console.log("    brain      :", (await brain()).detail.slice(0, 110));

  console.log("\n[3] PRIMARIO RESTAURADO (mock A vuelve) — recuperación automática");
  const mockA2 = startMock(MOCK_A_PORT, "PRIMARIO/MOCK-A");
  await new Promise((r) => setTimeout(r, 26_000)); // el vigilante corre cada 20 s
  t = await turn("hola de nuevo");
  console.log("    respuesta  :", (t.text ?? t.error).slice(0, 60));
  console.log("    failovers  :", await metrics(), "(sigue en 1: no hubo nueva conmutación)");
  console.log("    brain      :", (await brain()).detail.slice(0, 110));
  mockA2.kill("SIGKILL");
} finally {
  server.kill("SIGTERM");
  mockA.kill("SIGKILL");
  mockB.kill("SIGKILL");
}
