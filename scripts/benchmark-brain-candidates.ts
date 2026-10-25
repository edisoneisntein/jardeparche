/* eslint-disable no-console */
/**
 * Benchmark de candidatos a "cerebro" del agente.
 *
 * Mide, con llamadas REALES, lo que decide si un modelo sirve para JARVIS:
 *   · TTFT del primer token de CONTENIDO (el razonamiento previo es latencia
 *     que el runtime descarta).
 *   · Tokens/caracteres de razonamiento emitidos antes del contenido.
 *   · Latencia total y finish_reason (los modelos de razonamiento con
 *     `max_tokens` corto terminan con `finish_reason: "length"` y contenido
 *     vacío).
 *   · Soporte real de tool calling (chunk `tool_calls`).
 *   · Capacidad de visión: si admite una imagen real y la describe.
 *
 * Uso:
 *   OPENROUTER_API_KEY=... pnpm --filter @jarvis/server exec tsx ../../scripts/benchmark-brain-candidates.ts
 *
 * Sin clave de OpenRouter, la sección de OpenRouter se omite (no se simula).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadNvidiaConfig } from "../packages/ai-provider/src/config.js";
import { loadOpenRouterConfig } from "../packages/ai-provider/src/openrouter-provider.js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const TOOLS = [
  {
    type: "function",
    function: { name: "time_now", description: "Devuelve la hora actual", parameters: { type: "object", properties: {}, required: [] } },
  },
];

interface Endpoint {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
}

function nvidiaEndpoint(model: string): Endpoint {
  const cfg = loadNvidiaConfig(env);
  return { label: "nvidia-nim", baseUrl: cfg.baseUrl.replace(/\/$/, ""), apiKey: cfg.apiKey, model };
}

function openRouterEndpoint(model: string): Endpoint | null {
  const cfg = loadOpenRouterConfig({ ...env, ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}) });
  if (!cfg) return null;
  return {
    label: "openrouter",
    baseUrl: cfg.baseUrl.replace(/\/$/, ""),
    apiKey: cfg.apiKey,
    model,
    reasoningEffort: cfg.reasoningEffort,
  };
}

interface ProbeResult {
  ttftContentMs: number | null;
  reasoningChars: number;
  contentChars: number;
  toolCallChunks: number;
  totalMs: number;
  finishReason: string | null;
  error?: string;
}

async function probeText(endpoint: Endpoint, useTools: boolean): Promise<ProbeResult> {
  const started = Date.now();
  let firstContent: number | null = null;
  let reasoningChars = 0;
  let contentChars = 0;
  let toolCallChunks = 0;
  let finishReason: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages: [{ role: "user", content: "Dime qué hora es usando la herramienta." }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2048,
    };
    if (useTools) {
      body.tools = TOOLS;
      body.tool_choice = "auto";
    }
    if (endpoint.reasoningEffort) body.reasoning_effort = endpoint.reasoningEffort;

    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(endpoint.label === "openrouter" ? { "HTTP-Referer": "http://localhost:8787", "X-Title": "JARVIS" } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        ttftContentMs: null, reasoningChars: 0, contentChars: 0, toolCallChunks: 0,
        totalMs: Date.now() - started, finishReason: null, error: `HTTP ${response.status}: ${text.slice(0, 140)}`,
      };
    }
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let raw: any;
        try { raw = JSON.parse(payload); } catch { continue; }
        const delta = raw.choices?.[0]?.delta;
        const reasoning = delta?.reasoning ?? delta?.reasoning_content;
        if (reasoning) reasoningChars += String(reasoning).length;
        if (delta?.content) {
          contentChars += String(delta.content).length;
          if (firstContent === null) firstContent = Date.now() - started;
        }
        if (delta?.tool_calls?.length) toolCallChunks += 1;
        if (raw.choices?.[0]?.finish_reason) finishReason = raw.choices?.[0]?.finish_reason;
      }
    }
    return { ttftContentMs: firstContent, reasoningChars, contentChars, toolCallChunks, totalMs: Date.now() - started, finishReason };
  } catch (error) {
    return {
      ttftContentMs: null, reasoningChars: 0, contentChars: 0, toolCallChunks: 0,
      totalMs: Date.now() - started, finishReason: null, error: String(error).slice(0, 140),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Prueba de visión con una imagen real del propio repositorio. */
