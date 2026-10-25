/* eslint-disable no-console */
import { loadConfig } from "../src/config.js";
import { NvidiaNimProvider } from "../src/nim-provider.js";

/**
 * Live capability probe. Only run with a real NVIDIA_API_KEY:
 *   pnpm --filter @jarvis/ai-provider probe
 *
 * El script NO lee `process.env`: consume la configuración ya validada y
 * sellada por `loadConfig()`. Si falta una variable obligatoria, el proceso
 * aborta con código de salida 1 y un mensaje controlado que no revela ningún
 * secreto.
 */
async function main() {
  const config = loadConfig();
  const provider = new NvidiaNimProvider(config.nvidia);
  console.log("chat model:   ", provider.models.chat);
  console.log("vision model: ", provider.models.vision);
  const health = await provider.health();
  console.log("health:", health.ok ? "UP" : "DOWN", "-", health.detail, `(${health.latencyMs}ms)`);
  if (!health.ok) process.exitCode = 1;
  const capabilities = await provider.probeCapabilities();
  console.log("capabilities:", JSON.stringify(capabilities, null, 2));
  if (!capabilities.streaming || !capabilities.tools) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
