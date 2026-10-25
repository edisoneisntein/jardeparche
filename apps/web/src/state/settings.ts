export interface JarvisSettings {
  userId: string;
  voiceURI: string;
  language: string;
  /** Palabra de activación: si está presente, se quita del comando. */
  wakeWord: string;
  /**
   * Si es `true`, la palabra de activación es OBLIGATORIA: sin ella el turno
   * se descarta. Si es `false`, cualquier enunciado es un comando (conversación
   * por voz natural) y la palabra de activación solo se elimina si aparece.
   */
  requireWakeWord: boolean;
  /**
   * De dónde viene la transcripción:
   *   `browser` → Web Speech API del navegador (por defecto).
   *   `server`  → el navegador captura el audio y lo transcribe el servidor.
   *                Si el servidor no puede, cae al navegador.
   */
  voiceAsrMode: "browser" | "server";
  reducedMotion: boolean;
  cameraEnabled: boolean;
  ttsEnabled: boolean;
  /** Pitidos de interfaz (tech beeps del HUD). */
  uiSounds: boolean;
  /** Configuración del VAD adaptativo (P2). */
  vadConfig: {
    attackThresholdRatio: number;
    releaseThresholdRatio: number;
    minSilenceMs: number;
    noiseFloorAlpha: number;
    signalPeakAlpha: number;
    minSpeechDurationMs: number;
    warmupMs: number;
    absoluteMinThreshold: number;
    absoluteMaxThreshold: number;
  };
}

export const DEFAULT_VAD_CONFIG = {
  attackThresholdRatio: 2.5,
  releaseThresholdRatio: 1.8,
  minSilenceMs: 600,
  noiseFloorAlpha: 0.001,
  signalPeakAlpha: 0.1,
  minSpeechDurationMs: 250,
  warmupMs: 200,
  absoluteMinThreshold: 0.006,
  absoluteMaxThreshold: 0.08,
};

export const DEFAULT_SETTINGS: JarvisSettings = {
  userId: "local",
  voiceURI: "",
  language: "es-ES",
  wakeWord: "jarvis",
  // Por defecto la palabra de activación NO es obligatoria: el chat de voz
  // natural es el caso de uso principal y exigirla descartaba los turnos.
  requireWakeWord: false,
  voiceAsrMode: "browser",
  reducedMotion: false,
  cameraEnabled: true,
  ttsEnabled: true,
  uiSounds: true,
  vadConfig: DEFAULT_VAD_CONFIG,
};

const STORAGE_KEY = "jarvis.web.settings.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function loadSettings(): JarvisSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_SETTINGS };
    const vadConfig = isRecord(parsed.vadConfig) ? parsed.vadConfig : {};
    return {
      userId: typeof parsed.userId === "string" && parsed.userId ? parsed.userId : DEFAULT_SETTINGS.userId,
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : DEFAULT_SETTINGS.voiceURI,
      language: typeof parsed.language === "string" && parsed.language ? parsed.language : DEFAULT_SETTINGS.language,
      wakeWord: typeof parsed.wakeWord === "string" ? parsed.wakeWord : DEFAULT_SETTINGS.wakeWord,
      // Un ajuste guardado antes de existir la opción hereda el valor por
      // defecto: la palabra de activación deja de ser obligatoria.
      requireWakeWord:
        typeof parsed.requireWakeWord === "boolean" ? parsed.requireWakeWord : DEFAULT_SETTINGS.requireWakeWord,
      voiceAsrMode: parsed.voiceAsrMode === "server" ? "server" : DEFAULT_SETTINGS.voiceAsrMode,
      reducedMotion:
        typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
      cameraEnabled:
        typeof parsed.cameraEnabled === "boolean" ? parsed.cameraEnabled : DEFAULT_SETTINGS.cameraEnabled,
      ttsEnabled: typeof parsed.ttsEnabled === "boolean" ? parsed.ttsEnabled : DEFAULT_SETTINGS.ttsEnabled,
      uiSounds: typeof parsed.uiSounds === "boolean" ? parsed.uiSounds : DEFAULT_SETTINGS.uiSounds,
      vadConfig: {
        attackThresholdRatio: typeof vadConfig.attackThresholdRatio === "number" ? vadConfig.attackThresholdRatio : DEFAULT_VAD_CONFIG.attackThresholdRatio,
        releaseThresholdRatio: typeof vadConfig.releaseThresholdRatio === "number" ? vadConfig.releaseThresholdRatio : DEFAULT_VAD_CONFIG.releaseThresholdRatio,
        minSilenceMs: typeof vadConfig.minSilenceMs === "number" ? vadConfig.minSilenceMs : DEFAULT_VAD_CONFIG.minSilenceMs,
        noiseFloorAlpha: typeof vadConfig.noiseFloorAlpha === "number" ? vadConfig.noiseFloorAlpha : DEFAULT_VAD_CONFIG.noiseFloorAlpha,
        signalPeakAlpha: typeof vadConfig.signalPeakAlpha === "number" ? vadConfig.signalPeakAlpha : DEFAULT_VAD_CONFIG.signalPeakAlpha,
        minSpeechDurationMs: typeof vadConfig.minSpeechDurationMs === "number" ? vadConfig.minSpeechDurationMs : DEFAULT_VAD_CONFIG.minSpeechDurationMs,
        warmupMs: typeof vadConfig.warmupMs === "number" ? vadConfig.warmupMs : DEFAULT_VAD_CONFIG.warmupMs,
        absoluteMinThreshold: typeof vadConfig.absoluteMinThreshold === "number" ? vadConfig.absoluteMinThreshold : DEFAULT_VAD_CONFIG.absoluteMinThreshold,
        absoluteMaxThreshold: typeof vadConfig.absoluteMaxThreshold === "number" ? vadConfig.absoluteMaxThreshold : DEFAULT_VAD_CONFIG.absoluteMaxThreshold,
      },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: JarvisSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return;
  }
}

export function stripWakeWord(text: string, wakeWord: string): { command: string; armed: boolean } {
  const trimmed = text.trim();
  const wake = wakeWord.trim().toLowerCase();
  if (!wake) return { command: trimmed, armed: false };
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(wake)) return { command: trimmed, armed: false };
  const remainder = trimmed.slice(wake.length).replace(/^[\s,.:;!?¿¡-]+/, "");
  return { command: remainder, armed: true };
}
