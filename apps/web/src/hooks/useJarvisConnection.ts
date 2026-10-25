import { useEffect, useRef } from "react";
import { buildWebSocketUrl } from "../api/client";
import { eventDedupeKey, isServerEvent, type ClientCommand, type ServerEvent } from "../lib/events";
import { cancelSpeech, speakFragment, speakGeneration, stopBrowserSpeech, stopGeneration } from "../lib/tts";
import { playServerSegment, resetServerAudio, setBlockedHandler, stopServerAudio, unlockServerAudio, setServerEpoch } from "../lib/serverAudio";
import { applyServerEvent } from "../state/serverEvents";
import { beepAttention, beepReply, beepTool } from "../lib/beeps";
import { useJarvisStore } from "../state/jarvisStore";
import type { JarvisSettings } from "../state/settings";

/** Margen para que llegue el primer segmento de audio del servidor. */
const SERVER_AUDIO_GRACE_MS = 800;

const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 500;
const MAX_DEDUPE_KEYS = 4_000;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  const jitter = exponential * (0.7 + Math.random() * 0.6);
  return Math.min(MAX_BACKOFF_MS, Math.round(jitter));
}

export function useJarvisConnection(input: {
  sessionId: string | null;
  userId: string;
  settings: JarvisSettings;
}): void {
  const { sessionId, userId } = input;
  const settingsRef = useRef(input.settings);
  settingsRef.current = input.settings;

  const setConnection = useJarvisStore((state) => state.setConnection);
  const setSendCommand = useJarvisStore((state) => state.setSendCommand);
  const setAgentState = useJarvisStore((state) => state.setAgentState);
  const recordActivity = useJarvisStore((state) => state.recordActivity);
  /** Referencia a la función send actual para uso en callbacks */
  const sendRef = useRef<(command: ClientCommand) => boolean>(() => false);

  useEffect(() => {
    if (!sessionId) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    const dedupe = new Set<string>();

    const rememberKey = (key: string) => {
      dedupe.add(key);
      if (dedupe.size > MAX_DEDUPE_KEYS) {
        const first = dedupe.values().next().value;
        if (first !== undefined) dedupe.delete(first);
      }
    };

    // Cronómetro de respaldo: si el servidor no manda audio, se usa la voz del
    // navegador. Si llega audio del servidor, el cronómetro se cancela y solo
    // se oye UNA voz.
    const fallbackTimers = new Map<string, number>();
    let serverAudio = false;
    const scheduleFallback = (generationId: string, text: string): void => {
      const settings = settingsRef.current;
      if (!settings.ttsEnabled) return;
      const timer = window.setTimeout(() => {
        fallbackTimers.delete(generationId);
        speakGeneration({
          generationId,
          text,
          language: settings.language,
          voiceURI: settings.voiceURI,
        });
      }, SERVER_AUDIO_GRACE_MS);
      fallbackTimers.set(generationId, timer);
    };
    const cancelFallback = (generationId: string): void => {
      const timer = fallbackTimers.get(generationId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        fallbackTimers.delete(generationId);
      }
    };

    // Plan B: si Chrome no deja reproducir el WAV del servidor (política de
    // reproducción automática), el fragmento se dice con la voz del navegador.
    // Antes el `play()` se quedaba pendiente para siempre: el texto llegaba
    // y la voz no, y además la cola quedaba bloqueada.
    setBlockedHandler((text: string) => {
      const ajustes = settingsRef.current;
      if (!ajustes.ttsEnabled || !text) return;
      // Evitar que suenen dos voces a la vez: cortamos cualquier audio del servidor.
      if (sessionId && sendRef.current) {
        void stopServerAudio(sessionId, sendRef.current);
      } else {
        stopServerAudio(); // fallback legacy
      }
      speakFragment({
        generationId: `voice:${sessionId}`,
        text,
        language: ajustes.language,
        voiceURI: ajustes.voiceURI,
      });
    });

    const handleVoiceEvent = (event: ServerEvent) => {
      const settings = settingsRef.current;
      if (event.type === "voice.audio.segment") {
        // Audio sintetizado en el servidor: se reproduce en cola, frase a frase.
        cancelFallback(event.generationId);
        // Si el navegador hubiera empezado a hablar (respaldo), se calla: con
        // las dos voces sonando a la vez se oyen dos respuestas superpuestas.
        stopBrowserSpeech();
        if (settings.ttsEnabled && "serverEpoch" in event) {
          playServerSegment(event.audio, event.mimeType, event.generationId, (event as { serverEpoch: number }).serverEpoch, event.text);
        } else if (settings.ttsEnabled) {
          playServerSegment(event.audio, event.mimeType, event.generationId, 0, event.text);
        }
        return;
      }
      if (event.type === "voice.audio.end") {
        cancelFallback(event.generationId);
        return;
      }
      if (event.type === "voice.speaking.started") {
        // El servidor avisa de que empieza la locución. Si él aporta el audio
        // (serverAudio), el cliente NO usa la voz del navegador: se oye una
        // sola voz, la del servidor.
        serverAudio = event.serverAudio === true;
        cancelFallback(event.generationId);
        // Actualizar época del servidor para sincronización de interrupción (P1)
        if ("serverEpoch" in event && typeof event.serverEpoch === "number") {
          setServerEpoch(event.serverEpoch);
        }
        // Locución nueva: el reproductor arranca limpio (lo que quedara de la
        // anterior se descarta, incluido el audio que estuviera sonando).
        resetServerAudio(event.generationId);
        if (!serverAudio) scheduleFallback(event.generationId, "");
        return;
      }
      if (event.type === "voice.output_started") {
        // Respaldo: si no hay audio del servidor, se lee el texto con la voz
        // del navegador.
        if (!serverAudio) scheduleFallback(event.generationId, event.text);
        return;
      }
      if (event.type === "voice.output_stopped") {
        // El evento marca el fin de la GENERACIÓN (el texto ya emitido), no
        // el fin de la LOCUCIÓN. El audio sigue sonando: cancelarlo aquí lo
        // mataba en el instante en que empezaba, y el usuario oía el texto
        // escrito pero ninguna voz. Solo una interrupción exige cortar.
        if (event.reason === "interrupted") {
          // La interrupción tiene que callar TODO: la voz del navegador y el
          // audio del servidor. Si solo se callara una, la otra seguiría
          // hablando la respuesta que el usuario ya canceló.
          stopGeneration(event.generationId);
          // Handshake atómico con el servidor (P1)
          if (sessionId && sendRef.current) {
            void stopServerAudio(sessionId, sendRef.current);
          } else {
            stopServerAudio(); // fallback legacy
          }
        }
        return;
      }
      if (event.type === "tool.started") {
        if (settingsRef.current.uiSounds) beepTool();
        return;
      }
      if (event.type === "tool.awaiting_approval") {
        if (settingsRef.current.uiSounds) beepAttention();
        return;
      }
      if (event.type === "assistant.message_completed") {
        if (settingsRef.current.uiSounds) beepReply();
        return;
      }
      if (
        (event.type === "assistant.state_changed" && event.state === "INTERRUPTED") ||
        event.type === "task.cancelled"
      ) {
        cancelSpeech();
        if (sessionId && sendRef.current) {
          void stopServerAudio(sessionId, sendRef.current);
        } else {
          stopServerAudio(); // fallback legacy
        }
      }
    };

    const send = (command: ClientCommand): boolean => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(command));
        return true;
      } catch {
        return false;
      }
    };

    sendRef.current = send;
    setSendCommand(send);
    setConnection(attempt === 0 ? "connecting" : "reconnecting");

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = backoffDelay(attempt);
      attempt += 1;
      setConnection("reconnecting");
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed || !sessionId) return;
      let url: string;
      try {
        url = buildWebSocketUrl(sessionId, userId);
      } catch {
        setConnection("closed");
        return;
      }

      let current: WebSocket;
      try {
        current = new WebSocket(url, "jarvis.v1");
      } catch {
        scheduleReconnect();
        return;
      }
      socket = current;

      current.onopen = () => {
        if (disposed) return;
        const reconnected = attempt > 0;
        attempt = 0;
        setConnection("open");
        send({ type: "session.describe", sessionId });
        if (reconnected) {
          recordActivity({
            kind: "connection",
            title: "Canal en tiempo real restablecido",
            tone: "success",
          });
        }
      };

      current.onmessage = (message) => {
        if (disposed) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!isServerEvent(parsed)) return;
        const event = parsed;
        // Los eventos globales (salud del sistema) no llevan sessionId: se
        // aceptan para todas las sesiones de la conexión.
        if (event.sessionId && event.sessionId !== sessionId) return;
        const key = eventDedupeKey(event);
        if (dedupe.has(key)) return;
        rememberKey(key);
        applyServerEvent(event);
        handleVoiceEvent(event);
        onPong(event);
      };

      current.onerror = () => {
        if (current.readyState === WebSocket.OPEN) return;
        // El error del socket no se descartaba en silencio: se registra para
        // que la desconexión sea visible en la telemetría.
        recordActivity({
          kind: "connection",
          title: "Fallo en el enlace",
          detail: "El websocket ha emitido un error; se intentará reconectar.",
          tone: "error",
        });
      };

      current.onclose = () => {
        if (disposed) return;
        socket = null;
        setAgentState(null);
        setSendCommand(() => false);
        scheduleReconnect();
      };
    };

    const onOnline = () => {
      if (disposed) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      attempt = 0;
      connect();
    };

    // Chrome no deja reproducir audio hasta que el usuario interactúa con la
    // página. Con un gesto previo, el WAV del servidor sí suena.
    const desbloquear = () => {
      unlockServerAudio();
      window.removeEventListener("pointerdown", desbloquear);
      window.removeEventListener("keydown", desbloquear);
    };
    window.addEventListener("pointerdown", desbloquear);
    window.addEventListener("keydown", desbloquear);

    connect();
    window.addEventListener("online", onOnline);

    const pingInterval = window.setInterval(() => {
      send({ type: "ping" });
    }, 20_000);

    /** RTT real medido con el pong del servidor. */
    const onPong = (event: ServerEvent) => {
      if (event.type !== "pong") return;
      const sent = pendingPings.get(event.serverTime);
      if (sent === undefined) return;
      pendingPings.delete(event.serverTime);
      recordActivity({
        kind: "connection",
        title: "Latencia del enlace",
        detail: `${Math.max(0, Date.now() - sent)} ms`,
        tone: "success",
      });
    };
    const pendingPings = new Map<string, number>();

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pointerdown", desbloquear);
      window.removeEventListener("keydown", desbloquear);
      setBlockedHandler(null);
      window.clearInterval(pingInterval);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
      socket = null;
      cancelSpeech();
      if (sessionId && sendRef.current) {
        void stopServerAudio(sessionId, sendRef.current);
      } else {
        stopServerAudio(); // fallback legacy
      }
      setSendCommand(() => false);
    };
  }, [sessionId, userId, setConnection, setSendCommand, setAgentState, recordActivity]);
}
