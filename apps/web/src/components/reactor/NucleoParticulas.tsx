import { useEffect, useRef } from "react";
import type { AgentState } from "../../lib/events";
import { getAudioFrame, isAudioActive } from "../../lib/audioEngine";
import { voiceSpectrum } from "../../lib/voiceSpectrum";
import { flujoDeEstado } from "./estados";

/**
 * EMISOR DE PARTÍCULAS DEL NÚCLEO.
 *
 * Los orbes de luz eléctrica que alimentan el núcleo:
 *
 *   · IMPLOSIÓN (escuchando / procesando): las partículas nacen en el borde
 *     exterior de los anillos y son ATRAÍDAS hacia el centro de gravedad
 *     (X0, Y0). Cuanto más cerca del núcleo, más rápido aceleran: la
 *     energía se está comprimiendo en un punto crítico antes de la descarga.
 *   · EXPLOSIÓN (hablando): la carga se libera. Una ráfaga sale disparada
 *     desde el centro, y su velocidad la marca el grave de la voz.
 *   · CALMA: apenas un reguero lento, para que el núcleo nunca esté muerto.
 *
 * La amplitud del micrófono (implosión) y el espectro de la voz (explosión)
 * modulan el motor en tiempo real.
 *
 * Dibuja con `lighter` (aditivo) sobre un lienzo transparente: las estelas
 * se suman a la luz del metal en vez de taparla.
 */

interface Particula {
  x: number;
  y: number;
  vx: number;
  vy: number;
  vida: number;
  tam: number;
  /** Cola de luz: las últimas posiciones por las que ha pasado. */
  cola: number[];
}

/** Puntos que guarda cada partícula para dibujar su estela. */
const COLA = 18;

interface NucleoParticulasProps {
  state: AgentState | null;
  /** Color de las estelas (del estado de ánimo). */
  color: string;
  /** Nivel del micrófono 0..1. */
  micLevel: number;
  /** Si JARVIS está hablando. */
  voz: boolean;
  reducedMotion: boolean;
}

const MAXIMO = 420;

