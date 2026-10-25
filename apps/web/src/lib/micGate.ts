/**
 * Diagnóstico de la cadena de captura de micrófono.
 *
 * El reconocimiento de voz del navegador solo funciona en un CONTEXTO SEGURO
 * (origen `localhost`/`127.0.0.1` por HTTP, o cualquier origen por HTTPS).
 * Una IP de red local por HTTP no es un origen confiable: Chrome no expone
 * `navigator.mediaDevices` y bloquea el micrófono sin posibilidad de permiso.
 *
 * Antes esta app traducía todos los fallos a "micrófono bloqueado, revisa los
 * ajustes del sitio", lo que es FALSO para un origen inseguro: no hay ningún
 * ajuste que lo arregle. Aquí se distingue cada causa con su remedio real.
 */

export type MicGateState =
  /** Todo listo: contexto seguro, API de voz presente y permiso no bloqueado. */
  | "ready"
  /** Origen no confiable: Chrome no expone el micrófono en este origen. */
  | "insecure-origin"
  /** El navegador tiene un bloqueo persistente del micrófono para este sitio. */
  | "permission-blocked"
  /** El navegador no implementa la Web Speech API. */
  | "no-speech-api"
  /** Estado todavía sin determinar (aún consultando permisos). */
  | "unknown";

export type MicRemedy =
  /** Nada que hacer: el micrófono está operativo. */
  | "none"
  /** Abrir la misma aplicación en un origen confiable del propio equipo. */
  | "use-localhost"
  /** Reanudar el permiso en los ajustes del sitio del navegador. */
  | "site-settings";

export interface MicEnvironment {
  /** `window.isSecureContext`: true si el origen es confiable para el navegador. */
  isSecureContext: boolean;
  /** Existe `navigator.mediaDevices.getUserMedia`. */
  hasMediaDevices: boolean;
  /** Existe `SpeechRecognition` o `webkitSpeechRecognition`. */
  hasSpeechRecognition: boolean;
  /** Estado del permiso de micrófono segun la Permissions API. */
  permission: "granted" | "denied" | "prompt" | "unknown";
  /** Origen actual, por ejemplo `http://192.168.1.8:5173`. */
  origin: string;
}

export interface MicGate {
  state: MicGateState;
  /** Causa técnica en una línea, sin adjetivos. */
  reason: string;
  /** Acción que resuelve el bloqueo, si existe. */
  remedy: MicRemedy;
  /** URL local equivalente cuando el Remedy es `use-localhost`. */
  localUrl: string | null;
  /** Instrucción accionable para la interfaz. */
  guidance: string;
  /** Estado real del permiso de micrófono en el navegador. */
  permission: MicEnvironment["permission"];
}

/** Orígenes que Chrome considera confiables sin necesidad de HTTPS. */
const TRUSTED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Equivalente local de un origen de red local: misma ruta y puerto, host
 * `localhost`. Devuelve `null` si el origen ya es confiable o no se puede mapear.
 */
export function localEquivalentUrl(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (TRUSTED_HOSTS.has(url.hostname)) return null;
  const local = new URL(url.toString());
  local.hostname = "localhost";
  return local.toString();
}

/**
 * Clasifica el estado del micrófono a partir de una instantánea del entorno.
 * Función pura: no toca el DOM, así que es verificable por tests.
 */
export function evaluateMicGate(env: MicEnvironment): MicGate {
  const localUrl = localEquivalentUrl(env.origin);

  if (!env.hasSpeechRecognition) {
    return {
      state: "no-speech-api",
      reason: "El navegador no implementa la Web Speech API (SpeechRecognition).",
      remedy: "none",
      localUrl: null,
      permission: env.permission,
      guidance:
        "Usa Chrome, Edge o Safari de escritorio. En Firefox la Web Speech API no está disponible para recognition de voz.",
    };
  }

  if (!env.isSecureContext || !env.hasMediaDevices) {
    return {
      state: "insecure-origin",
      reason: `El origen ${env.origin} no es un contexto seguro: Chrome no expone navigator.mediaDevices y bloquea el micrófono sin posibilidad de permiso.`,
      remedy: localUrl ? "use-localhost" : "site-settings",
      localUrl,
      permission: env.permission,
      guidance: localUrl
        ? `Abre la aplicación en ${localUrl}: el navegador solo concede el micrófono en orígenes de confianza (localhost o HTTPS).`
        : "Sirve la aplicación por HTTPS o accede a ella desde el propio equipo mediante localhost.",
    };
  }

  if (env.permission === "denied") {
    return {
      state: "permission-blocked",
      reason: "El navegador tiene un bloqueo persistente del micrófono para este sitio.",
      remedy: "site-settings",
      localUrl: null,
      permission: env.permission,
      guidance:
        "Haz clic en el icono de bloqueo de la barra de direcciones, abre «Micrófono» y elige «Permitir». Después pulsa «Reintentar».",
    };
  }

  return {
    state: "ready",
    reason: "Contexto seguro, Web Speech API disponible y sin bloqueo de permiso.",
    remedy: "none",
    localUrl: null,
    permission: env.permission,
    guidance: "",
  };
}

/** Lee el estado real del navegador. La Permissions API es asíncrona. */
export async function readMicEnvironment(): Promise<MicEnvironment> {
  if (typeof window === "undefined") {
    return {
      isSecureContext: false,
      hasMediaDevices: false,
      hasSpeechRecognition: false,
      permission: "unknown",
      origin: "",
    };
  }
  let permission: MicEnvironment["permission"] = "unknown";
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    permission =
      status?.state === "granted" ? "granted" : status?.state === "denied" ? "denied" : status?.state === "prompt" ? "prompt" : "unknown";
  } catch {
    permission = "unknown";
  }
  return {
    isSecureContext: window.isSecureContext === true,
    hasMediaDevices: typeof navigator.mediaDevices?.getUserMedia === "function",
    hasSpeechRecognition: Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition),
    permission,
    origin: window.location?.origin ?? "",
  };
}
