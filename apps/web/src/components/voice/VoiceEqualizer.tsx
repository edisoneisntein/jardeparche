import { useEffect, useRef } from "react";
import { getAudioFrame, retainAudio } from "../../lib/audioEngine";
import { subscribeVoiceSpectrum } from "../../lib/voiceSpectrum";

interface VoiceEqualizerProps {
  /** El micrófono está abierto: se dibuja el espectro real de la entrada. */
  active: boolean;
  /** JARVIS está hablando: se dibuja el envolvente real de su voz. */
  speaking: boolean;
  color: string;
  reducedMotion: boolean;
}

const BARRAS = 64;

/**
 * Ecualizador de la "boca" del núcleo.
 *
 * Es la banda de la máscara de Iron Man: cuando hablas se enciende con tu voz
 * y cuando habla JARVIS se enciende con **la voz sintetizada** (el envolvente
 * real de las muestras del WAV, no una señal inventada).
 */
export function VoiceEqualizer({ active, speaking, color, reducedMotion }: VoiceEqualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const suaveRef = useRef<Float32Array>(new Float32Array(BARRAS));
  const vozRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let liberar: (() => void) | null = null;
    if (active) liberar = retainAudio();
    const cancelarVoz = subscribeVoiceSpectrum((barras) => {
      vozRef.current = barras;
    });

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const redimensionar = () => {
      const caja = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(caja.width * dpr));
      canvas.height = Math.max(1, Math.round(caja.height * dpr));
    };
    redimensionar();
    const observador = new ResizeObserver(redimensionar);
    observador.observe(canvas);

    let cuadro = 0;
    let ultimo = performance.now();

    const dibujar = (ahora: number) => {
      cuadro = requestAnimationFrame(dibujar);
      const delta = Math.min(0.05, (ahora - ultimo) / 1000);
      ultimo = ahora;

      const caja = canvas.getBoundingClientRect();
      const ancho = caja.width;
      const alto = caja.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, ancho, alto);

      const marco = getAudioFrame();
      const voz = vozRef.current;
      const usandoVoz = !active && speaking && voz.length > 0;

      const separacion = 3;
      const grosor = Math.max(1.5, (ancho - separacion * (BARRAS - 1)) / BARRAS);

      for (let indice = 0; indice < BARRAS; indice += 1) {
        let objetivo = 0;
        if (active && marco.binCount > 0) {
          const proporcion = indice / BARRAS;
          const origen = Math.min(marco.binCount - 1, Math.floor(Math.pow(proporcion, 1.3) * marco.binCount * 0.6));
          objetivo = Math.min(1, (marco.bands[origen] ?? 0) / 255);
        } else if (usandoVoz) {
          // El envolvente de la voz: se recorre del centro hacia los bordes.
          const proporcion = indice / BARRAS;
          const centro = Math.abs(proporcion - 0.5) * 2;
          const fuente = Math.min(voz.length - 1, Math.floor(centro * (voz.length - 1)));
          objetivo = Math.min(1, (voz[fuente] ?? 0) * (1 - centro * 0.35));
        } else {
          objetivo = 0;
        }

        const previo = suaveRef.current[indice] ?? 0;
        const valor = previo + (objetivo - previo) * (objetivo > previo ? 0.5 : 0.18);
        suaveRef.current[indice] = valor;

        const altura = Math.max(2, valor * alto * 0.94);
        const x = indice * (grosor + separacion);
        const y = (alto - altura) / 2;

        const gradiente = ctx.createLinearGradient(0, y, 0, y + altura);
        gradiente.addColorStop(0, `${color}00`);
        gradiente.addColorStop(0.5, `${color}${active || usandoVoz ? "cc" : "33"}`);
        gradiente.addColorStop(1, `${color}00`);
        ctx.fillStyle = gradiente;
        ctx.fillRect(x, y, grosor, altura);

        if (valor > 0.06) {
          ctx.fillStyle = `${color}55`;
          ctx.fillRect(x, y - 1, grosor, 1.5);
          ctx.fillRect(x, y + altura - 0.5, grosor, 1.5);
        }
        void delta;
      }
    };

    if (!reducedMotion) {
      cuadro = requestAnimationFrame(dibujar);
    } else {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    }

    return () => {
      cancelAnimationFrame(cuadro);
      observador.disconnect();
      liberar?.();
      cancelarVoz();
    };
  }, [active, speaking, color, reducedMotion]);

  return <canvas ref={canvasRef} className="voice-equalizer" aria-hidden="true" />;
}
