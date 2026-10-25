import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../../lib/events";

/**
 * ANILLO 3 · módulos de potencia perimetrales.
 *
 * Va ENCIMA del Anillo 2 (que va sobre el Anillo 1). Es la capa de energía
 * mecánica externa: diez condensadores con pantalla azul y el anillo de
 * circuitos de cobre que los sostiene.
 *
 * El centro queda calado a propósito: por ese hueco sigue viéndose el
 * plasma del Anillo 2 y el núcleo del Anillo 1.
 *
 * Su movimiento NO es de fluido, es de mecanismo:
 *
 *   · Giro a saltos: 36° por muesca (10 módulos = 10 pasos por vuelta),
 *     con la curva de retroceso mecánico al frenar en cada posición.
 *   · Encendido en radar: los 10 módulos se encienden uno a uno en sentido
 *     horario, y luego respiran entre el 40 % en reposo y el 100 % con
 *     glow cuando hay carga.
 *   · Sobrecarga: con el agente trabajando, los paneles dan un destello
 *     blanco-azul y el anillo pasa a giro continuo, más rápido, en sentido
 *     opuesto al Anillo 2.
 *   · Voz: el nivel del micrófono sube el brillo de las pantallas.
 */

/** Los 10 módulos: 10 pasos de 36° dan la vuelta completa. */
const GRADO_PASO = 360 / 10;
/** Estados con carga: el anillo acelera y los paneles saturan. */
const SOBRECARGA: ReadonlySet<string> = new Set(["PLANNING", "EXECUTING", "SPEAKING", "UNDERSTANDING"]);

interface Anillo3Props {
  state: AgentState | null;
  reducedMotion: boolean;
  /** Nivel del micrófono (0..1) para el pico de voz. */
  micLevel: number;
}

export function Anillo3({ state, reducedMotion, micLevel }: Anillo3Props) {
  const [disparo, setDisparo] = useState(0);
  // La calibración: cada cambio de estado da un muesca más de 36°, con el
  // retroceso mecánico al frenar en la posición.
  const [calibracion, setCalibracion] = useState(0);
  const estadoPrevio = useRef<AgentState | null>(state);

  useEffect(() => {
    if (estadoPrevio.current === state) return;
    estadoPrevio.current = state;
    setDisparo((valor) => valor + 1);
    setCalibracion((valor) => valor + GRADO_PASO);
  }, [state]);

  const sobrecarga = state !== null && SOBRECARGA.has(state);
  // El pico de voz: la carga del micro sube el brillo de las pantallas.
  const picoVoz = Math.min(1, Math.max(0, micLevel));
  const colorEstado =
    state === "FAILED" ? "#ff1100" : state === "WAITING_FOR_APPROVAL" ? "#ffaa00" : "#00f0ff";

  return (
    <div
      className="anillo-3"
      data-sobrecarga={sobrecarga ? "true" : "false"}
      data-estado={state ?? "IDLE"}
      data-reducido={reducedMotion ? "true" : "false"}
      style={{
        "--anillo3-color": colorEstado,
        "--anillo3-voz": picoVoz.toFixed(3),
      } as React.CSSProperties}
      aria-hidden="true"
    >
      {/* La muesca de calibración: el retroceso mecánico del mecanismo. */}
      <div className="anillo-3-calibracion" style={{ transform: `rotate(${calibracion}deg)` }}>
      {/* El anillo de circuitos de cobre: gira a saltos con el resto. */}
      <div className="anillo-3-giro" key={`giro-${disparo}`}>
        <img className="anillo-3-cobre" src="/assets/jarvis/reactor/anillo-3-metal.png" alt="" draggable={false} />
        {/* Los 10 módulos: se encienden en radar y respiran con la carga. */}
        <img
          className="anillo-3-modulos"
          key={`modulos-${disparo}`}
          src="/assets/jarvis/reactor/anillo-3-modulos.png"
          alt=""
          draggable={false}
        />
      </div>
      </div>
    </div>
  );
}
