#!/usr/bin/env node
/**
 * Genera texto con Remix Remix Prompt VIP (Gemini) en modo experto.
 *
 * Uso: node remix_generate.mjs <modo> <archivo-contexto.md> [salida.md]
 * Variables: REMIX_BASE (default http://127.0.0.1:3010), IDEA (opcional, sobreescribe la consigna)
 *
 * Modos: general | creator | auditor_elite | app_auditor | prompt_augmenter |
 *        architect_v3 | adversarial_architect | prompt_chainer | direct_assistant |
 *        media_analyzer | loop_engineer
 */
import fs from "node:fs/promises";
import path from "node:path";

const MODE = process.argv[2];
const CONTEXT_FILE = process.argv[3];
const OUT = process.argv[4] ?? null;
const BASE = process.env.REMIX_BASE ?? "http://127.0.0.1:3010";

if (!MODE || !CONTEXT_FILE) {
  console.error("Uso: node remix_generate.mjs <modo> <contexto.md> [salida.md]");
  process.exit(1);
}

const CONTEXT = await fs.readFile(CONTEXT_FILE, "utf8");

const DEFAULT_IDEA = {
  auditor_elite: `Realiza una auditoría técnica senior del código descrito en la evidencia adjunta. Entrega en español, en markdown: (1) debilidades reales de arquitectura y diseño citando archivo/símbolo; (2) riesgos de seguridad y de datos; (3) oportunidades de optimización de rendimiento y costo; (4) tabla de mejoras priorizadas por impacto/esfuerzo. No inventes: si un dato no está en la evidencia, dilo.`,
  app_auditor: `Audita la aplicación descrita en la evidencia adjunta. En español y markdown: debilidades, riesgos, optimizaciones y mejoras priorizadas, citando rutas concretas.`,
  creator: `A partir de la auditoría adjunta, redacta las INSTRUCCIONES DE AGENTE/SUBAGENTE listas para ejecución: (1) agente coordinador (rol, alcance, reglas de decisión, cuándo delegar); (2) un subagente por hallazgo priorizado con objetivo, archivos permitidos, pasos, criterios de aceptación verificables y comandos de verificación; (3) contrato de handoff. No inventes rutas que no estén en la auditoría.`,
  prompt_augmenter: `Mejora y completa la instrucción adjunta para que sea inequívoca, verificable y accionable por un agente de código. Devuelve solo la instrucción mejorada.`,
}[MODE] ?? `Analiza el documento adjunto y entrega el mejor resultado posible según tu especialidad.`;

const IDEA = process.env.IDEA ?? DEFAULT_IDEA;

const res = await fetch(`${BASE}/api/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ idea: IDEA, mode: MODE, documents: [{ name: path.basename(CONTEXT_FILE), content: CONTEXT, type: "text/plain" }] }),
});
if (!res.ok) { console.error("remix ->", res.status, await res.text()); process.exit(1); }

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let out = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const parts = buffer.split("\n\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.replace(/^data: /, "").trim();
    if (!line || line === "[DONE]") continue;
    const event = JSON.parse(line);
    if (event.error) { console.error("ERROR:", event.error); process.exit(1); }
    if (event.text) out += event.text;
  }
}

if (OUT) {
  await fs.mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
  await fs.writeFile(OUT, out);
  console.error(`[remix] ${MODE} -> ${OUT} (${out.length} chars)`);
} else {
  process.stdout.write(out);
}
