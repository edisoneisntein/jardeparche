#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Medición de la latencia de la voz con el motor REAL (`say` de macOS).
 *
 * Simula un turno de voz: el texto del modelo llega troceado, como llega por
 * el websocket, y se mide:
 *
 *  · TTFA: del primer fragmento de texto al primer audio listo (lo que oye
 *    el usuario es la espera real, no la suma de optimisticamente);
 *  · el tiempo total hasta que la locución está completa;
 *  · qué voz se usa de verdad y qué texto se manda al sintetizador.
 *
 * Uso: pnpm --filter @jarvis/server exec tsx ../../scripts/voice-latency.ts
 */

import { MacSayTts, SentenceStreamer } from "../packages/voice/src/index.js";

const RESPUESTA =
  "He comprobado la configuración del servidor y el total acumulado es $1,500.50. " +
  "La fecha del informe es 23/10/2026 y el consumo bajó un 12,5% respecto al trimestre anterior. " +
  "El sistema funciona con normalidad y no hay errores registrados en el último arranque. " +
  "Si quieres, preparo el informe completo con el detalle de cada servicio.";

/** Cómo llega el texto del modelo: troceado y con pausas, como por el socket. */
const TROZO_CARACTERES = 24;
const PAZA_ENTRE_TROZOS_MS = 35;

interface Resultado {
  ttfa: number | null;
  fragmentos: number;
  total: number;
}

async function medir(
  etiqueta: string,
  opciones: { maxSentenceChars?: number; maxPendingChars?: number; troceado?: boolean } = {},
): Promise<Resultado> {
  const tts = new MacSayTts();
  await tts.available();
  const segmentos: string[] = [];
  const inicio = Date.now();
  let primerAudio: number | null = null;

  const streamer = new SentenceStreamer({
    tts,
    maxSentenceChars: opciones.maxSentenceChars ?? 320,
    maxPendingChars: opciones.maxPendingChars ?? 160,
    onSegment: (segment) => {
      if (primerAudio === null) primerAudio = Date.now() - inicio;
      segmentos.push(segment.text);
    },
    onEnd: () => undefined,
    onError: (error) => console.error(`  ✗ ${error.message}`),
  });

  streamer.start("voice:smoke");
  if (opciones.troceado === false) {
    // Sin streaming: el audio entero sale de una sola pieza, al final.
    streamer.push(RESPUESTA);
    streamer.flush();
  } else {
    for (let index = 0; index < RESPUESTA.length; index += TROZO_CARACTERES) {
      streamer.push(RESPUESTA.slice(index, index + TROZO_CARACTERES));
      await new Promise((resolve) => setTimeout(resolve, PAZA_ENTRE_TROZOS_MS));
    }
    streamer.flush();
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const total = Date.now() - inicio;
  console.log(`  ${etiqueta.padEnd(34)} TTFA ${String(primerAudio ?? "-").padStart(5)} ms · ${segmentos.length} fragmento(s) · total ${total} ms`);
  return { ttfa: primerAudio, fragmentos: segmentos.length, total };
}

async function main(): Promise<void> {
  const tts = new MacSayTts();
  const status = await tts.available();
  if (!status.ok) {
    console.error(`✗ el motor de voz no está disponible: ${status.reason}`);
    process.exit(1);
  }
  const voice = tts.describe?.();
  console.log(`Voz: ${voice?.voice}  ${voice?.realistic ? "(realista)" : "(NO realista)"}`);
  if (voice && !voice.realistic) console.log(`  → ${voice.hint}`);

  console.log(`\nTexto: "${RESPUESTA}"\n`);

  const sinStreaming = await medir("texto completo de golpe", { troceado: false });
  const conStreaming = await medir("texto llegando troceado (real)", {});

  console.log("\n─────────────────────────────────────────────");
  console.log(`TTFA con el texto llegando troceado: ${conStreaming.ttfa} ms`);
  console.log(`Fragmentos: ${conStreaming.fragmentos}`);
  console.log("\nNota: el TTFA real de extremo a extremo (voz del usuario → primer audio) lo mide");
  console.log("scripts/health-check.mjs contra el servidor en marcha.");
  console.log(`Referencia: sin troceado, ${sinStreaming.ttfa} ms desde que el texto llega completo.`);
}

void main();
