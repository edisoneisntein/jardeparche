import type { ComponentHealth } from "@jarvis/shared";

export interface VoiceProviderInfo {
  stt: string;
  tts: string;
  /** The browser provides STT/TTS via Web Speech API; the server only relays. */
  browserSupported: boolean;
  notes: string;
}

export interface VoiceStatus extends VoiceProviderInfo {
  health: ComponentHealth;
}

/**
 * Voice orchestration lives mostly in the browser (Web Speech API). The server
 * is responsible for truthful status reporting and for correlating voice
 * events with agent tasks so stale audio can be cancelled.
 */
export class VoiceService {
  constructor(
    private readonly options: {
      sttProvider: string;
      ttsProvider: string;
    },
  ) {}

  providers(): VoiceProviderInfo {
    const browser = this.options.sttProvider === "browser" && this.options.ttsProvider === "browser";
    return {
      stt: this.options.sttProvider,
      tts: this.options.ttsProvider,
      browserSupported: browser,
      notes: browser
        ? "El reconocimiento y la síntesis se ejecutan en el navegador (Web Speech API). El servidor no puede garantizar disponibilidad desde el backend."
        : `Proveedor STT=${this.options.sttProvider}, TTS=${this.options.ttsProvider} configurado en el servidor.`,
    };
  }

  status(): VoiceStatus {
    const providers = this.providers();
    return {
      ...providers,
      health: {
        component: "voice",
        // Cannot be verified server-side for browser providers: honest "unknown".
        status: providers.browserSupported ? "unknown" : "degraded",
        detail: providers.notes,
        checkedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * Tracks the currently speaking response per session so that a new turn or an
 * interrupt cancels the previous generation instead of finishing it late.
 */
export class SpeechGenerationTracker {
  private readonly current = new Map<string, string>();

  start(sessionId: string, taskId: string): string {
    const generationId = `${sessionId}:${taskId}:${Date.now()}`;
    this.current.set(sessionId, generationId);
    return generationId;
  }

  isCurrent(sessionId: string, generationId: string): boolean {
    return this.current.get(sessionId) === generationId;
  }

  stop(sessionId: string): string | undefined {
    const previous = this.current.get(sessionId);
    this.current.delete(sessionId);
    return previous;
  }
}
