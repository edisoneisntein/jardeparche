import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecognitionOptions {
  language: string;
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onSpeechStart: () => void;
  onError: (message: string) => void;
}

export interface SpeechRecognitionState {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
  /** Código crudo del último error del motor (null si no hay). Útil para la UI. */
  errorCode: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Silencia el micrófono conservando la intención de escucha. */
  pause: () => void;
  /** Reactiva el micrófono pausado. */
  resume: () => void;
}

function getConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** Errores fatales: cortan la sesión y no deben auto-reintentar. */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

function describeError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Micrófono bloqueado: permítelo en el candado del sitio (usa http://localhost, no una IP LAN).";
    case "audio-capture":
      return "No se detecta ningún micrófono.";
    case "network":
      return "Error de red en el reconocimiento de voz.";
    case "no-speech":
      return ""; // no es un error real para el usuario; el motor sigue escuchando
    case "aborted":
      return "";
    default:
      return code ? `Error de voz: ${code}` : "";
  }
}

type Phase = "idle" | "starting" | "running";

/**
 * Chrome marca `isFinal` en pausas mínimas del medio de un enunciado
 * ("según" → pause → "que me digas"). Sin coalescer, enviamos fragmentos
 * como mensajes completos y JARVIS se conversa solo. Los finales se
 * acumulan y solo se emiten tras FLUSH_MS de silencio.
 */
const FLUSH_MS = 1300;

export function useSpeechRecognition(options: SpeechRecognitionOptions): SpeechRecognitionState {
  const supported = getConstructor() !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const wantRef = useRef(false);
  /** Micrófono silenciado temporalmente (p. ej. mientras suena el TTS). */
  const pausedRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Permite que onend programe un reinicio con una instancia NUEVA sin auto-referencia
  // declarativa (evita TDZ y garantiza que siempre se llame a la última definición).
  const startRef = useRef<() => void>(() => {});
  // Finales pendientes de coalescer (ver FLUSH_MS).
  const pendingFinalsRef = useRef<string[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  const clearRestart = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const clearFlush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // Une y emite los finales acumulados. Llamar solo tras silencio o al cerrar sesión.
  const flushPending = useCallback(() => {
    clearFlush();
    const pending = pendingFinalsRef.current;
    pendingFinalsRef.current = [];
    if (pending.length === 0) return;
    const text = pending.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    optionsRef.current.onFinal(text);
  }, [clearFlush]);

  const scheduleFlush = useCallback(() => {
    clearFlush();
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushPending();
    }, FLUSH_MS);
  }, [clearFlush, flushPending]);

  // Descarta la instancia actual de forma segura. WebKit no admite reutilizar una
  // misma webkitSpeechRecognition tras stop()/abort(), así que siempre se libera
  // y la siguiente sesión construye una instancia limpia (patrón factoría).
  const dispose = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    phaseRef.current = "idle";
    clearFlush();
    if (!recognition) return;
    recognition.onstart = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    recognition.onspeechstart = null;
    try {
      recognition.abort();
    } catch {
      /* ya detenida */
    }
  }, [clearFlush]);

  const start = useCallback(() => {
    const Constructor = getConstructor();
    if (!Constructor) {
      setError("voz no disponible en este navegador");
      setErrorCode("unsupported");
      return;
    }
    // Control de concurrencia: .start() lanza InvalidStateError si ya está
    // starting/running en ambos motores (Blink y WebKit).
    if (phaseRef.current !== "idle" || recognitionRef.current !== null) return;
    if (!mountedRef.current) return;

    clearRestart();
    setError(null);
    setErrorCode(null);
    setInterim("");
    wantRef.current = true;

    // Factoría: instancia nueva por sesión.
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = optionsRef.current.language || "es-ES";

    recognition.onstart = () => {
      if (!mountedRef.current) return;
      phaseRef.current = "running";
      setListening(true);
      setError(null);
      setErrorCode(null);
    };

    recognition.onspeechstart = () => {
      optionsRef.current.onSpeechStart();
    };

    recognition.onresult = (event) => {
      if (!mountedRef.current) return;
      let interimText = "";
      let gotFinal = false;
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) {
          const piece = alternative.transcript.trim();
          if (piece) {
            pendingFinalsRef.current.push(piece);
            gotFinal = true;
          }
        } else {
          interimText += alternative.transcript;
        }
      }
      if (interimText) {
        setInterim(interimText);
        optionsRef.current.onInterim(interimText);
      }
      if (gotFinal) {
        setInterim("");
        // No emitimos aún: Chrome fragmenta enunciados con pausas internas.
        // Acumulamos y solo flushemos tras FLUSH_MS de silencio.
        scheduleFlush();
      }
    };

    recognition.onerror = (event) => {
      if (!mountedRef.current) return;
      const code = event.error ?? "unknown";
      phaseRef.current = "idle";
      setListening(false);
      setErrorCode(code);
      const message = describeError(code);
      if (message) {
        setError(message);
        optionsRef.current.onError(message);
      }
      if (FATAL_ERRORS.has(code)) {
        wantRef.current = false;
      }
    };

    recognition.onend = () => {
      if (!mountedRef.current) return;
      // La sesión murió: no llegará más nada de esta instancia. Emitimos lo
      // pendiente para no perder lo que el usuario llegó a decir.
      flushPending();
      phaseRef.current = "idle";
      setListening(false);
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      // Auto-reinicio con instancia NUEVA (no se reutiliza la zombi). Solo si
      // el usuario sigue queriendo escuchar, no fue un error fatal y el
      // micrófono no está pausado (p. ej. por el TTS en curso).
      if (wantRef.current && !pausedRef.current) {
        clearRestart();
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (wantRef.current && mountedRef.current) startRef.current();
        }, 250);
      }
    };

    recognitionRef.current = recognition;
    phaseRef.current = "starting";

    try {
      recognition.start();
    } catch (err) {
      // Sin enmascarar: InvalidStateError u otros se dejan trazables.
      recognitionRef.current = null;
      phaseRef.current = "idle";
      setListening(false);
      const message = err instanceof Error ? err.message : String(err);
      setError(`No se pudo iniciar el reconocimiento: ${message}`);
      setErrorCode("start-failed");
      console.error("[jarvis] SpeechRecognition.start() falló:", err);
    }
  }, [clearRestart]);

  startRef.current = start;

  const stop = useCallback(() => {
    wantRef.current = false;
    clearRestart();
    setListening(false);
    setInterim("");
    // El usuario cortó a mano: emitimos lo acumulado antes de liberar.
    flushPending();
    dispose();
  }, [clearRestart, dispose, flushPending]);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start();
  }, [start, stop]);

  /**
   * Silencia el micrófono sin perder la intención de escucha.
   *
   * Es el corte de eco: mientras el sintetizador del navegador habla, el
   * micrófono abierto capta la propia voz del agente y la devuelve como
   * pregunta nueva (el agente terminaba respondiéndose a sí mismo).
   */
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      /* ya detenida */
    }
    recognitionRef.current = null;
    phaseRef.current = "idle";
    setListening(false);
    setInterim("");
    // Lo acumulado se descarta: es audio nuestro, no del usuario.
    pendingFinalsRef.current = [];
    clearFlush();
  }, [clearFlush]);

  /** Reactiva el micrófono si el usuario seguía queriendo escuchar. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    if (wantRef.current && mountedRef.current) start();
  }, [start]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      wantRef.current = false;
      clearRestart();
      clearFlush();
      dispose();
    };
  }, [clearRestart, clearFlush, dispose]);

  return { supported, listening, interim, error, errorCode, start, stop, toggle, pause, resume };
}
