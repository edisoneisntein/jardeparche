/** Mic capture with AudioWorklet - Adaptive VAD (P2). */

import type { VadConfig } from "@jarvis/shared";

interface WorkletToMainMessage {
  type: "level" | "chunk" | "speechStart" | "speechEnd" | "vadState";
  level?: number;
  pcm?: Int16Array;
  threshold?: number;
  noiseFloor?: number;
  isSpeech?: boolean;
}

export interface MicCaptureOptions {
  sampleRate?: number;
  vadConfig?: Partial<VadConfig>;
  onChunk: (pcm: Int16Array) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onError?: (error: Error) => void;
  onVadState?: (state: { threshold: number; noiseFloor: number; isSpeech: boolean }) => void;
}

export interface MicCapture {
  stop(): void;
  level(): number;
  speaking(): boolean;
  updateConfig(config: Partial<VadConfig>): void;
}

const WORKLET_CODE = `
class MicVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Configuración por defecto (sobrescribible vía MessagePort)
    this.attackThresholdRatio = 2.5;
    this.releaseThresholdRatio = 1.8;
    this.minSilenceMs = 600;
    this.noiseFloorAlpha = 0.001;
    this.signalPeakAlpha = 0.1;
    this.minSpeechDurationMs = 250;
    this.warmupMs = 200;
    this.absoluteMinThreshold = 0.006;
    this.absoluteMaxThreshold = 0.08;

    // Estado interno
    this.noiseFloor = 0.005;
    this.signalPeak = 0.01;
    this.threshold = 0.012;
    this.startedAt = currentTime * 1000;
    this.lastVoiceAt = 0;
    this.speechStartedAt = 0;
    this.hadVoice = false;
    this.inWarmup = true;

    this.port.onmessage = (e) => {
      if (e.data.type === 'config') {
        const cfg = e.data.config;
        if (cfg.attackThresholdRatio !== undefined) this.attackThresholdRatio = cfg.attackThresholdRatio;
        if (cfg.releaseThresholdRatio !== undefined) this.releaseThresholdRatio = cfg.releaseThresholdRatio;
        if (cfg.minSilenceMs !== undefined) this.minSilenceMs = cfg.minSilenceMs;
        if (cfg.noiseFloorAlpha !== undefined) this.noiseFloorAlpha = cfg.noiseFloorAlpha;
        if (cfg.signalPeakAlpha !== undefined) this.signalPeakAlpha = cfg.signalPeakAlpha;
        if (cfg.minSpeechDurationMs !== undefined) this.minSpeechDurationMs = cfg.minSpeechDurationMs;
        if (cfg.warmupMs !== undefined) this.warmupMs = cfg.warmupMs;
        if (cfg.absoluteMinThreshold !== undefined) this.absoluteMinThreshold = cfg.absoluteMinThreshold;
        if (cfg.absoluteMaxThreshold !== undefined) this.absoluteMaxThreshold = cfg.absoluteMaxThreshold;
        this.recalculateThreshold();
      } else if (e.data.type === 'reset') {
        this.noiseFloor = 0.005;
        this.signalPeak = 0.01;
        this.startedAt = currentTime * 1000;
        this.lastVoiceAt = 0;
        this.speechStartedAt = 0;
        this.hadVoice = false;
        this.inWarmup = true;
        this.recalculateThreshold();
      }
    };
  }

  recalculateThreshold() {
    const target = this.noiseFloor * this.attackThresholdRatio;
    this.threshold = Math.max(this.absoluteMinThreshold, Math.min(this.absoluteMaxThreshold, target));
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    let sum = 0;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / ch.length);
    const now = currentTime * 1000;

    // Calentamiento inicial: solo actualizar noise floor
    if (this.inWarmup) {
      if (now - this.startedAt >= this.warmupMs) {
        this.inWarmup = false;
      }
      // Durante warmup, actualizar noise floor agresivamente
      this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorAlpha * 10) + rms * this.noiseFloorAlpha * 10;
      this.recalculateThreshold();
      this.port.postMessage({ type: 'level', level: Math.min(1, rms * 6) });
      return true;
    }

    // Actualizar noise floor solo cuando NO hay voz (EMA lento)
    if (!this.hadVoice || rms < this.threshold) {
      this.noiseFloor = this.noiseFloor * (1 - this.noiseFloorAlpha) + rms * this.noiseFloorAlpha;
    }

    // Actualizar pico de señal cuando HAY voz (EMA rápido)
    if (rms > this.noiseFloor * 1.2) {
      this.signalPeak = this.signalPeak * (1 - this.signalPeakAlpha) + rms * this.signalPeakAlpha;
    }

    // Recalcular umbral con histéresis
    this.recalculateThreshold();

    // Level normalizado para UI (0-1)
    const level = Math.min(1, rms / Math.max(this.threshold * 2, 0.02));
    this.port.postMessage({ type: 'level', level });

    const isVoice = rms >= this.threshold;

    if (isVoice) {
      this.lastVoiceAt = now;
      if (!this.hadVoice) {
        this.hadVoice = true;
        this.speechStartedAt = now;
        this.port.postMessage({ type: 'speechStart' });
      }
      // Enviar chunk de audio
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'chunk', pcm }, [pcm.buffer]);
    } else if (this.hadVoice) {
      // Verificar fin de habla: silencio sostenido + duración mínima
      const silenceDuration = now - this.lastVoiceAt;
      const speechDuration = now - this.speechStartedAt;
      if (silenceDuration >= this.minSilenceMs && speechDuration >= this.minSpeechDurationMs) {
        this.hadVoice = false;
        this.port.postMessage({ type: 'speechEnd' });
      }
    }

    // Emitir estado VAD para telemetría (cada ~100ms)
    if (Math.random() < 0.01) {
      this.port.postMessage({
        type: 'vadState',
        threshold: this.threshold,
        noiseFloor: this.noiseFloor,
        isSpeech: this.hadVoice,
      });
    }

    return true;
  }
}

registerProcessor('mic-vad-processor', MicVadProcessor);
`;

