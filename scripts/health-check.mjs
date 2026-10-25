#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Chequeo de salud de extremo a extremo de JARVIS.
 *
 * Ejercita las capacidades reales y dice qué funciona, con la latencia
 * medida. Pensado para ejecutarse después de cualquier cambio y para no
 * depender de la memoria de nadie.
 *
 *   node scripts/health-check.mjs            # contra http://127.0.0.1:8787
 *   JARVIS_URL=http://127.0.0.1:8787 node scripts/health-check.mjs
 *
 * Sale con código 1 si algo falla: sirve como comprobación automática.
 */

const BASE = process.env.JARVIS_URL ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

const resultados = [];
let huboFallo = false;

async function comprobar(nombre, fn) {
  const inicio = Date.now();
  try {
    const detalle = await fn();
    const ms = Date.now() - inicio;
    resultados.push({ nombre, ok: true, ms, detalle });
    console.log(`  ✓ ${nombre.padEnd(26)} ${String(ms).padStart(6)} ms   ${detalle ?? ""}`);
  } catch (error) {
    huboFallo = true;
    const ms = Date.now() - inicio;
    resultados.push({ nombre, ok: false, ms, detalle: error.message });
    console.log(`  ✗ ${nombre.padEnd(26)} ${String(ms).padStart(6)} ms   ${error.message.slice(0, 90)}`);
  }
}

