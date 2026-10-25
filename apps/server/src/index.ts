import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "@jarvis/shared";
import {
  VoiceInterruptRequestSchema,
  VoiceInterruptAckSchema,
  VoiceSpeakingStartedSchema,
  VoiceAudioSegmentSchema,
  VoiceOutputStoppedSchema,
} from "@jarvis/shared";
import {
  NvidiaAsrProvider,
  NvidiaNimProvider,
  OpenRouterProvider,
  ResilientAIRouter,
  UnavailableProvider,
  loadNvidiaConfig,
  loadOpenRouterConfig,
  type AiProvider,
  type AsrProvider,
  type StreamingAsrProvider,
  createStreamingAsrProvider,
} from "@jarvis/ai-provider";
import { MemoryService, createStore, type Store } from "@jarvis/memory";
import { createToolRegistry, warmupSandboxImages, type ToolRegistry } from "@jarvis/tool-registry";
import { AgentRuntime } from "@jarvis/agent-runtime";
import { KokoroTts, MacSayTts, PhraseBank, PhraseBankEngine, QwenTts, SentenceStreamer, VoiceService, type TtsEngine } from "@jarvis/voice";
import { PerceptionService } from "@jarvis/perception";
import { buildApp } from "./app.js";
import { loadAppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { EventHub } from "./hub.js";
import { HealthRegistry } from "./health.js";
import { getTracer, VoiceSpanNames, VoiceAttributes, VoiceMetricNames, recordVoiceHistogram, startVoiceSpan, addVoiceEvent } from "@jarvis/shared";

/** Periodicidad del barrido de retención de memoria (6 horas). */
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const log = createLogger(config);
  log.info({ nodeEnv: config.nodeEnv, persistence: config.persistence }, "JARVIS server starting");

  const { store, persisted } = await openStore(config, log);

  const metrics = new Metrics();
  const { provider, providerNote } = createProvider(log, metrics);
  const memory = new MemoryService({
    store,
    embedder: provider instanceof UnavailableProvider ? undefined : provider,
    retentionDays: config.memoryRetentionDays,
  });
  const registry = createToolRegistry({
    memory,
    config: {
      documentsRoots: config.documentsRoots,
      webSearch: config.webSearch,
      maxResultBytes: 256 * 1024,
      sandboxImages: config.sandboxImages,
      workspaceRoot: config.workspaceRoot || undefined,
      shellAllowlist: config.shellAllowlist.length > 0 ? config.shellAllowlist : undefined,
      computerUseDriver: config.computerUseDriver || undefined,
      enableComputerUse: config.enableComputerUse,
    },
  });
  // El sondeo de las imágenes de sandbox es asíncrono y NO bloquea el event
  // loop. Se resuelve ANTES de aceptar tráfico: desde el primer turno, el
  // catálogo que ve el modelo refleja lo que de verdad se puede ejecutar.
  await warmupSandboxImages({
    documentsRoots: config.documentsRoots,
    webSearch: config.webSearch,
    maxResultBytes: 256 * 1024,
    sandboxImages: config.sandboxImages,
  });
  const voice = new VoiceService({ sttProvider: config.voiceStt, ttsProvider: config.voiceTts });
  // Validación temprana de STT
  if (config.voiceStt !== "browser" && !config.voiceAsrEnabled) {
    log.warn({ voiceStt: config.voiceStt, voiceAsrEnabled: config.voiceAsrEnabled }, "STT configurado para servidor pero ASR no está habilitado; el reconocimiento de voz no funcionará");
  }
  const visionModel = (provider as AiProvider & { models?: { vision?: string } }).models?.vision ?? "nvidia/nemotron-3.5-super-vl-120b-a12b";
  const perception = new PerceptionService(provider, {
    visionModel,
    maxBytes: config.perceptionMaxBytes,
    enabled: config.perceptionEnabled,
  });
  const hub = new EventHub(log);

  // Motor de síntesis del servidor. Hay tres:
  //  · "say"  → las voces del sistema (rápido, pero no es tu voz).
  //  · "qwen" → la voz clonada (Qwen3-TTS): muy lenta en CPU.
  //  · "bank" → la voz clonada, pero servida desde un banco de frases
  //             pregrabadas: latencia cero en las frases que están.
  const tts: TtsEngine = await buildTtsEngine(config, log);
  const ttsStatus = await tts.available();
  if (ttsStatus.ok) {
    const voice = tts.describe?.();
    log.info({ engine: tts.name, voice: voice?.voice, realistic: voice?.realistic }, "síntesis de voz en el servidor disponible");
    if (voice && !voice.realistic) log.warn({ voice: voice.voice }, voice.hint);
  } else {
    log.warn({ reason: ttsStatus.reason }, "síntesis de voz en el servidor no disponible: se usará la del navegador");
  }

  // Un sintetizador en streaming por sesión: acumula el texto que llega y
  // sintetiza cada frase en cuanto se cierra, sin esperar a la respuesta
  // completa.
  const streamers = new Map<string, SentenceStreamer>();
  /** Momento en que empieza cada locución: permite medir el TTFA real. */
  const speechStartedAt = new Map<string, number>();
  const streamerFor = (sessionId: string): SentenceStreamer => {
    let streamer = streamers.get(sessionId);
    if (!streamer) {
      streamer = new SentenceStreamer({
        tts,
        maxSentenceChars: config.ttsMaxSentenceChars || undefined,
        maxPendingChars: config.ttsMaxPendingChars || undefined,
        maxConcurrent: config.ttsMaxConcurrent || undefined,
        onSegment: (segment) => {
          const startedAt = speechStartedAt.get(sessionId);
          if (startedAt !== undefined) {
            metrics.observe("voice.ttfa", Date.now() - startedAt);
            speechStartedAt.delete(sessionId);
          }
          hub.send(sessionId, {
            type: "voice.audio.segment",
            sessionId,
            taskId: segment.generationId,
            ts: new Date().toISOString(),
            generationId: segment.generationId,
            index: segment.index,
            text: segment.text,
            audio: segment.audio.toString("base64"),
            mimeType: segment.mimeType,
            sampleRate: segment.sampleRate,
            durationMs: segment.durationMs,
            serverEpoch: segment.serverEpoch,
          } as ServerEvent);
        },
        onEnd: (generationId) => {
          hub.send(sessionId, {
            type: "voice.audio.end",
            sessionId,
            ts: new Date().toISOString(),
            generationId,
          } as ServerEvent);
        },
        onError: (error) => log.warn({ err: error.message }, "fallo de síntesis: se delega en la voz del navegador"),
      });
      streamers.set(sessionId, streamer);
    }
    return streamer;
  };

  const emit = (event: ServerEvent): void => {
    if (event.type === "tool.completed") metrics.observe("tool.duration", event.durationMs);
    if (event.type === "assistant.message_completed") metrics.increment("assistant.messages");
    if (event.type === "tool.failed") metrics.increment("tool.failures");
    if (event.type === "agent.error") metrics.increment("agent.errors");

    // Extraer sessionId temprano para evitar problemas de narrowing
    const sessionId = "sessionId" in event ? event.sessionId : "";
    const generationId = "generationId" in event ? event.generationId : "";
    const epoch = "serverEpoch" in event ? event.serverEpoch : 0;

    // Telemetry spans para eventos de voz
    const tracer = getTracer();
    if (tracer && sessionId) {
      if (event.type === "voice.speaking.started") {
        const span = startVoiceSpan(VoiceSpanNames.TTS_STREAM, {
          [VoiceAttributes.SESSION_ID]: sessionId,
          [VoiceAttributes.GENERATION_ID]: generationId,
          [VoiceAttributes.EPOCH]: epoch,
          [VoiceAttributes.SERVER_AUDIO]: event.serverAudio ?? false,
        });
        span?.end();
      } else if (event.type === "assistant.delta") {
        // LLM first token
        if (!("llmFirstTokenSent" in emit)) {
          (emit as typeof emit & { llmFirstTokenSent: boolean }).llmFirstTokenSent = true;
          recordVoiceHistogram(VoiceMetricNames.LLM_FIRST_TOKEN, 0, {
            [VoiceAttributes.SESSION_ID]: sessionId,
            [VoiceAttributes.GENERATION_ID]: generationId ?? "",
          });
        }
        recordVoiceHistogram(VoiceMetricNames.LLM_STREAM_CHUNK, 0, {
          [VoiceAttributes.SESSION_ID]: sessionId,
          [VoiceAttributes.GENERATION_ID]: generationId ?? "",
          [VoiceAttributes.TEXT_LENGTH]: event.text.length,
        });
      } else if (event.type === "voice.output_stopped" && event.reason === "interrupted") {
        recordVoiceHistogram(VoiceMetricNames.INTERRUPT_LATENCY, 0, {
          [VoiceAttributes.SESSION_ID]: sessionId,
          [VoiceAttributes.GENERATION_ID]: generationId ?? "",
          [VoiceAttributes.INTERRUPT_REASON]: "user",
        });
      } else if (event.type === "voice.audio.segment") {
        recordVoiceHistogram(VoiceMetricNames.NETWORK_SEND, 0, {
          [VoiceAttributes.SESSION_ID]: sessionId,
          [VoiceAttributes.GENERATION_ID]: generationId ?? "",
          [VoiceAttributes.EPOCH]: epoch,
          [VoiceAttributes.AUDIO_DURATION_MS]: event.durationMs,
        });
      }
    }

    // El texto que llega alimenta la síntesis por frases.
    if (event.type === "voice.speaking.started") {
      const ev = event as { sessionId: string; generationId: string; taskId?: string; serverAudio?: boolean; ts: string };
      const streamer = streamerFor(ev.sessionId);
      streamer.start(ev.generationId);
      speechStartedAt.set(ev.sessionId, Date.now());
      const currentEpoch = streamer.getCurrentEpoch();
      // Se informa al cliente de si el audio vendrá del servidor o no.
      const speakingStarted = VoiceSpeakingStartedSchema.parse({
        ...event,
        serverAudio: ttsStatus.ok,
        serverEpoch: currentEpoch,
      });
      hub.send(ev.sessionId, speakingStarted as unknown as ServerEvent);
      return;
    }
    if (event.type === "assistant.delta") {
      streamerFor(event.sessionId).push(event.text);
      hub.send(event.sessionId, event);
      return;
    }
    if (event.type === "assistant.message_completed") {
      streamerFor(event.sessionId).flush();
      hub.send(event.sessionId, event);
      return;
    }
    if (event.type === "voice.output_stopped" && event.reason === "interrupted") {
      const ev = event as { sessionId: string; generationId: string; taskId?: string; reason: string; ts: string };
      const streamer = streamers.get(ev.sessionId);
      if (streamer) {
        const stoppedEpoch = streamer.getCurrentEpoch();
        streamer.stop();
        // Emitir output_stopped con la época confirmada
        const outputStopped = VoiceOutputStoppedSchema.parse({
          ...event,
          serverEpoch: stoppedEpoch,
        });
        hub.send(ev.sessionId, outputStopped as unknown as ServerEvent);
      }
      return;
    }
    hub.send(sessionId, event);
  };

  const runtime = new AgentRuntime({
    provider,
    registry,
    memory,
    emit,
    log: (level, message, meta) => log[level](meta ?? {}, message),
    limits: { maxDurationMs: config.maxTurnDurationMs },
    approvalTimeoutMs: config.approvalTimeoutMs,
    fullCatalog: config.toolsFullCatalog,
    autoApprove: config.toolsAutoApprove,
    // Solo lo inocuo se auto-aprueba: lo que toca el mundo (o lo destruye)
    // exige confirmación humana explícita.
    autoApprovableRisks: config.toolsAutoApproveRisks,
  });
  const health = new HealthRegistry({
    provider,
    store,
    memory,
    registry,
    voice,
    perception,
    log,
    runtimeActiveTasks: () => runtime.activeTaskCount(),
    runtimeHealth: () => runtime.health(),
  });

  // ASR del servidor: recognition de voz en el servidor. Si el modelo no está
  // habilitado en la cuenta, se declara y el cliente usa el del navegador.
  let asr: AsrProvider | undefined;
  let streamingAsr: StreamingAsrProvider | undefined;
  if (config.voiceAsrEnabled) {
    const candidate = new NvidiaAsrProvider({
      baseUrl: config.voiceAsrBaseUrl || config.nvidiaBaseUrl,
      apiKey: config.nvidiaApiKey,
      model: config.voiceAsrModel,
      language: config.voiceAsrLanguage,
      timeoutMs: 30_000,
      aliases: [
        "nvidia/parakeet-tdt-0.6b",
        "nvidia/parakeet-ctc-0.6b-es",
        "nvidia/parakeet-ctc-0.6b-asr",
        "nvidia/parakeet-1.1b-rnnt-multilingual-asr",
        "nvidia/nemotron-asr-streaming",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      ],
    });
    const asrStatus = await candidate.available();
    if (asrStatus.ok) {
      asr = candidate;
      log.info({ model: config.voiceAsrModel }, "ASR del servidor disponible");
    } else {
      log.warn({ model: config.voiceAsrModel, reason: asrStatus.reason }, "ASR del servidor no disponible: se usará el del navegador");
    }

    // Intentar inicializar ASR streaming si el modelo lo soporta
    const streamingMode = (await import("@jarvis/ai-provider")).asrModeFor(config.voiceAsrModel);
    if (streamingMode === "stream") {
      try {
        const streamingCandidate = createStreamingAsrProvider({
          baseUrl: config.voiceAsrBaseUrl || config.nvidiaBaseUrl,
          apiKey: config.nvidiaApiKey,
          model: config.voiceAsrModel,
          language: config.voiceAsrLanguage,
          sampleRate: config.voiceAsrSampleRate,
        });
        let streamingStatus: { ok: boolean; reason?: string };
        try {
          await streamingCandidate.connect();
          streamingStatus = { ok: true };
        } catch (err) {
          streamingStatus = { ok: false, reason: (err as Error).message };
        }
        if (streamingStatus.ok) {
          streamingAsr = streamingCandidate;
          log.info({ model: config.voiceAsrModel }, "ASR streaming del servidor disponible");
        } else {
          log.warn({ model: config.voiceAsrModel, reason: streamingStatus.reason }, "ASR streaming no disponible");
          streamingCandidate.disconnect();
        }
      } catch (error) {
        log.warn({ err: (error as Error).message }, "Error inicializando ASR streaming");
      }
    }
  }

  const app = await buildApp({
    config,
    log,
    provider,
    store,
    memory,
    registry,
    runtime,
    voice,
    perception,
    metrics,
    health,
    hub,
    emit,
    handleInterrupt: (sessionId: string, _clientGeneration: number, serverEpoch: number) => {
      const streamer = streamers.get(sessionId);
      if (streamer) {
        const currentEpoch = streamer.getCurrentEpoch();
        streamer.stop();
        return {
          confirmedEpoch: currentEpoch,
          newServerEpoch: currentEpoch + 1,
          flushedBytes: 0, // TODO: track actual flushed bytes
        };
      }
      return {
        confirmedEpoch: serverEpoch,
        newServerEpoch: serverEpoch + 1,
        flushedBytes: 0,
      };
    },
    asr,
    streamingAsr,
    streamers,
    asrSampleRate: config.voiceAsrSampleRate,
  });

  if (config.memoryRetentionDays > 0) {
    const purged = await memory.purgeExpired();
    log.info({ purged, retentionDays: config.memoryRetentionDays }, "retention purge complete");
  }

  await app.listen({ host: config.host, port: config.port, ...httpsOptions(config) });

  const report = await health.check();
  const https = Object.keys(httpsOptions(config)).length > 0;
  log.info(
    {
      status: report.status,
      components: report.components.map((component) => `${component.component}=${component.status}`),
      provider: providerNote,
      persisted,
      toolsAvailable: registry.available().map((tool) => tool.name),
      toolsUnavailable: registry
        .list()
        .filter((tool) => !tool.availability().available)
        .map((tool) => `${tool.name}(${tool.availability().reason ?? "n/a"})`),
      url: `${https ? "https" : "http"}://${config.host}:${config.port}`,
    },
    "JARVIS ready",
  );

  if (config.probeCapabilitiesOnBoot && provider instanceof NvidiaNimProvider) {
    const capabilities = await provider.probeCapabilities();
    log.info({ capabilities }, "live capability probe");
  }

  // Vigilante de salud: emite los cambios de estado en vivo por el websocket.
  // La reposición del proveedor primario la decide el enrutador (circuito):
  // sondea al primario cuando toca y lo vuelve a promover si responde.
  const healthWatcher = setInterval(() => {
    void health
      .checkAndEmit((change) => hub.broadcast(change as unknown as ServerEvent))
      .catch((error) => log.warn({ err: (error as Error).message }, "health watcher failed"));
  }, config.healthWatchIntervalMs);

  // Retención: purgar sólo al arrancar dejaba la memoria creciendo hasta el
  // siguiente reinicio del servidor. El barrido es periódico y no retiene el
  // proceso (`unref`): es mantenimiento, no parte del servicio.
  const retentionSweep =
    config.memoryRetentionDays > 0
      ? setInterval(() => {
          void memory
            .purgeExpired()
            .then((purged) => {
              if (purged > 0) log.info({ purged, retentionDays: config.memoryRetentionDays }, "retention purge complete");
            })
            .catch((error) => log.warn({ err: (error as Error).message }, "retention purge failed"));
        }, RETENTION_SWEEP_INTERVAL_MS)
      : undefined;
  retentionSweep?.unref();

  const shutdown = async (signal: string) => {
    clearInterval(healthWatcher);
    if (retentionSweep) clearInterval(retentionSweep);
    log.info({ signal }, "shutting down");
    await app.close().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * HTTPS opcional (ver `pnpm dev:https`). Sin certificado, el servidor escucha
 * en HTTP como siempre.
 */
function httpsOptions(config: ReturnType<typeof loadAppConfig>): { https: { key: Buffer; cert: Buffer } } | Record<string, never> {
  if (!config.httpsCert || !config.httpsKey) return {};
  return {
    https: {
      key: readFileSync(config.httpsKey),
      cert: readFileSync(config.httpsCert),
    },
  };
}

async function openStore(config: ReturnType<typeof loadAppConfig>, log: ReturnType<typeof createLogger>): Promise<{ store: Store; persisted: boolean }> {
  if (config.persistence === "postgres") {
    try {
      const store = await createStore({ mode: "postgres", databaseUrl: config.databaseUrl });
      return { store, persisted: true };
    } catch (error) {
      log.error(
        { err: (error as Error).message },
        "no se pudo conectar a PostgreSQL: arrancando con almacén en memoria (los recuerdos NO sobrevivirán al reinicio)",
      );
    }
  }
  const store = await createStore({ mode: "memory" });
  return { store, persisted: false };
}

/**
 * Construye el motor de síntesis según la configuración.
 *
 * Con "qwen" o "bank" hace falta la app de clonación (modelo + audio de
 * referencia). Si algo falta, se registra y se cae en `say`: es preferible
 * una voz del sistema a no tener voz.
 */
async function buildTtsEngine(
  config: ReturnType<typeof loadAppConfig>,
  log: Logger,
): Promise<TtsEngine> {
  const fallback = new MacSayTts({
    voice: config.ttsSayVoice,
    cacheDir: config.ttsCacheDir || undefined,
  });
  if (config.ttsEngine === "say") return fallback;

  // Kokoro: voz masculina neuronal en local. Si el servicio no está en
  // marcha, se dice exactamente por qué (y se cae en `say`).
  const kokoro = new KokoroTts({
    baseUrl: config.ttsKokoroUrl,
    voice: config.ttsKokoroVoice,
  });
  const kokoroStatus = await kokoro.available();
  if (config.ttsEngine === "kokoro") {
    if (!kokoroStatus.ok) {
      log.warn({ reason: kokoroStatus.reason }, "el motor de voz Kokoro no está disponible: se usa la voz del sistema");
      return fallback;
    }
    return kokoro;
  }

  const qwen = new QwenTts({
    binary: config.ttsQwenBinary,
    model: config.ttsQwenModel,
    mmproj: config.ttsQwenMmproj,
    reference: config.ttsQwenReference || undefined,
    device: config.ttsQwenDevice,
  });
  const status = await qwen.available();
  if (!status.ok) {
    log.warn({ engine: config.ttsEngine, reason: status.reason }, "el motor de voz clonada no está disponible: se usa la voz del sistema");
    return fallback;
  }

  if (config.ttsEngine === "qwen") {
    log.warn(
      { engine: "qwen3-tts" },
      "la voz clonada va por CPU: es lentísima (medido: 0,04x tiempo real). Úsala con un banco de frases o con GPU.",
    );
    return qwen;
  }

  // "bank": el banco da las frases pregrabadas; el resto se sintetiza con el
  // motor que haya (el clonado, si está, o `say`).
  const bank = new PhraseBank({
    directory: config.ttsPhraseBankDir || join(process.cwd(), ".voice-bank"),
    similarity: 0.92,
  });
  await bank.load();
  const engine = new PhraseBankEngine(bank, qwen);
  log.info({ frases: bank.size, dir: config.ttsPhraseBankDir }, "banco de frases de voz clonada cargado");
  return engine;
}

/**
 * Cadena de proveedores. El primario es NVIDIA NIM; si falla por una causa de
 * proveedor (red, timeout, 5xx, rate limit, credenciales), el turno se
 * reintenta con el siguiente de la lista. Si no hay respaldo configurado, se
 * comporta exactamente como antes (un solo proveedor).
 */
function createProvider(log: Logger, metrics: Metrics): { provider: AiProvider; providerNote: string } {
  const chain: AiProvider[] = [];
  const notes: string[] = [];

  try {
    const nvidia = new NvidiaNimProvider(loadNvidiaConfig());
    chain.push(nvidia);
    notes.push(`nvidia-nim (${nvidia.models.chat})`);
  } catch (error) {
    notes.push(`nvidia-nim no disponible: ${(error as Error).message}`);
  }

  const openRouterConfig = loadOpenRouterConfig();
  if (openRouterConfig) {
    chain.push(new OpenRouterProvider(openRouterConfig));
    notes.push(`openrouter (${openRouterConfig.model})`);
  } else {
    notes.push("openrouter sin configurar (respaldo no disponible)");
  }

  if (chain.length === 0) {
    const reason = notes.join(" | ");
    return { provider: new UnavailableProvider(reason), providerNote: `unavailable: ${reason}` };
  }
  if (chain.length === 1) {
    return { provider: chain[0] as AiProvider, providerNote: notes.join(" | ") };
  }

  // ARCH-001 · El enrutador decide a quién se llama: la cadena reactiva
  // conmuta cuando una petición falla y el circuito evita llamar al
  // proveedor caído hasta que se recupera.
  const router = new ResilientAIRouter(chain, {
    onFailover: (event) => {
      metrics.increment("provider.failovers");
      log.warn(
        { from: event.from, to: event.to, kind: event.kind, attempt: event.attempt },
        `conmutación de proveedor: ${event.from} → ${event.to} (${event.kind})`,
      );
    },
  });
  return { provider: router, providerNote: notes.join(" | ") };
}

void bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("fatal startup error", error);
  process.exit(1);
});
