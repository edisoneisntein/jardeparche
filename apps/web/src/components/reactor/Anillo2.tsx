import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../../lib/events";
import { animoDeEstado } from "./estados";

/**
 * ANILLO 2 · corona de acero con LED y campo de plasma.
 *
 * Se apoya ENCIMA del Anillo 1, encajado en su hueco con su proporción
 * (escala 0,649: su acero, de radio 496 px sobre 1280, entra justo en el
 * hueco del Anillo 1, de radio 322 px).
 *
 * El guion de animación pide tres capas, y aquí son cuatro porque los LED
 * necesitan su propio recorte para el barrido de encendido:
 *
 *   · A · CORONA (acero + LED): gira en sentido horario, con inercia. Su
 *     velocidad depende del estado: lenta en reposo, más viva trabajando.
 *   · B · PLASMA: el campo de energía gira al revés y más rápido que el
 *     metal: es un fluido contenido, no una pieza.
 *   · C · GLOW: el resplandor, con parpadeo de voltaje.
 *   · D · LED: los diodos, que se encienden en barrido circular.
 *
 * Y tres momentos de estado:
 *
 *   · Encaje (snap-in): escala 95 % → 100 % con rebote elástico.
 *   · Barrido: los LED se encienden uno detrás de otro, en radar.
 *   · Onda de choque: un anillo concéntrico se expande al cambiar de estado.
 */

const ESCALA = 0.649;
/** Estados con carga: la corona se acelera y el plasma arde más. */
const ACTIVOS: ReadonlySet<string> = new Set(["PLANNING", "EXECUTING", "SPEAKING", "UNDERSTANDING"]);

interface Anillo2Props {
  state: AgentState | null;
  reducedMotion: boolean;
}

export function Anillo2({ state, reducedMotion }: Anillo2Props) {
  // Cada cambio de estado dispara el encendido: encaje, barrido y onda.
  const [disparo, setDisparo] = useState(0);
  const estadoPrevio = useRef<AgentState | null>(state);

  useEffect(() => {
    if (estadoPrevio.current === state) return;
    estadoPrevio.current = state;
    setDisparo((valor) => valor + 1);
  }, [state]);

  const activo = state !== null && ACTIVOS.has(state);
  const animo = animoDeEstado(state);
  const colorEstado =
    state === "FAILED" ? "#ff1100" : state === "WAITING_FOR_APPROVAL" ? "#ffaa00" : "#00f0ff";
  // El plasma se comprime mientras el núcleo carga y se expande al hablar.
  const escalaPlasma = state === "LISTENING" || state === "UNDERSTANDING" || state === "PLANNING" ? 0.85 : 1;
  // El glow no tiene agujero: es el que se expande al hablar.
  const escalaGlow = state === "SPEAKING" ? 1.12 : 1;

  return (
    <div
      className="anillo-2"
      data-activo={activo ? "true" : "false"}
      data-reducido={reducedMotion ? "true" : "false"}
      data-estado={state ?? "IDLE"}
      style={
        {
          "--anillo2-escala": ESCALA,
          "--anillo2-color": colorEstado,
          "--plasma-escala": escalaPlasma,
          "--glow-escala": escalaGlow,
          "--plasma-color": animo.plasma,
          "--plasma-tinte": animo.tinte,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {/* El encaje elástico: el anillo entra y se asienta en su sitio. */}
      <div className="anillo-2-encaje" key={disparo}>
        {/* A · CORONA: metal y LED, en sentido horario. */}
        <div className="anillo-2-corona">
          <img className="anillo-2-metal" src="/assets/jarvis/reactor/anillo-2-metal.png" alt="" draggable={false} />
          <img
            className="anillo-2-leds"
            key={`leds-${disparo}`}
            src="/assets/jarvis/reactor/anillo-2-leds.png"
            alt=""
            draggable={false}
          />
        </div>

        {/* B · PLASMA: el campo de energía, al revés y más rápido. */}
        <div className="anillo-2-campo">
          <img className="anillo-2-plasma" src="/assets/jarvis/reactor/anillo-2-plasma.png" alt="" draggable={false} />
          {/* C · GLOW: el resplandor con parpadeo. */}
          <img className="anillo-2-glow" src="/assets/jarvis/reactor/anillo-2-glow.png" alt="" draggable={false} />
        </div>

        {/* La onda de choque del encendido. */}
        <div className="anillo-2-onda" key={`onda-${disparo}`} />
      </div>
    </div>
  );
}