export function NucleoParticulas({ state, color, micLevel, voz, reducedMotion }: NucleoParticulasProps) {
  const lienzoRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef(color);
  colorRef.current = color;
  // El nivel del micro va por ref: si fuera dependencia del efecto, cada
  // muestra reiniciaria el motor de partículas.
  const microRef = useRef(micLevel);
  microRef.current = micLevel;

  useEffect(() => {
    const lienzo = lienzoRef.current;
    if (!lienzo) return;
    const ctx = lienzo.getContext("2d");
    if (!ctx) return;

    let ancho = 0;
    let alto = 0;
    const ajustar = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const caja = lienzo.parentElement?.getBoundingClientRect();
      ancho = Math.round(caja?.width ?? 0);
      alto = Math.round(caja?.height ?? 0);
      lienzo.width = Math.round(ancho * dpr);
      lienzo.height = Math.round(alto * dpr);
      lienzo.style.width = `${ancho}px`;
      lienzo.style.height = `${alto}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    ajustar();

    const observador = new ResizeObserver(ajustar);
    if (lienzo.parentElement) observador.observe(lienzo.parentElement);

    if (reducedMotion) {
      ctx.clearRect(0, 0, ancho, alto);
      return () => observador.disconnect();
    }

    const particulas: Particula[] = [];
    let acumulador = 0;
    let absorbidas = 0;
    let ultimo = performance.now();
    let raf = 0;

    const centro = (): { x: number; y: number } => ({ x: ancho / 2, y: alto / 2 });
    const radio = (): number => Math.min(ancho, alto) * 0.42;

    const crear = (angulo: number, velocidad: number): Particula => {
      const c = centro();
      const r = radio();
      const x = c.x + Math.cos(angulo) * r;
      const y = c.y + Math.sin(angulo) * r;
      return {
        x,
        y,
        vx: -Math.cos(angulo) * velocidad,
        vy: -Math.sin(angulo) * velocidad,
        vida: 1,
        tam: 2.1 + Math.random() * 2.6,
        cola: [x, y],
      };
    };

    const tic = (ahora: number): void => {
      const dt = Math.min(0.05, (ahora - ultimo) / 1000);
      ultimo = ahora;
      const c = centro();
      const R = radio();
      const flujo = flujoDeEstado(state);
      const micro = isAudioActive() ? Math.max(getAudioFrame().level, microRef.current) : microRef.current;
      const barras = voiceSpectrum();
      const graves = barras.length ? (barras[0] ?? 0) + (barras[1] ?? 0) : 0;
      const agudos = barras.length ? (barras[barras.length - 1] ?? 0) : 0;
      // Nivel global de la voz de JARVIS: el envolvente de sus muestras.
      let energiaVoz = 0;
      for (let i = 0; i < barras.length; i += 1) energiaVoz += barras[i] ?? 0;
      const nivelVoz = barras.length ? energiaVoz / barras.length : 0;

      ctx.clearRect(0, 0, ancho, alto);
      ctx.globalCompositeOperation = "lighter";

      // ── Emisión ──────────────────────────────────────────────────────
      if (flujo === "IMPLOSION") {
        acumulador += dt * (30 + micro * 60);
        while (acumulador >= 1 && particulas.length < MAXIMO) {
          acumulador -= 1;
          particulas.push(crear(Math.random() * Math.PI * 2, 26 + micro * 40));
        }
      } else if (flujo === "EXPLOSION") {
        acumulador += dt * (2 + agudos * 26);
        while (acumulador >= 1 && particulas.length < MAXIMO) {
          acumulador -= 1;
          const angulo = Math.random() * Math.PI * 2;
          const p = crear(angulo, 0);
          // La ráfaga nace en el centro, no en el borde.
          p.x = c.x + (Math.random() - 0.5) * R * 0.12;
          p.y = c.y + (Math.random() - 0.5) * R * 0.12;
          p.cola = [p.x, p.y];
          const v = 40 + graves * 190 + agudos * 60 + nivelVoz * 70;
          p.vx = Math.cos(angulo) * v;
          p.vy = Math.sin(angulo) * v;
          particulas.push(p);
        }
      } else {
        acumulador += dt * 2.4;
        while (acumulador >= 1 && particulas.length < MAXIMO) {
          acumulador -= 1;
          particulas.push(crear(Math.random() * Math.PI * 2, 9));
        }
      }

      // ── Física y dibujo ─────────────────────────────────────────────
      const tono = colorRef.current;
      for (let i = particulas.length - 1; i >= 0; i -= 1) {
        const p = particulas[i];
        if (!p) continue;
        p.cola.push(p.x, p.y);
        if (p.cola.length > COLA * 2) p.cola.splice(0, 2);

        const dx = c.x - p.x;
        const dy = c.y - p.y;
        const d = Math.hypot(dx, dy) || 1;

        if (flujo === "IMPLOSION") {
          // Atracción newtoniana (1/r^2): la partícula acelera al
          // acercarse, que es lo que lee como compresión hacia el foco.
          // La constante está calibrada para que cruce el anillo en ~1,2 s.
          const fuerza = (9.2e6 + micro * 26e6) / (d * d);
          p.vx += (dx / d) * fuerza * dt;
          p.vy += (dy / d) * fuerza * dt;
        } else if (flujo === "EXPLOSION") {
          p.vx += (dx / d) * 26 * dt;
          p.vy += (dy / d) * 26 * dt;
        }
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        if (flujo === "IMPLOSION") {
          // Al llegar al centro, la partícula se disuelve y carga el núcleo.
          if (d < R * 0.14) {
            absorbidas = Math.min(1, absorbidas + 0.05);
            particulas.splice(i, 1);
            continue;
          }
          p.vida = Math.min(1, d / (R * 0.42));
        } else {
          p.vida -= dt * (flujo === "EXPLOSION" ? 0.85 : 0.35);
          if (p.vida <= 0 || d > R * 1.25) {
            particulas.splice(i, 1);
            continue;
          }
        }

        // La estela: la cola completa, desvaneciéndose por la cola.
        const alfa = p.vida * (flujo === "IMPLOSION" ? 0.95 : 0.7);
        ctx.strokeStyle = tono;
        ctx.lineCap = "round";
        ctx.lineWidth = p.tam;
        ctx.beginPath();
        ctx.moveTo(p.cola[0] ?? p.x, p.cola[1] ?? p.y);
        for (let k = 2; k < p.cola.length; k += 2) {
          ctx.lineTo(p.cola[k] ?? p.x, p.cola[k + 1] ?? p.y);
        }
        ctx.globalAlpha = alfa * 0.7;
        ctx.stroke();
        // La cabeza, brillante.
        ctx.globalAlpha = alfa;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.tam * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── El núcleo se carga de lo que absorbe ───────────────────────
      if (absorbidas > 0.001) {
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R * 0.3);
        g.addColorStop(0, tono);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalAlpha = absorbidas * 0.5;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, R * 0.3, 0, Math.PI * 2);
        ctx.fill();
        absorbidas *= 0.94;
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(tic);
    };

    raf = requestAnimationFrame(tic);
    return () => {
      cancelAnimationFrame(raf);
      observador.disconnect();
    };
  }, [state, voz, reducedMotion]);

  return <canvas ref={lienzoRef} className="nucleo-particulas" aria-hidden="true" />;
}