async function json(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Turno real por WebSocket: comprueba el cerebro y, si hay voz, el audio. */
function turno(mensaje, { esperarAudio = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${sessionId}&userId=local`);
    const eventos = [];
    let hayAudio = false;
    let audioReal = null;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ya cerrada */ }
      reject(new Error("tiempo agotado"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.send", sessionId, text: mensaje }));
    });
    ws.addEventListener("message", (event) => {
      let p;
      try { p = JSON.parse(String(event.data)); } catch { return; }
      eventos.push(p);
      if (p.type === "voice.audio.segment") {
        hayAudio = true;
        audioReal = { ms: Date.now() - t0, kb: Math.round(String(event.data).length / 1024) };
        if (!esperarAudio) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ya cerrada */ }
          resolve({ eventos, audio: audioReal, texto: "" });
        }
        return;
      }
      if (p.type === "assistant.message_completed") {
        // El audio del servidor llega DESPUÉS del mensaje: la última frase
        // solo se cierra al final. Se espera por el segmento (con un motor
        // lento, ~1x tiempo real, 6 s no bastaban).
        if (esperarAudio && !hayAudio) {
          setTimeout(() => {
            clearTimeout(timer);
            try { ws.close(); } catch { /* ya cerrada */ }
            resolve({ eventos, audio: audioReal, texto: p.text ?? "" });
          }, 20000);
          return;
        }
        clearTimeout(timer);
        try { ws.close(); } catch { /* ya cerrada */ }
        resolve({ eventos, audio: audioReal, texto: p.text ?? "" });
        return;
      }
      if (p.type === "agent.error") {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ya cerrada */ }
        reject(new Error(p.message));
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("error de socket"));
    });
  });
}

/**
 * Interrupción (barge-in): el usuario corta la respuesta a mitad.
 *
 * Lo que se comprueba es lo que se oía mal antes: el audio del turno
 * cancelado NO debe seguir llegando. Un segmento que llega después de la
 * interrupción significa que el turno viejo se volvió a verbalizar.
 */
function interrumpir(mensaje, { silencioMs = 6000, graciaMs = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const sessionId = crypto.randomUUID();
    const ws = new WebSocket(`${WS_BASE}/ws?sessionId=${sessionId}&userId=local`);
    const segmentos = [];
    let cancelado = false;
    let cancelMs = 0;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ya cerrada */ }
      reject(new Error("tiempo agotado"));
    }, 90000);
    const cortar = () => {
      if (cancelado) return;
      cancelado = true;
      cancelMs = Date.now();
      ws.send(JSON.stringify({ type: "chat.cancel", sessionId }));
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "chat.send", sessionId, text: mensaje }));
    });
    ws.addEventListener("message", (event) => {
      let p;
      try { p = JSON.parse(String(event.data)); } catch { return; }
      if (p.type === "voice.audio.segment") {
        segmentos.push({ ms: cancelado ? Date.now() - cancelMs : -1, kb: Math.round(String(event.data).length / 1024) });
        // El usuario corta EN CUANDO JARVIS empieza a hablar: ese es el barge-in.
        if (!cancelado) cortar();
        return;
      }
      if (p.type === "assistant.message_completed" || p.type === "task.cancelled") {
        if (!cancelado) return;
        // Tras el mensaje solo puede llegar el audio que ya estaba en vuelo:
        // se espera un poco y se comprueba que no llega el del turno viejo.
        setTimeout(() => {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ya cerrada */ }
          resolve(segmentos);
        }, silencioMs);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ya cerrada */ }
      reject(new Error("error de socket"));
    });
  });
}

console.log(`\nJARVIS · chequeo de salud · ${BASE}\n`);

await comprobar("servidor", async () => {
  const health = await json("/api/health");
  const brain = health.components.find((c) => c.component === "brain");
  if (brain.status === "down") throw new Error(brain.detail ?? "cerebro caído");
  return `brain=${brain.status} · global=${health.status}`;
});

await comprobar("cerebro (NVIDIA NIM)", async () => {
  const r = await turno("Responde con una sola palabra: listo");
  if (!r.texto) throw new Error("sin respuesta");
  return `"${r.texto.trim().replace(/\s+/g, " ").slice(0, 40)}"`;
});

await comprobar("voz (audio del servidor)", async () => {
  const r = await turno("Dime en una frase qué es un índice vectorial.", { esperarAudio: true });
  if (!r.audio) throw new Error("no llegó audio del servidor");
  return `primer audio a los ${r.audio.ms} ms (${r.audio.kb} KB)`;
});

await comprobar("voz (interrupción)", async () => {
  // El corte se hace en cuanto JARVIS empieza a hablar: ese es el barge-in.
  const segmentos = await interrumpir("Explica con detalle cómo funciona un índice vectorial para recuperación semántica.");
  if (segmentos.length === 0) throw new Error("no llegó audio antes de cortar: la prueba no vale");
  // Con una gracia de 400 ms se acepta el audio que ya estaba en vuelo.
  const tardios = segmentos.filter((s) => s.ms > 400);
  if (tardios.length > 0) {
    throw new Error(`llegan ${tardios.length} fragmento(s) de audio ${tardios[0].ms} ms después de cortar: el turno viejo se volvió a verbalizar`);
  }
  return `${segmentos.length} fragmento(s), ninguno después del corte`;
});

await comprobar("búsqueda web", async () => {
  // Pregunta que OBLIGA a buscar: el agente no puede saberlo de memoria.
  const r = await turno("Busca en la web cuándo juega la Selección Colombia su próximo partido.");
  const busqueda = r.eventos.find((e) => e.type === "tool.started" && e.name.includes("web"));
  if (!busqueda) throw new Error("el agente no usó la búsqueda web");
  const lectura = r.eventos.find((e) => e.type === "tool.started" && e.name.includes("fetch"));
  return lectura ? "web.search + web.fetch" : "web.search";
});

await comprobar("memoria (postgres)", async () => {
  const facts = await json("/api/memory/facts?limit=1");
  return `hechos registrados: ${Array.isArray(facts) ? facts.length : 0}`;
});

await comprobar("sandbox de código", async () => {
  const r = await turno("Ejecuta en Python: print(6*7) y dime el resultado.");
  const tool = r.eventos.find((e) => e.type === "tool.started" && e.name.includes("code"));
  if (!tool) throw new Error("el agente no usó el intérprete");
  return "code.execute_interpreter invocada";
});

await comprobar("catálogo de herramientas", async () => {
  const caps = await json("/api/capabilities");
  const total = caps.tools.length;
  const disponibles = caps.tools.filter((t) => t.available).length;
  const noDisponibles = caps.tools.filter((t) => !t.available).map((t) => t.name);
  return `${disponibles}/${total} disponibles${noDisponibles.length ? ` · ausentes: ${noDisponibles.join(", ")}` : ""}`;
});

console.log(`\n  ${huboFallo ? "HAY FALLOS" : "TODO CORRECTO"}\n`);
process.exit(huboFallo ? 1 : 0);