function workletUrl(): string {
  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

export async function startMicCapture(options: MicCaptureOptions): Promise<MicCapture> {
  const sampleRate = options.sampleRate ?? 16000;
  const vadConfig = options.vadConfig ?? {};

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let stopped = false;
  let level = 0;
  let hadVoice = false;

  const capture = new Promise<MicCapture>(async (resolve, reject) => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (stopped) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = media;
      ctx = new AudioContext({ sampleRate });
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(media);
      const sink = ctx.createGain();
      sink.gain.value = 0;

      await ctx.audioWorklet.addModule(workletUrl());
      workletNode = new AudioWorkletNode(ctx, "mic-vad-processor");

      // Enviar configuración VAD inicial
      workletNode.port.postMessage({ type: "config", config: vadConfig });

      workletNode.port.onmessage = (e) => {
        if (stopped) return;
        const m = e.data as WorkletToMainMessage;
        if (m.type === "level" && m.level !== undefined) level = m.level;
        else if (m.type === "chunk" && m.pcm) options.onChunk(m.pcm);
        else if (m.type === "speechStart") {
          hadVoice = true;
          options.onSpeechStart();
        } else if (m.type === "speechEnd") {
          hadVoice = false;
          options.onSpeechEnd();
        } else if (m.type === "vadState" && options.onVadState && m.threshold !== undefined && m.noiseFloor !== undefined && m.isSpeech !== undefined) {
          options.onVadState({ threshold: m.threshold, noiseFloor: m.noiseFloor, isSpeech: m.isSpeech });
        }
      };

      src.connect(workletNode);
      workletNode.connect(sink);
      sink.connect(ctx.destination);

      resolve({
        stop() {
          if (stopped) return;
          stopped = true;
          try {
            workletNode?.disconnect();
            workletNode?.port.close();
          } catch {}
          stream?.getTracks().forEach((t) => t.stop());
          ctx?.close().catch(() => {});
        },
        level: () => level,
        speaking: () => hadVoice,
        updateConfig(config: Partial<VadConfig>) {
          workletNode?.port.postMessage({ type: "config", config });
        },
      });
    } catch (err) {
      reject(err as Error);
    }
  });

  return capture;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}