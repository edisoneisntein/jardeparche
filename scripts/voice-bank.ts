#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Pregraba el banco de frases con la voz CLONADA (Qwen3-TTS).
 *
 * Por qué existe: la clonación en CPU es lentísima (medido en esta máquina:
 * 2 s de audio por cada 116 s de proceso). En directo no sirve, pero
 * pregrabando las frases que JARVIS dice siempre, el tiempo de ejecución es
 * CERO y la voz es la clonada exacta.
 *
 * Se puede dejar corriendo toda la noche: el banco es incremental (las frases
 * ya grabadas no se vuelven a hacer) y cada frase se guarda en cuanto está.
 *
 *   pnpm --filter @jarvis/server exec tsx ../../scripts/voice-bank.ts
 *   pnpm --filter @jarvis/server exec tsx ../../scripts/voice-bank.ts --frases mis-frases.txt
 */

import { readFile } from "node:fs/promises";
import { PhraseBank, QwenTts } from "../packages/voice/src/index.js";

const BASE = process.env.VOICE_CLONE_DIR ?? "/Users/edisonrodriguez/Documents/Clonar-voz";
const BANK_DIR = process.env.VOICE_TTS_PHRASE_BANK ?? "/Users/edisonrodriguez/Documents/jarvis-main/.voice-bank";

/** Frases que JARVIS dice una y otra vez: saludos, confirmaciones, avisos. */
const FRASES_POR_DEFECTO = [
  "Buenos días.",
  "Buenas tardes.",
  "Buenas noches.",
  "Estoy listo. ¿En qué puedo ayudarte?",
  "Entendido.",
  "Entendido, voy a comprobarlo.",
  "Hecho.",
  "Perfecto.",
  "Claro.",
  "Un momento, por favor.",
  "Un segundo.",
  "Eso es todo.",
  "Nada más, por ahora.",
  "He comprobado que todo está en orden.",
  "Lo he revisado y no hay ningún problema.",
  "No he podido completarlo.",
  "No he podido obtener ese dato.",
  "Necesito confirmación para continuar.",
  "Voy a buscarlo.",
  "Te lo resumo:",
  "En resumen,",
  "Lo importante es esto:",
  "Dime y lo hago.",
  "¿Qué hacemos ahora?",
  "Cuidado con eso.",
  "Aviso: no he podido verificarlo.",
];

async function main(): Promise<void> {
  const argumentos = process.argv.slice(2);
  const indiceFichero = argumentos.indexOf("--frases");
  const frases =
    indiceFichero >= 0 && argumentos[indiceFichero + 1]
      ? (await readFile(argumentos[indiceFichero + 1] as string, "utf8"))
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : FRASES_POR_DEFECTO;

  const binario = process.env.VOICE_TTS_QWEN_BINARY ?? `${BASE}/llama-bin/llama-tts`;
  const modelo = process.env.VOICE_TTS_QWEN_MODEL ?? `${BASE}/modelo/Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf`;
  const mmproj = process.env.VOICE_TTS_QWEN_MMPROJ ?? `${BASE}/modelo/mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf`;
  const referencia =
    process.env.VOICE_TTS_QWEN_REFERENCE ?? `${BASE}/voces/ec21efcc8f05/referencia.wav`;

  const motor = new QwenTts({ binary: binario, model: modelo, mmproj: mmproj, reference: referencia });
  const estado = await motor.available();
  if (!estado.ok) {
    console.error(`✗ el motor de voz clonada no está listo: ${estado.reason}`);
    process.exit(1);
  }

  const banco = new PhraseBank({ directory: BANK_DIR });
  await banco.load();
  console.log(`Banco: ${BANK_DIR} (${banco.size} frases ya grabadas)`);
  console.log(`Voz: ${motor.describe?.().voice}\n`);

  const inicio = Date.now();
  let grabadas = 0;
  for (const [indice, frase] of frases.entries()) {
    const clave = frase.toLowerCase().trim();
    const yaEsta = await banco.find(frase);
    if (yaEsta && yaEsta.entry.key === clave) {
      console.log(`  [${indice + 1}/${frases.length}] ya está: "${frase}"`);
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`  [${indice + 1}/${frases.length}] grabando: "${frase}" ... `);
    try {
      const entrada = await banco.render(frase, motor);
      grabadas += 1;
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s, ${(entrada.durationMs / 1000).toFixed(1)} s de audio)`);
    } catch (error) {
      console.log(`FALLÓ: ${(error as Error).message}`);
    }
  }

  console.log(`\nListo: ${grabadas} frases nuevas en ${((Date.now() - inicio) / 60000).toFixed(1)} min. Banco: ${banco.size} frases.`);
  console.log("Para usarlo: VOICE_TTS_ENGINE=bank y VOICE_TTS_PHRASE_BANK=" + BANK_DIR);
}

void main();
