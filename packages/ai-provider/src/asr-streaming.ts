import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

/**
 * Proveedor de ASR Streaming (P3) - WebSocket full-duplex con modelos RNN-T.
 *
 * Protocolo NVIDIA Riva / NIM Streaming ASR:
 * - Conexión WebSocket a /v1/audio/transcriptions/stream
 * - Envío inicial de configuración JSON
 * - Envío continuo de chunks PCM 16-bit 16kHz mono
 * - Recepción de hipótesis parciales y finales
 */

export interface StreamingAsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  sampleRate?: number;
  encoding?: "linear16" | "mulaw" | "alaw";
  interimResults?: boolean;
  punctuate?: boolean;
}

export interface StreamingAsrResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  startTime?: number;
  endTime?: number;
}

export interface StreamingAsrProvider {
  readonly name: string;
  readonly config: StreamingAsrConfig;
  connect(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  onTranscript: (callback: (result: StreamingAsrResult) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  onClose: (callback: () => void) => void;
  disconnect(): void;
  isConnected(): boolean;
}

/**
 * Implementación para NVIDIA Riva / NIM Streaming ASR via WebSocket.
 */
export class NvidiaStreamingAsrProvider extends EventEmitter implements StreamingAsrProvider {
  readonly name = "nvidia-asr-streaming";
  readonly config: StreamingAsrConfig;
  private ws: WebSocket | null = null;
  private transcriptCallback?: (result: StreamingAsrResult) => void;
  private errorCallback?: (error: Error) => void;
  private closeCallback?: () => void;
  private connected = false;
  private connecting = false;

  constructor(config: StreamingAsrConfig) {
    super();
    this.config = {
      sampleRate: 16000,
      encoding: "linear16",
      interimResults: true,
      punctuate: true,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;

    this.connecting = true;
    const wsUrl = `${this.config.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v1/audio/transcriptions/stream`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        });

        this.ws.onopen = () => {
          this.connected = true;
          this.connecting = false;
          // Enviar configuración inicial
          this.sendConfig();
          resolve();
        };

        this.ws.onmessage = (event: { data: WebSocket.Data }) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (event: { message?: string; error?: Error }) => {
          const err = new Error(`WebSocket error: ${event.message ?? event.error?.message ?? "unknown"}`);
          this.errorCallback?.(err);
          if (this.connecting) {
            this.connecting = false;
            reject(err);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.connecting = false;
          this.closeCallback?.();
        };
      } catch (error) {
        this.connecting = false;
        reject(error);
      }
    });
  }

  private sendConfig(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        config: {
          model: this.config.model,
          language: this.config.language ?? "es-ES",
          sample_rate: this.config.sampleRate,
          encoding: this.config.encoding,
          interim_results: this.config.interimResults,
          punctuate: this.config.punctuate,
        },
      }),
    );
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      // Formato esperado de NVIDIA Riva Streaming ASR
      if (message.results && Array.isArray(message.results)) {
        for (const result of message.results) {
          if (result.alternatives && result.alternatives.length > 0) {
            const alt = result.alternatives[0];
            const transcript: StreamingAsrResult = {
              text: alt.transcript ?? "",
              isFinal: result.is_final ?? false,
              confidence: alt.confidence,
              startTime: result.start_time,
              endTime: result.end_time,
            };
            this.transcriptCallback?.(transcript);
          }
        }
      } else if (message.transcript !== undefined) {
        // Formato alternativo
        const transcript: StreamingAsrResult = {
          text: message.transcript,
          isFinal: message.is_final ?? false,
          confidence: message.confidence,
        };
        this.transcriptCallback?.(transcript);
      }
    } catch {
      // Ignorar mensajes no parseables
    }
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  onTranscript(callback: (result: StreamingAsrResult) => void): void {
    this.transcriptCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  onClose(callback: () => void): void {
    this.closeCallback = callback;
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Factory para crear el proveedor de ASR apropiado según el modelo.
 */
export function createStreamingAsrProvider(config: StreamingAsrConfig): StreamingAsrProvider {
  return new NvidiaStreamingAsrProvider(config);
}