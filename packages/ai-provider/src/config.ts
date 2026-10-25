import { z } from "zod";
import { OpenRouterConfigSchema, loadOpenRouterConfig, type OpenRouterConfig, type OpenRouterEnv } from "./openrouter-provider.js";

export const NvidiaConfigSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  model: z.string().min(1),
  visionModel: z.string().min(1),
  embeddingModel: z.string().min(1),
  timeoutMs: z.coerce.number().int().positive().default(60_000),
  maxTokens: z.coerce.number().int().positive().default(2048),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  streaming: z.enum(["auto", "openai", "disabled"]).default("auto"),
  maxRetries: z.coerce.number().int().min(0).max(3).default(1),
});
export type NvidiaConfig = z.infer<typeof NvidiaConfigSchema>;

/**
 * Configuración sellada e inmutable del entorno de ejecución.
 *
 * `EnvConfig` es el ÚNICO objeto que el resto del código debe consumir: nadie
 * lee `process.env` directamente fuera de este módulo. Eso hace auditable
 * qué variables existen, cuáles son obligatorias y cuáles son opcionales, y
 * evita que un secreto acabe en un log, en un script de diagnóstico o en el
 * bundle del navegador.
 */
export const EnvConfigSchema = z.object({
  nvidia: NvidiaConfigSchema,
  /** `null` cuando OpenRouter no está configurado: no es un error. */
  openrouter: OpenRouterConfigSchema.nullable().default(null),
});

export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/**
 * Error de configuración con un mensaje controlado.
 *
 * El mensaje NUNCA incluye el valor de la variable que falta ni un volcado del
 * entorno: solo dice qué falta y cómo arreglarlo.
 */
export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

export interface NvidiaEnv {
  NVIDIA_API_KEY?: string;
  NVIDIA_BASE_URL?: string;
  NVIDIA_MODEL?: string;
  NVIDIA_VISION_MODEL?: string;
  NVIDIA_EMBEDDING_MODEL?: string;
  NVIDIA_TIMEOUT_MS?: string;
  NVIDIA_MAX_TOKENS?: string;
  NVIDIA_TEMPERATURE?: string;
  NVIDIA_STREAMING?: string;
  NVIDIA_MAX_RETRIES?: string;
}

/** Throws a descriptive error when required configuration is missing. */
export function loadNvidiaConfig(env: NvidiaEnv = process.env as NvidiaEnv): NvidiaConfig {
  const apiKey = env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is not set. JARVIS cannot reach NVIDIA NIM without it. Copy .env.example to .env and set the key.",
    );
  }
  return NvidiaConfigSchema.parse({
    apiKey,
    baseUrl: env.NVIDIA_BASE_URL,
    model: env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b",
    visionModel: env.NVIDIA_VISION_MODEL ?? "nvidia/nemotron-3.5-super-vl-120b-a12b",
    embeddingModel: env.NVIDIA_EMBEDDING_MODEL ?? "nvidia/nemotron-3-embed-1b",
    timeoutMs: env.NVIDIA_TIMEOUT_MS,
    maxTokens: env.NVIDIA_MAX_TOKENS,
    temperature: env.NVIDIA_TEMPERATURE,
    streaming: env.NVIDIA_STREAMING,
    maxRetries: env.NVIDIA_MAX_RETRIES,
  });
}

/**
 * ¿Hay credenciales de NIM en el entorno?
 *
 * Lo usan los scripts y los tests de integración para decidir si pueden
 * ejecutarse. Es la ÚNICA forma admitida de preguntar por la clave: leer
 * `process.env.NVIDIA_API_KEY` a mano rompe la trazabilidad de los secretos.
 */
export function hasNvidiaApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NVIDIA_API_KEY?.trim());
}

/**
 * Carga y valida TODA la configuración de entorno en un único punto.
 *
 * Contrato:
 *  · Falla con `EnvConfigError` (código de salida 1) si falta una variable
 *    obligatoria. El mensaje nombra la variable pero nunca su valor.
 *  · Devuelve un objeto CONGELADO: nadie puede mutar la configuración en
 *    caliente ni añadir propiedades a un objeto que ya se ha validado.
 *  · Es la única puerta de entrada al entorno para el resto del paquete.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const apiKey = env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new EnvConfigError(
      "NVIDIA_API_KEY is not set. JARVIS cannot reach NVIDIA NIM without it. Copy .env.example to .env and set the key.",
    );
  }
  const nvidia = NvidiaConfigSchema.parse({
    apiKey,
    baseUrl: env.NVIDIA_BASE_URL,
    model: env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-lightning-30b-a3b",
    visionModel: env.NVIDIA_VISION_MODEL ?? "nvidia/nemotron-3.5-super-vl-120b-a12b",
    embeddingModel: env.NVIDIA_EMBEDDING_MODEL ?? "nvidia/nemotron-3-embed-1b",
    timeoutMs: env.NVIDIA_TIMEOUT_MS,
    maxTokens: env.NVIDIA_MAX_TOKENS,
    temperature: env.NVIDIA_TEMPERATURE,
    streaming: env.NVIDIA_STREAMING,
    maxRetries: env.NVIDIA_MAX_RETRIES,
  });
  const openrouter = loadOpenRouterConfig(env as OpenRouterEnv);
  const parsed = EnvConfigSchema.parse({ nvidia, openrouter });
  return deepFreeze(parsed);
}

/** Congela el objeto y todas sus estructuras anidadas. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
