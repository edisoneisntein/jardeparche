import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ConnectionState } from "../lib/events";
import { useJarvisStore } from "../state/jarvisStore";
import type { MicGate } from "../lib/micGate";
import { cancelSpeech } from "../lib/tts";
import { pcmToBase64, startMicCapture, type MicCapture } from "../lib/micCapture";
import { stripWakeWord, DEFAULT_VAD_CONFIG } from "../state/settings";
import { useMicGate } from "./useMicGate";
import { useMicLevel } from "./useMicLevel";
import { useSpeechRecognition, type SpeechRecognitionState } from "./useSpeechRecognition";

export type MicPermission = "unknown" | "granted" | "denied" | "unavailable";

export interface DictationController extends SpeechRecognitionState {
  micLevel: number;
  wakeArmed: boolean;
  wakeWord: string;
  micPermission: MicPermission;
  /** Diagnóstico de la cadena de captura: distingue origen inseguro de bloqueo de permiso. */
  gate: MicGate;
  /** Recalcula el diagnóstico del micrófono. */
  recheckMic: () => Promise<void>;
  ensurePermission: () => Promise<boolean>;
  toggle: () => void;
  /** Actualiza la configuración del VAD adaptativo en caliente. */
  updateVadConfig: (config: Partial<typeof DEFAULT_VAD_CONFIG>) => void;
}

const FATAL_PERMISSION_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

