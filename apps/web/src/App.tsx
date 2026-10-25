import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { getMetrics, type ServerMetrics } from "./api/client";
import { useJarvisStore } from "./state/jarvisStore";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap";
import { useJarvisConnection } from "./hooks/useJarvisConnection";
import { useCapabilities } from "./hooks/useCapabilities";
import { useHealthPolling } from "./hooks/useHealthPolling";
import { useDictation } from "./hooks/useDictation";
import { usePrefersReducedMotion } from "./hooks/useReducedMotion";
import { useAgentVisualState } from "./hooks/useAgentVisualState";
import type { AgentState } from "./lib/events";
import { Header } from "./components/hud/Header";
import { VoiceVisualizer } from "./components/voice/VoiceVisualizer";
import { VoiceEqualizer } from "./components/voice/VoiceEqualizer";
import { VoiceGateNotice } from "./components/hud/VoiceGateNotice";
import { Conversation } from "./components/hud/Conversation";
import { useParallax } from "./hooks/useParallax";
import { Composer } from "./components/hud/Composer";
import { ActivityPanel } from "./components/hud/ActivityPanel";
import { CapabilitiesPanel } from "./components/hud/CapabilitiesPanel";
import { CameraPanel } from "./components/hud/CameraPanel";
import { ApprovalModal } from "./components/hud/ApprovalModal";
import { SettingsPanel } from "./components/hud/SettingsPanel";
import { BootScreen } from "./components/hud/BootScreen";
import { IntroSequence } from "./components/hud/IntroSequence";
import { HoloPanels, ReticleLayer } from "./components/fx/HoloDeck";
import { Anillo1 } from "./components/reactor/Anillo1";
import { Anillo2 } from "./components/reactor/Anillo2";
import { Anillo3 } from "./components/reactor/Anillo3";
import { NucleoParticulas } from "./components/reactor/NucleoParticulas";
import { NucleoDescarga } from "./components/reactor/NucleoDescarga";
import { Anillo4 } from "./components/reactor/Anillo4";
import { ParticleVeil } from "./components/fx/ParticleVeil";
import { ScanOverlay } from "./components/fx/ScanOverlay";
import { HolographicDiagnostics } from "./components/fx/HolographicDiagnostics";
import { HudDock } from "./components/hud/HudDock";
import { PulseIcon, ToolsIcon, ActivityIcon, CameraIcon } from "./components/hud/icons";
import { attachAudioUnlockGesture } from "./lib/serverAudio";

/**
 * El color de la voz. La voz NO es el estado del agente: por eso sus
 * elementos (el ecualizador y el visualizador) no se tiñen de rojo cuando
 * algo falla. Ese aviso lo lleva el plasma del nucleo, que si cambia de
 * color y se intensifica.
 */
const COLOR_VOZ = "#00f0ff";
/** Las estelas del nucleo son luz azul electrica, siempre. */
const COLOR_PARTICULAS = "#6fe4ff";

const BUSY_STATES: ReadonlySet<string> = new Set([
  "LISTENING",
  "UNDERSTANDING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "EXECUTING",
  "SPEAKING",
]);

const BOOT_FLAG = "jarvis.web.entered.v1";

type Phase = "boot" | "intro" | "hud";

function readEntered(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.sessionStorage.getItem(BOOT_FLAG) === "1") return true;
  } catch {
    /* sessionStorage may be unavailable */
  }
  // Development shortcut: ?skip=1 jumps straight to the console (never in prod).
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("skip") === "1";
}