async function probeVision(endpoint: Endpoint): Promise<{ ok: boolean; detail: string; ms: number }> {
  const imagePath = fileURLToPath(new URL("../apps/web/public/assets/jarvis/arc-reactor-disc.jpg", import.meta.url));
  const base64 = readFileSync(imagePath).toString("base64");
  const started = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe en una frase qué se ve en la imagen." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
          ],
        },
      ],
      max_tokens: 512,
    };
    if (endpoint.reasoningEffort) body.reasoning_effort = endpoint.reasoningEffort;
    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.apiKey}`,
        "Content-Type": "application/json",
        ...(endpoint.label === "openrouter" ? { "HTTP-Referer": "http://localhost:8787", "X-Title": "JARVIS" } : {}),
      },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, detail: `HTTP ${response.status}: ${text.slice(0, 160)}`, ms };
    }
    const raw = (await response.json()) as any;
    const content = raw.choices?.[0]?.message?.content ?? "";
    return { ok: Boolean(content), detail: String(content).slice(0, 180), ms };
  } catch (error) {
    return { ok: false, detail: String(error).slice(0, 160), ms: Date.now() - started };
  }
}

const CANDIDATES: Array<{ endpoint: Endpoint; tag: string; vision: boolean }> = [
  { endpoint: nvidiaEndpoint("nvidia/nemotron-3.5-lightning-30b-a3b"), tag: "ACTUAL (razonador)", vision: false },
  { endpoint: nvidiaEndpoint("nvidia/nemotron-3.5-super-vl-120b-a12b"), tag: "visión actual (VLM)", vision: true },
  { endpoint: nvidiaEndpoint("nvidia/nemotron-nano-3-30b-a3b"), tag: "nano (rápido)", vision: false },
  { endpoint: nvidiaEndpoint("z-ai/glm-5.3-flash"), tag: "flash multimodal", vision: true },
];

const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
if (openRouterKey) {
  for (const [model, tag] of [
    ["minimax/minimax-m3.1-flash", "PROPUESTO (razonador+visión)"],
    ["minimax/minimax-m3.1-flash:free", "PROPUESTO (variante gratuita)"],
  ] as const) {
    const endpoint = openRouterEndpoint(model);
    if (endpoint) CANDIDATES.push({ endpoint, tag, vision: true });
  }
} else {
  console.log("(sin OPENROUTER_API_KEY: se omite la sección de OpenRouter)\n");
}

console.log("modelo".padEnd(52), "TTFT contenido".padEnd(17), "razonamiento".padEnd(13), "total".padEnd(9), "tools".padEnd(7), "finish");
console.log("─".repeat(115));
for (const candidate of CANDIDATES) {
  const result = await probeText(candidate.endpoint, true);
  if (result.error) {
    console.log(`${candidate.endpoint.label}/${candidate.endpoint.model}`.padEnd(52), "ERROR:", result.error.slice(0, 70));
    continue;
  }
  console.log(
    `${candidate.endpoint.model}`.padEnd(52),
    `${result.ttftContentMs ?? "-"} ms`.padEnd(17),
    `${result.reasoningChars} ch`.padEnd(13),
    `${result.totalMs} ms`.padEnd(9),
    `${result.toolCallChunks}`.padEnd(7),
    String(result.finishReason),
  );
}

console.log("\n=== CAPACIDAD DE VISIÓN (imagen real del repo) ===");
for (const candidate of CANDIDATES) {
  if (!candidate.vision) continue;
  const vision = await probeVision(candidate.endpoint);
  console.log(`${candidate.endpoint.model}`.padEnd(52), vision.ok ? "OK" : "FALLO", `${vision.ms} ms`.padEnd(9), vision.detail.slice(0, 110));
}
