import { z } from "zod";
import { RISK_LEVELS } from "@jarvis/shared";

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(8787),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  allowedOrigins: z.array(z.string()).default(["http://localhost:5173", "http://127.0.0.1:5173"]),
  accessToken: z.string().min(8).optional(),
  users: z.array(z.string().min(1)).default(["local"]),
  persistence: z.enum(["postgres", "memory"]).default("postgres"),
  databaseUrl: z.string().optional(),
  memoryRetentionDays: z.coerce.number().int().min(0).default(0),
  documentsRoots: z.array(z.string()).default([]),
  webSearch: z
    .object({
      provider: z.enum(["brave", "tavily", "endless", "federated"]).optional(),
      apiKey: z.string().optional(),
      endlessBaseUrl: z.string().optional(),
      endlessApiKey: z.string().optional(),
      engines: z.array(z.string()).default([]),
    })
    .superRefine((value, ctx) => {
      // Brave y Tavily exigen credencial: sin ella la búsqueda no puede
      // funcionar y es mejor fallar al arrancar que descubrirlo en un turno.
      // `endless` (SearXNG) puede operar sin clave en instancias públicas.
      if (value.provider && value.provider !== "endless" && value.provider !== "federated" && !value.apiKey?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKey"],
          message: "WEB_SEARCH_API_KEY es obligatoria si WEB_SEARCH_PROVIDER es brave o tavily",
        });
      }
    })
    .default({}),
  voiceStt: z.string().default("browser"),
  voiceTts: z.string().default("browser"),
  perceptionEnabled: z.coerce.boolean().default(true),
  perceptionMaxBytes: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  probeCapabilitiesOnBoot: z.coerce.boolean().default(false),
  maxTurnDurationMs: z.coerce.number().int().positive().default(120_000),
  approvalTimeoutMs: z.coerce.number().int().positive().default(120_000),
  httpsCert: z.string().optional(),
  httpsKey: z.string().optional(),
  sandboxImages: z.record(z.string()).default({}),
  workspaceRoot: z.string().default(""),
  shellAllowlist: z.array(z.string()).default([]),
  computerUseDriver: z.string().default(""),
  healthWatchIntervalMs: z.coerce.number().int().min(2000).default(20_000),
  ttsCacheDir: z.string().default(""),
  voiceFastTurns: z.coerce.boolean().default(true),
  /**
   * Motor de síntesis: "say" (voces del sistema), "kokoro" (voz masculina
   * neuronal en local), "qwen" (voz clonada) o "bank" (banco de frases
   * pregrabadas con la voz clonada).
   */
  ttsEngine: z.enum(["say", "kokoro", "qwen", "bank"]).default("kokoro"),
  /** Voz a usar con macOS‑say (debe estar instalada). */
  ttsSayVoice: z.string().default("Jorge"),
  /** URL del servidor de voz Kokoro. */
  ttsKokoroUrl: z.string().default("http://127.0.0.1:8788"),
  /** Voz de Kokoro: em_alex (hombre, es), em_santa (hombre, es), ef_dora (mujer). */
  ttsKokoroVoice: z.string().default("em_alex"),
  /**
   * Tamaño máximo de una frase que se sintetiza de una vez. Importa con los
   * motores lentos: cada fragmento tarda lo que dura su audio, así que un
   * fragmento de 9 s son 9 s hasta que se oye la siguiente frase.
   * Valores bajos (≈160) reducen la latencia de la primera frase.
   */
  ttsMaxSentenceChars: z.coerce.number().int().nonnegative().default(160),
  /** Límite de caracteres pendientes antes de forzar corte de frase.
   * Valores bajos (≈80) evitan esperas largas en enumeraciones sin puntos. */
  ttsMaxPendingChars: z.coerce.number().int().nonnegative().default(80),
  /** Máximo de síntesis concurrentes en el streamer (default 4). */
  ttsMaxConcurrent: z.coerce.number().int().positive().default(4),
  /** Rutas del motor Qwen3-TTS (voz clonada). */
  ttsQwenBinary: z.string().default(""),
  ttsQwenModel: z.string().default(""),
  ttsQwenMmproj: z.string().default(""),
  /** WAV de referencia con la voz clonada. */
  ttsQwenReference: z.string().default(""),
  /** "auto" | "cpu" | id del dispositivo de llama.cpp. */
  ttsQwenDevice: z.string().default("auto"),
  /** Directorio del banco de frases pregrabadas. */
  ttsPhraseBankDir: z.string().default(""),
  // Encendido por defecto: el dueño lo pidió así ("con confirmación siempre",
  // que es lo que exige `requiresApproval` en la tool). Apagarlo es una
  // decisión deliberada suya, no un olvido.
  enableComputerUse: z.coerce.boolean().default(true),
  voiceAsrModel: z.string().default("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"),
  voiceAsrEnabled: z.coerce.boolean().default(true),
  voiceAsrSampleRate: z.coerce.number().int().min(8000).max(48000).default(16000),
  voiceAsrLanguage: z.string().default("es"),
  /** URL del servicio de ASR. Vacío = la misma de NVIDIA. */
  voiceAsrBaseUrl: z.string().default(""),
  /**
   * Credencial de NVIDIA NIM. Vive en el esquema centralizado (y no leído a
   * mano con `process.env`) para que exista un único sitio donde se declara
   * una credencial: se puede auditar, validar y revocar.
   */
  nvidiaApiKey: z.string().default(""),
  /** URL base de la API de NVIDIA. */
  nvidiaBaseUrl: z.string().default("https://integrate.api.nvidia.com/v1"),
  /**
   * Catálogo completo de herramientas en cada turno. Con "false" se poda por
   * intención (más rápido) y JARVIS puede quedarse sin herramientas y
   * declararlo. El dueño pidió el catálogo completo: que no se excuse.
   */
  toolsFullCatalog: z.coerce.boolean().default(false),
  /**
   * Ejecuta sin pedir confirmación. Las acciones quedan auditadas igual.
   */
  toolsAutoApprove: z.coerce.boolean().default(true),
  /**
   * Niveles de riesgo que la auto-aprobación puede cubrir.
   *
   * Por defecto SOLO se auto-aprueban las lecturas públicas y las acciones
   * locales reversibles. `external_effect` (escribir fuera, enviar, ejecutar
   * en el host) y `destructive` (borrar, olvidar) exigen confirmación humana
   * explícita: son las que modifican el mundo.
   *
   * Para restaurar el comportamiento anterior (auto-aprobar todo):
   * `JARVIS_TOOLS_AUTO_APPROVE_RISKS=public_read,local_reversible,external_effect,destructive`.
   */
  toolsAutoApproveRisks: z.array(z.enum(RISK_LEVELS)).default(["public_read", "local_reversible"]),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function listEnv(value: string | undefined, fallback: string[] = []): string[] {
  if (value == null || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const persistence = env.PERSISTENCE === "memory" ? "memory" : env.PERSISTENCE === "postgres" ? "postgres" : undefined;
  return ConfigSchema.parse({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    allowedOrigins: listEnv(env.ALLOWED_ORIGINS, ["http://localhost:5173", "http://127.0.0.1:5173"]),
    accessToken: env.JARVIS_ACCESS_TOKEN?.trim() || undefined,
    users: listEnv(env.JARVIS_USERS, ["local"]),
    persistence,
    databaseUrl: env.DATABASE_URL,
    memoryRetentionDays: env.MEMORY_RETENTION_DAYS,
    documentsRoots: listEnv(env.DOCUMENTS_ROOT),
    webSearch: {
      provider:
        env.WEB_SEARCH_PROVIDER === "brave" ||
        env.WEB_SEARCH_PROVIDER === "tavily" ||
        env.WEB_SEARCH_PROVIDER === "endless" ||
        env.WEB_SEARCH_PROVIDER === "federated"
          ? env.WEB_SEARCH_PROVIDER
          : undefined,
      apiKey: env.WEB_SEARCH_API_KEY?.trim() || undefined,
      endlessBaseUrl: env.ENDLESS_BASE_URL?.trim() || "https://api.endless.sbs",
      endlessApiKey: env.ENDLESS_API_KEY?.trim() || undefined,
      engines: (env.WEB_SEARCH_ENGINES ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    voiceStt: env.VOICE_STT_PROVIDER,
    voiceTts: env.VOICE_TTS_PROVIDER,
    perceptionEnabled: env.PERCEPTION_ENABLED,
    perceptionMaxBytes: env.PERCEPTION_MAX_BYTES,
    probeCapabilitiesOnBoot: env.NVIDIA_PROBE_ON_BOOT,
    maxTurnDurationMs: env.JARVIS_MAX_TURN_MS,
    approvalTimeoutMs: env.JARVIS_APPROVAL_TIMEOUT_MS,
    httpsCert: env.JARVIS_HTTPS_CERT?.trim() || undefined,
    httpsKey: env.JARVIS_HTTPS_KEY?.trim() || undefined,
    workspaceRoot: env.JARVIS_WORKSPACE_ROOT?.trim() || "",
    shellAllowlist: (env.JARVIS_SHELL_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    computerUseDriver: env.JARVIS_COMPUTER_USE_DRIVER?.trim() || "",
    healthWatchIntervalMs: env.JARVIS_HEALTH_WATCH_MS,
    ttsCacheDir: env.VOICE_TTS_CACHE_DIR,
    voiceFastTurns: env.VOICE_FAST_TURNS,
    ttsEngine: env.VOICE_TTS_ENGINE,
    ttsSayVoice: env.VOICE_TTS_SAY_VOICE?.trim() || "Jorge",
    ttsKokoroUrl: env.VOICE_TTS_KOKORO_URL?.trim() || "http://127.0.0.1:8788",
    ttsKokoroVoice: env.VOICE_TTS_KOKORO_VOICE?.trim() || "em_alex",
    ttsMaxSentenceChars: env.VOICE_TTS_MAX_SENTENCE_CHARS,
    ttsMaxPendingChars: env.VOICE_TTS_MAX_PENDING_CHARS,
    ttsMaxConcurrent: env.VOICE_TTS_MAX_CONCURRENT,
    ttsQwenBinary: env.VOICE_TTS_QWEN_BINARY?.trim() || "",
    ttsQwenModel: env.VOICE_TTS_QWEN_MODEL?.trim() || "",
    ttsQwenMmproj: env.VOICE_TTS_QWEN_MMPROJ?.trim() || "",
    ttsQwenReference: env.VOICE_TTS_QWEN_REFERENCE?.trim() || "",
    ttsQwenDevice: env.VOICE_TTS_QWEN_DEVICE?.trim() || "auto",
    ttsPhraseBankDir: env.VOICE_TTS_PHRASE_BANK?.trim() || "",
    enableComputerUse: env.JARVIS_ENABLE_COMPUTER_USE,
    voiceAsrModel: env.VOICE_ASR_MODEL,
    voiceAsrEnabled: env.VOICE_ASR_ENABLED,
    voiceAsrSampleRate: env.VOICE_ASR_SAMPLE_RATE,
    voiceAsrLanguage: env.VOICE_ASR_LANGUAGE,
    voiceAsrBaseUrl: env.VOICE_ASR_BASE_URL,
    nvidiaApiKey: env.NVIDIA_API_KEY?.trim() ?? "",
    nvidiaBaseUrl: env.NVIDIA_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1",
    toolsFullCatalog: env.JARVIS_TOOLS_FULL_CATALOG,
    toolsAutoApprove: env.JARVIS_TOOLS_AUTO_APPROVE,
    toolsAutoApproveRisks: listEnv(env.JARVIS_TOOLS_AUTO_APPROVE_RISKS, ["public_read", "local_reversible"]).filter(
      (risk): risk is (typeof RISK_LEVELS)[number] => (RISK_LEVELS as readonly string[]).includes(risk),
    ),
    sandboxImages: Object.fromEntries(
      Object.entries({
        python: env.JARVIS_SANDBOX_IMAGE_PYTHON,
        nodejs: env.JARVIS_SANDBOX_IMAGE_NODEJS,
        cpp: env.JARVIS_SANDBOX_IMAGE_CPP,
        rust: env.JARVIS_SANDBOX_IMAGE_RUST,
        go: env.JARVIS_SANDBOX_IMAGE_GO,
      }).filter(([, value]) => Boolean(value && value.trim())),
    ),
  });
}
