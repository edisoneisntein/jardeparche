import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { ClientCommandSchema, type ServerEvent, VoiceInterruptRequestSchema, VoiceInterruptAckSchema } from "@jarvis/shared";
import type { AiProvider } from "@jarvis/ai-provider";
import type { MemoryService, Store } from "@jarvis/memory";
import type { ToolRegistry } from "@jarvis/tool-registry";
import type { AsrProvider, StreamingAsrProvider } from "@jarvis/ai-provider";
import type { AgentRuntime } from "@jarvis/agent-runtime";
import type { VoiceService } from "@jarvis/voice";
import type { PerceptionService } from "@jarvis/perception";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { EventHub } from "./hub.js";
import type { HealthRegistry } from "./health.js";
import type { Metrics } from "./metrics.js";

export interface ServerDeps {
  config: AppConfig;
  log: Logger;
  provider: AiProvider;
  store: Store;
  memory: MemoryService;
  registry: ToolRegistry;
  runtime: AgentRuntime;
  voice: VoiceService;
  perception: PerceptionService;
  metrics: Metrics;
  health: HealthRegistry;
  hub: EventHub;
  emit: (event: ServerEvent) => void;
  /** Manejador de interrupción atómica (P1): retorna epoch confirmado y nuevos epoch */
  handleInterrupt: (sessionId: string, clientGeneration: number, serverEpoch: number) => { confirmedEpoch: number; newServerEpoch: number; flushedBytes: number };
  /** ASR del servidor modo archivo (legacy): si falta, el cliente usa el del navegador. */
  asr?: AsrProvider;
  /** ASR del servidor modo streaming (P3): para modelos RNN-T. */
  streamingAsr?: StreamingAsrProvider;
  /** Streamers de TTS por sesión para runTurnStreaming. */
  streamers: Map<string, { push: (text: string) => void }>;
  asrSampleRate: number;
}

// true si el origen apunta a esta máquina o a una IP privada de red local.
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      /^192\.168\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

