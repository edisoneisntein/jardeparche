/* eslint-disable no-console */
/**
 * ¿Existe UN SOLO modelo que cumpla los tres roles (razonamiento+tools,
 * visión, embeddings)? Se responde con sondas REALES contra la API, usando la
 * configuración del repo (que es la que funciona).
 */

import { readFileSync } from "node:fs";
import { loadNvidiaConfig } from "../packages/ai-provider/src/config.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const cfg = loadNvidiaConfig(env);
const BASE = cfg.baseUrl.replace(/\/$/, "");
const HEADERS = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };

async function post(path, body) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, ms: Date.now() - started, text };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, text: String(error).slice(0, 120) };
  }
}

const TOOLS = [
  {
    type: "function",
    function: { name: "time_now", description: "Hora actual", parameters: { type: "object", properties: {} } },
  },
];

const MODELS = [
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/llama-nemotron-embed-vl-1b-v2",
  "nvidia/nemotron-3-embed-1b",
  "nvidia/llama-3.2-nv-embedqa-1b-v1",
];

console.log("modelo".padEnd(48), "chat+tools".padEnd(22), "embeddings".padEnd(24), "¿chat Y embed?");
for (const model of MODELS) {
  const chat = await post("chat/completions", {
    model,
    messages: [{ role: "user", content: "di hola" }],
    tools: TOOLS,
    max_tokens: 24,
  });
  const embed = await post("embeddings", { model, input: ["prueba"], input_type: "query" });
  const chatOk = chat.status === 200;
  const embedOk = embed.status === 200;
  const chatDetail = chatOk ? "OK" : `HTTP ${chat.status}`;
  const embedDetail = embedOk ? `OK (${JSON.parse(embed.text).data?.[0]?.embedding?.length ?? 0} dims)` : `HTTP ${embed.status}`;
  console.log(
    model.padEnd(48),
    chatDetail.padEnd(22),
    embedDetail.padEnd(24),
    chatOk && embedOk ? "SÍ" : "no",
  );
}

console.log("\n--- detalle de un embedding multimodal real (si responde) ---");
const emb = await post("embeddings", { model: "nvidia/llama-nemotron-embed-vl-1b-v2", input: ["prueba"], input_type: "query" });
console.log(emb.text.slice(0, 300));
