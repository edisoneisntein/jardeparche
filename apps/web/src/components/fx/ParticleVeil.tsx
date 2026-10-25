import { useEffect, useMemo, useState } from "react";
import Particles, { ParticlesProvider } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { ISourceOptions } from "@tsparticles/engine";

interface ParticleVeilProps {
  color: string;
  /** Particles speed up while the agent works and drift calmly on idle. */
  intensity: number;
  reducedMotion: boolean;
  /** Velocidad y opacidad reales del velo, dictadas por la máquina de estados. */
  speed?: number;
  opacity?: number;
}

/**
 * PERF-001 · ¿Está la pestaña a la vista?
 *
 * Con la pestaña en segundo plano, las partículas siguen consumiendo GPU sin
 * que nadie las vea. Este hook avisa del cambio de visibilidad para poder
 * detener el render.
 */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    const onChange = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Ambient dust behind the HUD. Purely atmospheric: it carries no state other
 * than how busy the agent is, and it is dropped entirely when the user asks
 * for reduced motion.
 */
export function ParticleVeil({ color, intensity, reducedMotion, speed, opacity }: ParticleVeilProps) {
  const visible = usePageVisible();
  const options = useMemo<ISourceOptions>(() => {
    const busy = Math.max(0, Math.min(1.5, intensity));
    return {
      fullScreen: { enable: false },
      detectRetina: true,
      fpsLimit: 60,
      background: { color: { value: "transparent" } },
      particles: {
        number: { value: Math.round(34 + busy * 26), density: { enable: true, width: 1920, height: 1080 } },
        color: { value: color },
        shape: { type: "circle" },
        opacity: {
          value: { min: 0.04, max: opacity ?? 0.3 },
          animation: { enable: true, speed: 0.4, sync: false, startValue: "random" },
        },
        size: { value: { min: 0.4, max: 2.2 } },
        move: {
          enable: true,
          speed: speed ?? 0.24 + busy * 0.7,
          direction: "top",
          random: true,
          straight: false,
          outModes: { default: "out" },
        },
        links: { enable: false },
      },
      interactivity: { events: { onHover: { enable: false }, onClick: { enable: false } } },
    };
  }, [color, intensity]);

  // Con la pestaña oculta el velo no se dibuja: cero ciclos de GPU.
  if (reducedMotion || !visible) return null;

  return (
    <ParticlesProvider init={loadSlim}>
      <Particles className="particle-veil" options={options} />
    </ParticlesProvider>
  );
}