export function useDictation(input: {
  sessionId: string | null;
  connection: ConnectionState;
  language: string;
  wakeWord: string;
  /** Si es `true`, la palabra de activación es obligatoria para enviar el turno. */
  requireWakeWord: boolean;
  /** Origen de la transcripción: navegador o servidor. */
  voiceAsrMode: "browser" | "server";
  sendCommand: (command: ClientCommand) => boolean;
  onFinalTranscript: (text: string) => void;
  onVoiceError: (message: string) => void;
}): DictationController {
  const [wakeArmed, setWakeArmed] = useState(false);
  const [micPermission, setMicPermission] = useState<MicPermission>("unknown");
  const inputRef = useRef(input);
  inputRef.current = input;

  const recognition = useSpeechRecognition({
    language: input.language,
    onInterim: () => undefined,
    onSpeechStart: () => {
      cancelSpeech();
    },
    onError: (message) => inputRef.current.onVoiceError(message),
    onFinal: (text) => {
      const current = inputRef.current;
      if (ttsSpeakingRef.current) return;
      const { command, armed } = stripWakeWord(text, current.wakeWord);
      setWakeArmed(armed);
      if (!command) return;
      // La palabra de activación solo es obligatoria si el usuario lo pide
      // (`requireWakeWord`). Por defecto el chat de voz es natural: cualquier
      // enunciado es un comando y la palabra, si aparece, se elimina.
      const wakeRequired = current.requireWakeWord && current.wakeWord.trim().length > 0;
      if (wakeRequired && !armed) {
        current.onVoiceError(`Esperando «${current.wakeWord}»`);
        return;
      }
      if (!current.sessionId || current.connection !== "open") {
        // Antes el comando se descartaba en silencio: el usuario hablaba y no
        // sabía por qué no pasaba nada.
        current.onVoiceError("Sin enlace con el núcleo: la orden no se ha enviado.");
        return;
      }
      // El comando viaja como transcripción final: el servidor abre el turno
      // con él (docs/api.md). El cliente NO envía además un chat.send, o se
      // ejecutarían dos turnos por la misma frase.
      const sent = current.sendCommand({
        type: "voice.transcript",
        sessionId: current.sessionId,
        text: command,
        final: true,
      });
      if (sent) current.onFinalTranscript(command);
    },
  });

  const { gate, recheck } = useMicGate(recognition.errorCode);
  const captureRef = useRef<MicCapture | null>(null);
  const serverAsrRef = useRef(false);
  const micLevel = useMicLevel(recognition.listening);
  const ttsSpeaking = useJarvisStore((state) => state.ttsSpeaking);

  // CORTE DE ECO: con el micrófono abierto, el sintetizador del navegador
  // es captado por el propio reconocedor y vuelve como pregunta nueva. El
  // agente terminaba respondiéndose a sí mismo (y contestando con la hora que
  // él mismo acababa de decir). Mientras suena la voz, el micrófono se
  // silencia y se reactiva al terminar.
  useEffect(() => {
    if (ttsSpeaking) {
      recognition.pause();
      return;
    }
    recognition.resume();
  }, [ttsSpeaking, recognition]);

  // Segunda red de seguridad: un final que llega mientras se habla es
  // nuestra propia voz, no la del usuario.
  const ttsSpeakingRef = useRef(false);
  ttsSpeakingRef.current = ttsSpeaking;

  // El permiso se DERIVA del diagnóstico: un origen no seguro no es lo mismo
  // que un bloqueo de permisos, y cada causa tiene su remedio.
  useEffect(() => {
    if (gate.state === "no-speech-api" || gate.state === "insecure-origin") {
      setMicPermission("unavailable");
      return;
    }
    if (gate.state === "permission-blocked" || (recognition.errorCode && FATAL_PERMISSION_ERRORS.has(recognition.errorCode))) {
      setMicPermission("denied");
      return;
    }
    if (recognition.listening || gate.permission === "granted") {
      setMicPermission("granted");
    }
  }, [gate.state, gate.permission, recognition.supported, recognition.listening, recognition.errorCode]);

  // Consulta NO destructiva (Permissions API) para sembrar el estado inicial en la UI.
  // NO toca el hardware ni roba el gesto de usuario: el micrófono real lo pide el
  // motor de SpeechRecognition dentro de recognition.start() (llamado en el onClick).
  const ensurePermission = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) {
      return true;
    }
    try {
      const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (status.state === "denied") {
        setMicPermission("denied");
        return false;
      }
      if (status.state === "granted") {
        setMicPermission("granted");
      }
      return true;
    } catch {
      // Safari puede no soportar 'microphone' en Permissions API; no bloqueamos.
      return true;
    }
  }, []);

  // CRÍTICO: recognition.start() se invoca SÍNCRONAMENTE dentro del gesto del usuario
  // (onClick). No hay await ni getUserMedia previo, así que se conserva la
  // user-activation transitoria que Chrome y Safari exigen para arrancar el motor
  // y solicitar/usar el micrófono.
  const toggle = useCallback(() => {
    if (!recognition.supported) {
      inputRef.current.onVoiceError("voz no disponible en este navegador");
      setMicPermission("unavailable");
      return;
    }
    // Si el origen no es confiable o el navegador bloquea el sitio, arrancar el
    // motor solo produce un error: no se intenta y el aviso accionable resuelve.
    if (gate.state === "insecure-origin" || gate.state === "permission-blocked") {
      void recheck();
      return;
    }
    if (recognition.listening || captureRef.current) {
      recognition.stop();
      captureRef.current?.stop();
      captureRef.current = null;
      return;
    }
    cancelSpeech();
    if (inputRef.current.voiceAsrMode === "server") {
      void startServerCapture();
      return;
    }
    recognition.start();
  }, [recognition, gate.state, recheck]);

  /**
   * Captura del micrófono para el ASR del servidor: el navegador manda el
   * PCM y el servidor decide el final de la intervención (VAD de energía) y
   * transcribe. Si el servidor no puede transcribir, avisa y se usa el
   * reconocedor del navegador.
   */
  const startServerCapture = useCallback(async () => {
    const current = inputRef.current;
    if (!current.sessionId || current.connection !== "open") {
      current.onVoiceError("Sin enlace con el núcleo: no se puede grabar.");
      return;
    }
    const settings = useJarvisStore.getState().settings;
    try {
      const capture = await startMicCapture({
        vadConfig: settings.vadConfig ?? DEFAULT_VAD_CONFIG,
        onChunk: (pcm) => {
          current.sendCommand({
            type: "voice.audio.chunk",
            sessionId: current.sessionId as string,
            pcm: pcmToBase64(pcm),
          });
        },
        onSpeechStart: () => {
          cancelSpeech();
        },
        onSpeechEnd: () => {
          current.sendCommand({ type: "voice.audio.flush", sessionId: current.sessionId as string });
        },
        onError: (error) => current.onVoiceError(`No se pudo abrir el micrófono: ${error.message}`),
      });
      captureRef.current = capture;
      serverAsrRef.current = true;
    } catch (error) {
      current.onVoiceError(`No se pudo abrir el micrófono: ${(error as Error).message}`);
    }
  }, []);

  return {
    ...recognition,
    micLevel,
    wakeArmed,
    wakeWord: input.wakeWord,
    micPermission,
    gate,
    recheckMic: recheck,
    ensurePermission,
    toggle,
    updateVadConfig: (config: Partial<typeof DEFAULT_VAD_CONFIG>) => {
      captureRef.current?.updateConfig(config);
    },
  };
}
