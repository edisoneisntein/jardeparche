import { useEffect, useRef } from "react";
import { getAudioFrame, retainAudio } from "../../lib/audioEngine";
import { subscribeVoiceSpectrum } from "../../lib/voiceSpectrum";
import type { AgentState } from "../../lib/events";

interface VoiceVisualizerProps {
  active: boolean;
  speaking: boolean;
  state: AgentState | null;
  color: string;
  reducedMotion: boolean;
}

const BARS = 84;
const TAU = Math.PI * 2;

function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return `rgba(94, 215, 255, ${alpha})`;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Microphone spectrum ring drawn around the reactor.
 *
 * It only draws measured data while the microphone is open. When the assistant
 * is speaking through the browser's speech synthesiser there is no audio API
 * that exposes that signal, so instead of inventing a spectrum it shows a
 * clearly different "transmit" pulse.
 */
export function VoiceVisualizer({ active, speaking, state, color, reducedMotion }: VoiceVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array>(new Float32Array(BARS));
  const smoothRef = useRef<Float32Array>(new Float32Array(BARS));
  /** Envolvente real de la voz de JARVIS (RMS de las muestras del WAV). */
  const vozRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let release: (() => void) | null = null;
    if (active) release = retainAudio();

    // La voz que se está sintetizando se dibuja en el anillo: es el
    // envolvente real del audio, no una señal inventada.
    const cancelarVoz = subscribeVoiceSpectrum((barras) => {
      vozRef.current = barras;
    });

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let frameId = 0;
    let elapsed = 0;

    const draw = (time: number) => {
      const seconds = time / 1000;
      const delta = Math.min(0.05, seconds - elapsed);
      elapsed = seconds;

      const frame = getAudioFrame();
      const bins = active ? frame.bands : new Uint8Array(0);
      const binCount = frame.binCount;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const base = Math.min(width, height) / 2;
      const outer = base * 0.94;
      const barBase = base * 0.74;
      const maxBar = base * 0.26;
      const spin = reducedMotion ? 0 : seconds * 0.12;

      const glow = active ? 0.55 + frame.level * 0.45 : speaking ? 0.42 : 0.24;

      const halo = context.createRadialGradient(cx, cy, base * 0.1, cx, cy, base);
      halo.addColorStop(0, withAlpha(color, 0.001));
      halo.addColorStop(0.55, withAlpha(color, glow * 0.1));
      halo.addColorStop(0.86, withAlpha(color, glow * 0.2));
      halo.addColorStop(1, withAlpha(color, 0));
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);

      context.save();
      context.translate(cx, cy);

      // Outer tick ring.
      context.save();
      context.rotate(spin);
      context.strokeStyle = withAlpha(color, 0.45);
      context.lineWidth = 1.2;
      for (let index = 0; index < 96; index += 1) {
        const angle = (index / 96) * TAU;
        const major = index % 8 === 0;
        const inner = outer - (major ? 13 : 6);
        context.globalAlpha = major ? 0.85 : 0.4;
        context.beginPath();
        context.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        context.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        context.stroke();
      }
      context.restore();

      // Counter-rotating dashed ring.
      context.save();
      context.rotate(-spin * 1.7);
      context.setLineDash([2, 10]);
      context.strokeStyle = withAlpha(color, 0.5);
      context.lineWidth = 1.4;
      context.beginPath();
      context.arc(0, 0, outer - 22, 0, TAU);
      context.stroke();
      context.restore();

      // Spectrum / idle bars.
      context.save();
      for (let index = 0; index < BARS; index += 1) {
        const t = index / BARS;
        const angle = t * TAU - Math.PI / 2;

        let value: number;
        if (active && binCount > 0) {
          const ratio = index / BARS;
          const source = Math.min(binCount - 1, Math.floor(Math.pow(ratio, 1.35) * binCount * 0.62));
          const magnitude = (bins[source] ?? 0) / 255;
          const target = Math.min(1, magnitude * 1.25);
          const previous = smoothRef.current[index] ?? 0;
          const eased = previous + (target - previous) * (target > previous ? 0.55 : 0.16);
          smoothRef.current[index] = eased;
          value = eased;
        } else if (speaking && vozRef.current.length > 0) {
          // JARVIS está hablando: se dibuja el envolvente real de su voz.
          const objetivo = vozRef.current[index] ?? 0;
          const previous = smoothRef.current[index] ?? 0;
          const eased = previous + (objetivo - previous) * (objetivo > previous ? 0.6 : 0.22);
          smoothRef.current[index] = eased;
          value = eased;
        } else {
          // Sin micrófono abierto NO hay señal que dibujar. Antes se generaba
          // un espectro con un seno: era un dato sintético presentado como
          // medición. Ahora el anillo queda plano (inactivo) y, si el
          // asistente habla, se dibuja su voz real.
          value = 0;
        }

        const length = maxBar * (0.12 + value * 0.88);
        const x0 = Math.cos(angle) * barBase;
        const y0 = Math.sin(angle) * barBase;
        const x1 = Math.cos(angle) * (barBase + length);
        const y1 = Math.sin(angle) * (barBase + length);

        if (active && binCount > 0) {
          const retired = Math.max(0, (peaksRef.current[index] ?? 0) - delta * 0.55);
          peaksRef.current[index] = Math.max(retired, value);
        }

        const hayVoz = speaking && vozRef.current.length > 0 && !active;
        context.strokeStyle = withAlpha(color, active ? 0.28 + value * 0.6 : hayVoz ? 0.34 + value * 0.62 : 0.22 + value * 0.35);
        context.lineWidth = Math.max(1.4, (TAU * barBase) / BARS / 2.6);
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
        context.stroke();

        if (active && binCount > 0) {
          const peak = peaksRef.current[index] ?? 0;
          if (peak > 0.08) {
            const px = Math.cos(angle) * (barBase + maxBar * (0.12 + peak * 0.88));
            const py = Math.sin(angle) * (barBase + maxBar * (0.12 + peak * 0.88));
            context.fillStyle = withAlpha(color, 0.5);
            context.beginPath();
            context.arc(px, py, 1.5, 0, TAU);
            context.fill();
          }
        }
      }
      context.restore();

      // Waveform ring, only for live microphone data.
      if (active && frame.wave.length > 0) {
        context.save();
        context.rotate(spin * 0.4);
        context.strokeStyle = withAlpha(color, 0.75);
        context.lineWidth = 1.6;
        context.beginPath();
        const samples = 120;
        for (let index = 0; index <= samples; index += 1) {
          const ratio = index / samples;
          const angle = ratio * TAU;
          const sample = frame.wave[Math.floor(ratio * (frame.wave.length - 1))] ?? 0;
          const radius = base * 0.52 + sample * base * 0.16;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
        context.globalAlpha = 0.5 + frame.level * 0.5;
        context.stroke();
        context.restore();
      }

      // Sweep wedge while the agent is thinking.
      if (state === "UNDERSTANDING" || state === "PLANNING") {
        const sweep = reducedMotion ? 0 : (seconds * 1.6) % TAU;
        context.save();
        context.rotate(sweep);
        const wedge = context.createLinearGradient(0, 0, outer, 0);
        wedge.addColorStop(0, withAlpha(color, 0));
        wedge.addColorStop(1, withAlpha(color, 0.35));
        context.fillStyle = wedge;
        context.beginPath();
        context.moveTo(0, 0);
        context.arc(0, 0, outer, -0.24, 0.24);
        context.closePath();
        context.fill();
        context.restore();
      }

      // Transmit pulses while speaking.
      if (speaking && !reducedMotion) {
        context.save();
        for (let index = 0; index < 3; index += 1) {
          const phase = (seconds * 0.9 + index / 3) % 1;
          context.strokeStyle = withAlpha(color, (1 - phase) * 0.55);
          context.lineWidth = 2 * (1 - phase) + 0.4;
          context.beginPath();
          context.arc(0, 0, base * (0.32 + phase * 0.6), 0, TAU);
          context.stroke();
        }
        context.restore();
      }

      // Core bloom.
      const core = context.createRadialGradient(0, 0, 0, 0, 0, base * (active ? 0.4 + frame.level * 0.16 : 0.34));
      core.addColorStop(0, withAlpha(color, active ? 0.5 + frame.level * 0.3 : 0.34));
      core.addColorStop(1, withAlpha(color, 0));
      context.fillStyle = core;
      context.beginPath();
      context.arc(0, 0, base * (active ? 0.4 + frame.level * 0.16 : 0.34), 0, TAU);
      context.fill();

      context.restore();
      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      release?.();
      cancelarVoz();
    };
  }, [active, speaking, state, color, reducedMotion]);

  return <canvas ref={canvasRef} className="voice-viz-canvas" aria-hidden="true" />;
}