export function App() {
  // La apertura con audio se ve SIEMPRE al abrir la aplicación: lo que ya
  // se hizo (la pantalla de arranque y el permiso de micrófono) no se
  // repite, pero el JARVIS siempre se abre con su introduction.
  const [phase, setPhase] = useState<Phase>(() => (readEntered() ? "intro" : "boot"));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settings = useJarvisStore((state) => state.settings);
  const updateSettings = useJarvisStore((state) => state.updateSettings);
  const connection = useJarvisStore((state) => state.connection);
  const session = useJarvisStore((state) => state.session);
  const sessionError = useJarvisStore((state) => state.sessionError);
  const health = useJarvisStore((state) => state.health);
  const healthLoading = useJarvisStore((state) => state.healthLoading);
  const healthError = useJarvisStore((state) => state.healthError);
  const capabilities = useJarvisStore((state) => state.capabilities);
  const capabilitiesLoading = useJarvisStore((state) => state.capabilitiesLoading);
  const capabilitiesError = useJarvisStore((state) => state.capabilitiesError);
  const thread = useJarvisStore((state) => state.thread);
  const activities = useJarvisStore((state) => state.activities);
  const metrics = useJarvisStore((state) => state.metrics);
  const [serverMetrics, setServerMetrics] = useState<ServerMetrics | null>(null);
  const usage = useJarvisStore((state) => state.usage);
  const agentStateStore = useJarvisStore((state) => state.agentState);
  // El bloque completo se asienta de golpe cuando cambia el estado: los
  // cuatro anillos lo sienten a la vez (si solo se moviese uno, el conjunto
  // deja de leerse como una sola pieza).
  const [asentado, setAsentado] = useState(true);
  const estadoParaAsentar = useRef<AgentState | null>(agentStateStore);
  useEffect(() => {
    if (estadoParaAsentar.current === agentStateStore) return;
    estadoParaAsentar.current = agentStateStore;
    setAsentado(false);
    const temporizador = window.setTimeout(() => setAsentado(true), 130);
    return () => window.clearTimeout(temporizador);
  }, [agentStateStore]);
  // En desarrollo se puede forzar el estado del agente (?estado=PLANNING)
  // para revisar la estética del núcleo sin levantar el backend. Reacciona
  // a popstate para poder provocar una transición en caliente.
  const [estadoForzado, setEstadoForzado] = useState<string | null>(() =>
    import.meta.env.DEV ? new URLSearchParams(window.location.search).get("estado") : null,
  );
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const alCambiar = (): void =>
      setEstadoForzado(new URLSearchParams(window.location.search).get("estado"));
    window.addEventListener("popstate", alCambiar);
    return () => window.removeEventListener("popstate", alCambiar);
  }, []);
  const agentState = (estadoForzado as AgentState | null) ?? agentStateStore;
  const agentDetail = useJarvisStore((state) => state.agentDetail);
  const currentTaskId = useJarvisStore((state) => state.currentTaskId);
  const pendingApproval = useJarvisStore((state) => state.pendingApproval);
  const ttsSpeaking = useJarvisStore((state) => state.ttsSpeaking);
  const sendCommand = useJarvisStore((state) => state.sendCommand);
  const addUserMessage = useJarvisStore((state) => state.addUserMessage);
  const addSystemMessage = useJarvisStore((state) => state.addSystemMessage);
  const resolveApproval = useJarvisStore((state) => state.resolveApproval);
  const recordActivity = useJarvisStore((state) => state.recordActivity);

  const sessionId = session?.id ?? null;
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = settings.reducedMotion || systemReducedMotion;

  const refreshHealth = useHealthPolling();
  const refreshCapabilities = useCapabilities();

  useSessionBootstrap(settings.userId);
  useJarvisConnection({ sessionId, userId: settings.userId, settings });
  // Parallax holográfico y ondas expansivas en cada interacción.
  useParallax(!reducedMotion);

  // Métricas REALES del servidor (conexiones abiertas y tareas activas).
  useEffect(() => {
    let alive = true;
    const load = () => {
      void getMetrics()
        .then((snapshot) => {
          if (alive) setServerMetrics(snapshot);
        })
        .catch(() => {
          if (alive) setServerMetrics(null);
        });
    };
    load();
    const id = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const dispatchChat = useCallback(
    (text: string, source: "chat" | "voice") => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!sessionId) {
        addSystemMessage("Sin sesión activa: el backend todavía no respondió.", "system");
        return;
      }
      const sent = sendCommand({ type: "chat.send", sessionId, text: trimmed });
      if (!sent) {
        addSystemMessage("Canal cerrado: el mensaje no se envió al backend.", "system");
        recordActivity({
          kind: "connection",
          title: "Envío bloqueado",
          detail: "El enlace en tiempo real no está abierto",
          tone: "warn",
        });
        return;
      }
      addUserMessage(trimmed, source);
    },
    [sessionId, sendCommand, addUserMessage, addSystemMessage, recordActivity],
  );

  const dictation = useDictation({
    sessionId,
    connection,
    language: settings.language,
    wakeWord: settings.wakeWord,
    requireWakeWord: settings.requireWakeWord,
    voiceAsrMode: settings.voiceAsrMode,
    sendCommand,
    // La vía de voz ya viaja como `voice.transcript` (el servidor abre el
    // turno). Aquí solo se refleja en el hilo: enviar además `chat.send`
    // ejecutaría el turno dos veces.
    onFinalTranscript: (command) => addUserMessage(command, "voice"),
    onVoiceError: (message) => addSystemMessage(`Voz: ${message}`, "voice"),
  });

  const visual = useAgentVisualState(agentState, dictation.micLevel, ttsSpeaking, reducedMotion);
  const agentBusy = agentState !== null && BUSY_STATES.has(agentState);
  const ensureMicPermission = dictation.ensurePermission;

  const handleStop = useCallback(() => {
    if (!sessionId) return;
    sendCommand({ type: "chat.cancel", sessionId, taskId: currentTaskId ?? undefined });
    // Handshake atómico de interrupción (P1)
    void import("./lib/serverAudio").then((mod) => mod.stopServerAudio(sessionId, sendCommand)).catch(() => undefined);
    recordActivity({ kind: "task", title: "Cancelación solicitada", tone: "warn" });
  }, [sessionId, currentTaskId, sendCommand, recordActivity]);

  const handleApproval = useCallback(
    (approve: boolean) => {
      if (!pendingApproval || !sessionId) return;
      sendCommand({
        type: "approval.respond",
        sessionId,
        approvalId: pendingApproval.approvalId,
        approve,
      });
      resolveApproval(pendingApproval.approvalId, approve);
      recordActivity({
        kind: "approval",
        title: approve ? `Aprobada · ${pendingApproval.name}` : `Rechazada · ${pendingApproval.name}`,
        tone: approve ? "success" : "warn",
      });
    },
    [pendingApproval, sessionId, sendCommand, resolveApproval, recordActivity],
  );

  const handleEnter = useCallback(() => {
    try {
      window.sessionStorage.setItem(BOOT_FLAG, "1");
    } catch {
      /* sessionStorage may be unavailable */
    }
    // Pedir el micrófono DENTRO del gesto de clic: Chrome exige que
    // getUserMedia se invoque con activación de usuario, o lo rechaza
    // y deja el origen como "denegado".
    void ensureMicPermission();
    // Desbloquear AudioContext en el primer gesto de usuario (P1)
    attachAudioUnlockGesture();
    setPhase(reducedMotion ? "hud" : "intro");
  }, [reducedMotion, ensureMicPermission]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen]);

  if (phase === "boot") {
    return (
      <BootScreen
        health={health}
        loading={healthLoading}
        error={healthError}
        onEnter={handleEnter}
        onRetry={() => {
          void refreshHealth();
        }}
      />
    );
  }

  if (phase === "intro") {
    return <IntroSequence reducedMotion={reducedMotion} connection={connection} onDone={() => setPhase("hud")} />;
  }

  const voiceActive = dictation.listening;
  const busyLevel = agentBusy ? 1 : agentState === "SPEAKING" ? 0.7 : 0.1;

  return (
    <div
      className="app-shell"
      data-agent={agentState ?? "UNKNOWN"}
      style={{ "--state-color": visual.color } as CSSProperties}
    >
      <div className="hud-shockwaves" aria-hidden="true" />

      <div className="hud-backdrop" aria-hidden="true">
        <img className="hud-backdrop-hero" src="/assets/jarvis/hero-ironman-hud.jpg" alt="" />
        <img className="hud-backdrop-ambient" src="/assets/jarvis/reactor-orb.jpg" alt="" />
        <HoloPanels />
        <div className="hud-backdrop-veil" />
        <div className="scanlines" />
      </div>

      <ParticleVeil
        color={visual.color}
        intensity={busyLevel}
        reducedMotion={reducedMotion}
        speed={visual.particleSpeed * 60}
        opacity={visual.particleOpacity}
      />
      <ScanOverlay />

      <Header
        agentState={agentState}
        agentDetail={agentDetail}
        connection={connection}
        health={health}
        capabilities={capabilities}
        sessionId={sessionId}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="hud-grid">
        <section className="reactor-column" aria-label="Núcleo">
          <div className="reactor-stack">
            <div className="nucleo-bloque" data-asentado={asentado ? "true" : "false"}>
              <Anillo2 state={agentState} reducedMotion={reducedMotion} />
              <Anillo3 state={agentState} reducedMotion={reducedMotion} micLevel={dictation.micLevel} />
              <Anillo4 state={agentState} reducedMotion={reducedMotion} color={COLOR_PARTICULAS} />
            </div>
            <NucleoParticulas
              state={agentState}
              color={COLOR_PARTICULAS}
              micLevel={dictation.micLevel}
              voz={ttsSpeaking}
              reducedMotion={reducedMotion}
            />
            <NucleoDescarga state={agentState} reducedMotion={reducedMotion} />
            <Anillo1 state={agentState} reducedMotion={reducedMotion} />
            <ReticleLayer state={agentState} reducedMotion={reducedMotion} />
            <VoiceVisualizer
              active={voiceActive}
              speaking={ttsSpeaking}
              state={agentState}
              color={visual.color}
              reducedMotion={reducedMotion}
            />
          </div>

          {/* La "boca" de la máscara: se enciende con tu voz o con la voz
              sintetizada de JARVIS. */}
          <VoiceEqualizer
            active={voiceActive}
            speaking={ttsSpeaking}
            color={COLOR_VOZ}
            reducedMotion={reducedMotion}
          />

          <p className="voice-caption" data-active={voiceActive ? "true" : "false"}>
            {voiceActive
              ? "espectro del micrófono · en vivo"
              : ttsSpeaking
                ? "salida de voz · envolvente real de la síntesis"
                : "anillo en reposo · activa el micrófono para ver tu voz"}
          </p>

          <div className="reactor-caption">
            <h2>NÚCLEO ARC</h2>
            <p>
              El núcleo refleja el estado real del agente. Si dice EN ESPERA, no hay ninguna tarea en curso.
            </p>
          </div>
          <dl className="status-rail">
            <div>
              <dt>Tarea</dt>
              <dd>{currentTaskId ? currentTaskId.slice(0, 8) : "—"}</dd>
            </div>
            <div>
              <dt>Herramientas</dt>
              <dd>
                {metrics.toolCalls} · {metrics.toolFailures} fallos
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>{usage.totalTokens ?? 0}</dd>
            </div>
            <div>
              <dt>Eventos</dt>
              <dd>{metrics.events}</dd>
            </div>
            <div>
              <dt>Enlace</dt>
              <dd>
                {serverMetrics ? `${serverMetrics.hubConnections}·${serverMetrics.activeTasks}` : "—"}
              </dd>
            </div>
          </dl>
        </section>
      </main>

      <aside className="hud-chat-rail" aria-label="Conversación y entrada">
        <Conversation
          thread={thread}
          agentState={agentState}
          sessionError={sessionError}
          connection={connection}
          reducedMotion={reducedMotion}
        />
        <VoiceGateNotice gate={dictation.gate} onRetry={() => void dictation.recheckMic()} />
        <Composer
          connection={connection}
          agentBusy={agentBusy}
          dictation={dictation}
          ttsEnabled={settings.ttsEnabled}
          onToggleTts={() => updateSettings({ ttsEnabled: !settings.ttsEnabled })}
          onSend={(text) => dispatchChat(text, "chat")}
          onStop={handleStop}
        />
      </aside>

      <HudDock position="top-left" label="Diagnósticos" icon={<PulseIcon />}>
        <HolographicDiagnostics
          metrics={metrics}
          health={health}
          activities={activities}
          color={visual.color}
          variant="inline"
        />
      </HudDock>

      <HudDock position="right-edge" label="Capacidades" icon={<ToolsIcon />}>
        <CapabilitiesPanel
          capabilities={capabilities}
          loading={capabilitiesLoading}
          error={capabilitiesError}
          onRefresh={() => {
            void refreshCapabilities();
          }}
        />
      </HudDock>

      <HudDock position="bottom-left" label="Sensores Ópticos" icon={<CameraIcon />}>
        <CameraPanel
          sessionId={sessionId}
          connection={connection}
          cameraEnabled={settings.cameraEnabled}
          sendCommand={sendCommand}
        />
      </HudDock>

      <HudDock position="bottom-right" label="Telemetría" icon={<ActivityIcon />}>
        <ActivityPanel
          activities={activities}
          connection={connection}
          metrics={metrics}
          usage={usage}
          health={health}
          healthError={healthError}
          onRefreshHealth={() => {
            void refreshHealth();
          }}
        />
      </HudDock>

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          onChange={(patch: Partial<typeof settings>) => updateSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {pendingApproval ? (
        <ApprovalModal
          approval={pendingApproval}
          onApprove={() => handleApproval(true)}
          onReject={() => handleApproval(false)}
        />
      ) : null}
    </div>
  );
}