export async function buildApp(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, log } = deps;
  const app = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    trustProxy: false,
    bodyLimit: 16 * 1024 * 1024,
  });
  const hub = deps.hub;
  const emit = deps.emit;

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      // Permitir cualquier origen de red local (localhost, 127.0.0.1, ::1 y IPs
      // privadas) en cualquier puerto, para que la consola funcione al abrirla
      // por la IP de la LAN y no solo por localhost.
      if (isLocalOrigin(origin)) return callback(null, true);
      log.warn({ origin }, "rejected origin");
      return callback(null, false);
    },
    credentials: false,
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

  const authorized = (request: FastifyRequest, userId?: unknown): { ok: true } | { ok: false; status: number; error: string } => {
    const query = request.query as Record<string, unknown> | undefined;
    const token = (request.headers["x-jarvis-token"] as string | undefined) ?? (query?.token as string | undefined);
    if (config.accessToken && token !== config.accessToken) return { ok: false, status: 401, error: "token inválido o ausente" };
    if (userId !== undefined && !config.users.includes(String(userId))) {
      return { ok: false, status: 403, error: `usuario no autorizado: ${String(userId)}` };
    }
    return { ok: true };
  };

  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { message?: string; statusCode?: number };
    log.error({ err: failure.message ?? String(error) }, "request failed");
    void reply.status(failure.statusCode ?? 500).send({ error: failure.message ?? "error interno" });
  });

  app.get("/api/health", async () => deps.health.check());
  /**
   * PERF-001 · Salud en streaming (Server-Sent Events).
   *
   * El HUD ya no sondea: se suscribe a este canal y recibe el informe cada
   * vez que cambia. Un stream por cliente, sin sondeo periódico, y sin que
   * el navegador abra y cierre una petición cada 30 segundos.
   */
  app.get("/api/health/stream", async (request, reply) => {
    // Fastify no debe intentar cerrar la respuesta: la escribimos a mano.
    reply.hijack();
    // CORS headers para SSE (hijack bypassa el middleware CORS)
    const origin = request.headers.origin;
    if (origin && (config.allowedOrigins.includes(origin) || isLocalOrigin(origin))) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "false");
    }
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Evita que un proxy intermedio acumule los eventos y los suelte a golpes.
      "X-Accel-Buffering": "no",
    });
    const write = (payload: unknown): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      write(await deps.health.check());
    } catch (error) {
      log.warn({ err: (error as Error).message }, "health stream: primer informe fallido");
    }
    const timer = setInterval(() => {
      void deps.health
        .check()
        .then(write)
        .catch((error: Error) => log.warn({ err: error.message }, "health stream: informe fallido"));
    }, 5_000);
    // El cliente se va: se corta el timer o el stream se queda abierto para
    // siempre consumiendo una consulta de salud cada 5 segundos.
    request.raw.on("close", () => {
      clearInterval(timer);
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
  app.get("/api/metrics", async (request, reply) => {
    const auth = authorized(request);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return { ...deps.metrics.snapshot(), hubConnections: hub.connectionCount(), activeTasks: deps.runtime.activeTaskCount() };
  });
  app.get("/api/users", async (request, reply) => {
    const auth = authorized(request);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    // Los usuarios que el servidor autoriza de verdad: la UI no puede
    // inventar un identificador que acabaría en un 403.
    return { users: config.users };
  });

  app.get("/api/capabilities", async (request, reply) => {
    const auth = authorized(request);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    const capabilities = await deps.provider.capabilities();
    return {
      provider: deps.provider.name,
      models: modelsOf(deps.provider),
      capabilities,
      tools: deps.registry.list().map((tool) => {
        const availability = tool.availability();
        return {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          risk: tool.risk,
          requiresApproval: tool.requiresApproval,
          available: availability.available,
          reason: availability.reason,
        };
      }),
      voice: deps.voice.providers(),
    };
  });
  app.get("/api/voice", async () => deps.voice.status());

  app.get("/api/sessions", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const userId = query.userId ?? config.users[0] ?? "local";
    const auth = authorized(request, userId);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.listSessions(userId, Number(query.limit ?? 50));
  });
  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as { userId?: string; title?: string };
    const userId = body.userId ?? config.users[0] ?? "local";
    const auth = authorized(request, userId);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.createSession({ id: crypto.randomUUID(), userId, title: body.title });
  });
  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await deps.store.getSession(id);
    if (!session) return reply.status(404).send({ error: "sesión no encontrada" });
    const auth = authorized(request, session.userId);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.getMessages(id, 200);
  });
  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await deps.store.getSession(id);
    if (!session) return reply.status(404).send({ error: "sesión no encontrada" });
    const auth = authorized(request, session.userId);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    await deps.store.deleteSession(id);
    return { deleted: true };
  });

  app.get("/api/tasks", async (request, reply) => {
    const { userId, status } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.listTasks(userId ?? config.users[0] ?? "local", status as "open" | "done" | undefined);
  });
  app.get("/api/memory/facts", async (request, reply) => {
    const { userId } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.listSemantic(userId ?? config.users[0] ?? "local", 200);
  });
  app.delete("/api/memory/facts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    const deleted = await deps.store.deleteSemantic(userId ?? config.users[0] ?? "local", id);
    return { deleted };
  });
  app.get("/api/memory/episodes", async (request, reply) => {
    const { userId } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.listEpisodic(userId ?? config.users[0] ?? "local", 50);
  });
  app.get("/api/memory/export", async (request, reply) => {
    const { userId } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.memory.exportUser(userId ?? config.users[0] ?? "local");
  });
  app.delete("/api/memory", async (request, reply) => {
    const { userId } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    await deps.memory.deleteUser(userId ?? config.users[0] ?? "local");
    return { deleted: true };
  });
  app.get("/api/audit", async (request, reply) => {
    const { userId, limit } = request.query as Record<string, string>;
    const auth = authorized(request, userId ?? config.users[0]);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return deps.store.listAudit(userId ?? config.users[0] ?? "local", Number(limit ?? 100));
  });
  app.get("/api/governance", async (request, reply) => {
    const auth = authorized(request);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    return {
      riskLevels: {
        public_read: "Lectura de información pública, permitida dentro de las políticas.",
        local_reversible: "Acciones locales reversibles, con alcance limitado.",
        external_effect: "Escritura externa o envío de mensajes: requiere confirmación del usuario.",
        destructive: "Acciones destructivas: bloqueadas hasta aprobación explícita; siempre auditadas.",
      },
      approvalRequired: deps.registry.list().filter((tool) => tool.requiresApproval).map((tool) => tool.name),
      rules: [
        "El modelo nunca ejecuta comandos: solo puede nombrar herramientas del registro.",
        "Los argumentos se validan con esquemas antes de cualquier efecto.",
        "El contenido externo no puede modificar permisos ni políticas.",
        "Toda aprobación y ejecución queda registrada en jarvis_audit_log.",
      ],
    };
  });

  app.post("/api/perception/analyze", async (request, reply) => {
    const body = (request.body ?? {}) as { sessionId?: string; dataUrl?: string; prompt?: string; cameraActive?: boolean };
    if (!body.sessionId || !body.dataUrl) return reply.status(400).send({ error: "sessionId y dataUrl son obligatorios" });
    const session = await deps.store.getSession(body.sessionId);
    if (!session) return reply.status(404).send({ error: "sesión no encontrada" });
    const auth = authorized(request, session.userId);
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error });
    try {
      const analysis = await handlePerception(deps, emit, {
        sessionId: body.sessionId,
        userId: session.userId,
        dataUrl: body.dataUrl,
        prompt: body.prompt,
        cameraActive: Boolean(body.cameraActive),
      });
      return { text: analysis.text };
    } catch (error) {
      log.warn({ err: (error as Error).message }, "perception failed");
      return reply.status(422).send({ error: (error as Error).message });
    }
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const query = request.query as Record<string, string>;
    const sessionId = query.sessionId;
    const userId = query.userId ?? config.users[0] ?? "local";
    const auth = authorized(request, userId);
    if (!auth.ok || !sessionId) {
      log.warn({ url: request.raw.url }, "ws rejected");
      socket.close(1008, auth.ok ? "sessionId requerido" : auth.error);
      return;
    }
    // El store persiste sessionId como UUID; uno malformado no debe tumbar el proceso.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      log.warn({ sessionId }, "ws rejected: sessionId no es UUID");
      socket.close(1008, "sessionId debe ser un UUID");
      return;
    }
    const meta = { sessionId, userId, connectedAt: new Date().toISOString() };
    hub.add(socket as unknown as { send(data: string): void; readyState: number }, meta);
    log.info({ sessionId, userId }, "ws connected");

    const push = (event: ServerEvent) => hub.send(sessionId, event);
    // Audio capturado por el navegador para el ASR del servidor (modo archivo).
    const audioBuffers = new Map<string, Buffer[]>();
    const audioBytes = new Map<string, number>();
    // Sesiones de ASR streaming (P3).
    const streamingSessions = new Map<string, { streamingAsr: StreamingAsrProvider; buffer: string }>();
    // Streamers de TTS por sesión (para runTurnStreaming).
    const streamers = new Map<string, { push: (text: string) => void }>();
    // La sesión se prepara ANTES de atender comandos. Sin esta espera, un
    // cliente que envíe `chat.send` en el mismo instante de la conexión
    // adelanta la creación de la sesión y el turno falla con una violación de
    // clave foránea en `jarvis_messages`.
    const ready = (async () => {
      try {
        const session = await deps.store.getSession(sessionId);
        if (!session) await deps.store.createSession({ id: sessionId, userId });
        push({ type: "session.created", sessionId, userId, ts: new Date().toISOString() } as ServerEvent);
      } catch (err) {
        log.error({ err, sessionId }, "ws bootstrap failed");
        socket.close(1011, "error al preparar la sesión");
        throw err;
      }
    })();
    // El rechazo de una promesa sin manejar no debe tumbar el proceso.
    ready.catch(() => undefined);

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        // Ningún comando se ejecuta antes de que la sesión exista.
        try {
          await ready;
        } catch {
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const command = ClientCommandSchema.safeParse(parsed);
        if (!command.success) {
          push({ type: "agent.error", sessionId, ts: new Date().toISOString(), message: `comando inválido: ${command.error.issues[0]?.message}`, recoverable: true });
          return;
        }
        const cmd = command.data;
        if ("sessionId" in cmd && cmd.sessionId !== sessionId) {
          push({ type: "agent.error", sessionId, ts: new Date().toISOString(), message: "sessionId no coincide con la conexión", recoverable: true });
          return;
        }
        try {
          switch (cmd.type) {
            case "ping":
              push({ type: "pong", sessionId, ts: new Date().toISOString(), serverTime: new Date().toISOString() });
              break;
            case "session.describe": {
              const session = await deps.store.getSession(sessionId);
              if (!session) await deps.store.createSession({ id: sessionId, userId });
              push({ type: "session.created", sessionId, userId, ts: new Date().toISOString() });
              break;
            }
            case "chat.send": {
              deps.metrics.increment("tasks.started");
              const started = Date.now();
              const result = await deps.runtime.runTurn({ userId, sessionId }, cmd.text);
              deps.metrics.observe("turn.duration", Date.now() - started);
              if (!result.text) deps.metrics.increment("tasks.cancelled_or_failed");
              break;
            }
            case "chat.cancel": {
              const cancelled = cmd.taskId ? deps.runtime.cancel(cmd.taskId) : deps.runtime.cancelSession(sessionId);
              if (!cancelled) push({ type: "task.cancelled", sessionId, ts: new Date().toISOString(), taskId: cmd.taskId });
              break;
            }
            case "approval.respond": {
              const record = await deps.runtime.approvals.resolve(cmd.approvalId, cmd.approve);
              log.info({ approvalId: cmd.approvalId, approve: cmd.approve, found: Boolean(record) }, "approval resolved");
              break;
            }
            case "voice.interrupt.request": {
              const interruptCmd = VoiceInterruptRequestSchema.parse({ ...cmd, sessionId });
              const result = deps.handleInterrupt(sessionId, interruptCmd.clientGeneration, interruptCmd.serverEpoch);
              const ack = VoiceInterruptAckSchema.parse({
                type: "voice.interrupt.ack",
                sessionId,
                confirmedEpoch: result.confirmedEpoch,
                flushedBytes: result.flushedBytes,
                serverTimestamp: Date.now(),
                newServerEpoch: result.newServerEpoch,
                ts: new Date().toISOString(),
              });
              push(ack as unknown as ServerEvent);
              break;
            }
            // Streaming ASR (P3) - Nuevos comandos para pipeline streaming
            case "voice.audio.stream.start": {
              if (!deps.streamingAsr) {
                push({ type: "agent.error", sessionId, ts: new Date().toISOString(), message: "ASR streaming no configurado", recoverable: true });
                break;
              }
              const streamingSession = streamingSessions.get(sessionId) ?? { streamingAsr: deps.streamingAsr, buffer: "" };
              streamingSession.streamingAsr = deps.streamingAsr;
              streamingSession.streamingAsr.onTranscript((result) => {
                if (result.isFinal) {
                  streamingSession.buffer = result.text;
                  push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text: result.text, serverAsr: true });
                  // Iniciar turno LLM en streaming
                  deps.metrics.increment("tasks.started");
                  const startedAsr = Date.now();
                  deps.runtime.runTurnStreaming?.({ userId, sessionId }, result.text, undefined, {
                    disableThinking: deps.config.voiceFastTurns,
                    onDelta: (delta: string) => {
                      const streamer = streamers.get(sessionId);
                      if (streamer) streamer.push(delta);
                    },
                  }).catch((err) => {
                    log.warn({ err: err.message }, "streaming turn failed");
                    deps.metrics.increment("tasks.cancelled_or_failed");
                  });
                  deps.metrics.observe("turn.duration", Date.now() - startedAsr);
                } else {
                  push({ type: "voice.asr.partial", sessionId, ts: new Date().toISOString(), text: result.text });
                }
              });
              streamingSession.streamingAsr.onError((error) => {
                log.warn({ err: error.message }, "streaming ASR error");
                push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text: "", serverAsr: false });
              });
              streamingSession.streamingAsr.onClose(() => {
                streamingSessions.delete(sessionId);
              });
              await streamingSession.streamingAsr.connect();
              streamingSessions.set(sessionId, streamingSession);
              break;
            }
            case "voice.audio.stream.chunk": {
              const streamingSession = streamingSessions.get(sessionId);
              if (streamingSession?.streamingAsr) {
                const pcm = Buffer.from(cmd.pcm, "base64");
                streamingSession.streamingAsr.sendAudio(pcm);
              }
              break;
            }
            case "voice.audio.stream.end": {
              const streamingSession = streamingSessions.get(sessionId);
              if (streamingSession?.streamingAsr) {
                streamingSession.streamingAsr.disconnect();
              }
              streamingSessions.delete(sessionId);
              break;
            }
            case "voice.audio.chunk": {
              if (!deps.asr) {
                push({ type: "agent.error", sessionId, ts: new Date().toISOString(), message: "ASR del servidor no configurado", recoverable: true });
                break;
              }
              const chunks = audioBuffers.get(sessionId) ?? [];
              chunks.push(Buffer.from(cmd.pcm, "base64"));
              audioBuffers.set(sessionId, chunks);
              const last = chunks[chunks.length - 1];
              audioBytes.set(sessionId, (audioBytes.get(sessionId) ?? 0) + (last ? last.length : 0));
              break;
            }
            case "voice.audio.flush": {
              const chunks = audioBuffers.get(sessionId) ?? [];
              audioBuffers.delete(sessionId);
              const total = audioBytes.get(sessionId) ?? 0;
              audioBytes.delete(sessionId);
              if (!deps.asr || chunks.length === 0) {
                push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text: "", serverAsr: false });
                break;
              }
              const pcm = Buffer.concat(chunks);
              try {
                const result = await deps.asr.transcribe(pcm, deps.asrSampleRate);
                push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text: result.text, serverAsr: true });
                const text = result.text.trim();
                if (!text) break;
                deps.metrics.increment("tasks.started");
                const startedAsr = Date.now();
                const turn = await deps.runtime.runTurn({ userId, sessionId }, text, undefined, { disableThinking: deps.config.voiceFastTurns });
                deps.metrics.observe("turn.duration", Date.now() - startedAsr);
                if (!turn.text) deps.metrics.increment("tasks.cancelled_or_failed");
              } catch (error) {
                // El ASR del servidor falló: el cliente puede usar el suyo.
                log.warn({ err: (error as Error).message, bytes: total }, "ASR del servidor falló");
                push({ type: "voice.asr.result", sessionId, ts: new Date().toISOString(), text: "", serverAsr: false });
              }
              break;
            }
            case "voice.transcript": {
              // El comando queda registrado y la entrada de voz se anuncia.
              push({ type: "voice.transcript", sessionId, ts: new Date().toISOString(), text: cmd.text, final: cmd.final });
              push({ type: "voice.input_started", sessionId, ts: new Date().toISOString() });
              // Contrato documentado (docs/api.md): una transcripción final ENTRA
              // al agente. Antes solo se reemitía el evento y el turno real lo
              // abría otro comando: la voz quedaba desconectada del runtime.
              if (!cmd.final) break;
              const text = cmd.text.trim();
              if (!text) break;
              deps.metrics.increment("tasks.started");
              const startedVoice = Date.now();
              // El turno de voz va en modo rápido: sin razonamiento, porque la
              // voz no puede esperar a que el modelo piense (medido: el primer
              // token pasa de 1 136 ms a 199 ms y la herramienta se sigue
              // usando igual).
              const result = await deps.runtime.runTurn({ userId, sessionId }, text, undefined, {
                disableThinking: deps.config.voiceFastTurns,
              });
              deps.metrics.observe("turn.duration", Date.now() - startedVoice);
              if (!result.text) deps.metrics.increment("tasks.cancelled_or_failed");
              break;
            }
            case "perception.image": {
              try {
                await handlePerception(deps, push, {
                  sessionId,
                  userId,
                  dataUrl: cmd.dataUrl,
                  prompt: cmd.prompt,
                  cameraActive: cmd.cameraActive,
                });
              } catch (error) {
                push({ type: "agent.error", sessionId, ts: new Date().toISOString(), message: (error as Error).message, recoverable: true });
              }
              break;
            }
          }
        } catch (error) {
          log.error({ err: (error as Error).message }, "command failed");
        }
      })();
    });

    socket.on("close", () => {
      hub.remove(socket as unknown as { send(data: string): void; readyState: number });
      deps.perception.setCameraState(sessionId, false);
      log.info({ sessionId }, "ws closed");
    });
  });

  return app;
}

