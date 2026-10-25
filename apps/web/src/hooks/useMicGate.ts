import { useCallback, useEffect, useRef, useState } from "react";
import { evaluateMicGate, readMicEnvironment, type MicGate } from "../lib/micGate";

export interface MicGateState {
  gate: MicGate;
  /** Vuelve a consultar el entorno y recalcula el diagnóstico. */
  recheck: () => Promise<void>;
}

/**
 * Mantiene el diagnóstico del micrófono sincronizado con el navegador.
 * Se recalcula al montar y cada vez que el motor de voz reporta un error
 * (un `not-allowed` puede aparecer después del primer clic).
 */
export function useMicGate(errorCode: string | null): MicGateState {
  const [gate, setGate] = useState<MicGate>(() =>
    evaluateMicGate({
      isSecureContext: typeof window !== "undefined" ? window.isSecureContext === true : false,
      hasMediaDevices: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
      hasSpeechRecognition:
        typeof window !== "undefined" && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition),
      permission: "unknown",
      origin: typeof window !== "undefined" ? window.location.origin : "",
    }),
  );
  const alive = useRef(true);

  const recheck = useCallback(async () => {
    const env = await readMicEnvironment();
    if (!alive.current) return;
    setGate(evaluateMicGate(env));
  }, []);

  useEffect(() => {
    alive.current = true;
    void recheck();
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [recheck]);

  useEffect(() => {
    if (errorCode) void recheck();
  }, [errorCode, recheck]);

  return { gate, recheck };
}