async function handlePerception(
  deps: ServerDeps,
  push: (event: ServerEvent) => void,
  input: { sessionId: string; userId: string; dataUrl: string; prompt?: string; cameraActive: boolean },
) {
  deps.perception.setCameraState(input.sessionId, input.cameraActive);
  push({ type: "perception.camera_state", sessionId: input.sessionId, ts: new Date().toISOString(), cameraActive: input.cameraActive });
  const payload = deps.perception.parseDataUrl(input.dataUrl);
  push({
    type: "perception.image_received",
    sessionId: input.sessionId,
    ts: new Date().toISOString(),
    width: 0,
    height: 0,
    bytes: payload.bytes,
    cameraActive: input.cameraActive,
  });
  const analysis = await deps.perception.analyze(payload, input.prompt);
  const taskId = crypto.randomUUID();
  await deps.memory.recordAssistantMessage({ userId: input.userId, sessionId: input.sessionId, taskId, text: analysis.text });
  await deps.store.appendAudit({
    userId: input.userId,
    sessionId: input.sessionId,
    action: "perception.analyzed",
    detail: { bytes: analysis.bytes, mime: analysis.mime, model: analysis.model },
  });
  push({ type: "assistant.message_completed", sessionId: input.sessionId, taskId, ts: new Date().toISOString(), text: analysis.text });
  return analysis;
}

function modelsOf(provider: AiProvider): { chat: string; vision: string; embedding: string } {
  const candidate = provider as AiProvider & { models?: { chat?: string; vision?: string; embedding?: string } };
  return {
    chat: candidate.models?.chat ?? "n/a",
    vision: candidate.models?.vision ?? "n/a",
    embedding: candidate.models?.embedding ?? "n/a",
  };
}
