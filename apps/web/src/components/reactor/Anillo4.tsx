import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../../lib/events";

/**
 * ANILLO 4 · jaula de potencia exterior.
 *
 * La capa más externa: una jaula oscura con 8 módulos azules. Sus módulos
 * están a 45°, la MISMA fase que las 8 pestañas del Anillo 1, así que
 * ambos se alinean radialmente y la máquina se lee como una sola pieza.
 *
 * Movimiento (guion de la capa de energía mecánica externa):
 *
 *   · Contrarrotación: gira al revés y un 50 % más rápido que el Anillo 3
 *     (−27°/s contra +18°/s), con curvas ease-in-out no sincronizadas: el
 *     leve deslizamiento por inercia antes de acoplarse.
 *   · Levitación: oscila unos píxeles en Z, como si flotara sobre el
 *     chasis, y en carga se acerca y se retira.
 *   · Chase: los 8 módulos se encienden uno a uno en sentido horario.
 *   · Destello de intersección: cada vez que un módulo cruza una
 *     estructura clave del Anillo 3, un fogonazo entre los dos anillos.
 *   · Arcos eléctricos: chispas entre la jaula y el Anillo 3.
 */

const ESCALA = 1.61;
/** Radio de la jaula en % del semiradio de la caja. */
const RADIO_MODULOS = 88;

/** Estados con carga: la jaula se acerca y se separa. */
const CARGA: ReadonlySet<string> = new Set(["LISTENING", "UNDERSTANDING", "PLANNING", "EXECUTING", "SPEAKING"]);

interface Anillo4Props {
  state: AgentState | null;
  reducedMotion: boolean;
  /** Color de los módulos y de las chispas. */
  color: string;
}

export function Anillo4({ state, reducedMotion, color }: Anillo4Props) {
  const [disparo, setDisparo] = useState(0);
  const estadoPrevio = useRef<AgentState | null>(state);

  useEffect(() => {
    if (estadoPrevio.current === state) return;
    estadoPrevio.current = state;
    setDisparo((valor) => valor + 1);
  }, [state]);

  const carga = state !== null && CARGA.has(state);

  return (
    <div
      className="anillo-4"
      data-carga={carga ? "true" : "false"}
      data-reducido={reducedMotion ? "true" : "false"}
      style={
        {
          "--anillo4-escala": ESCALA,
          "--anillo4-color": color,
          "--anillo4-radio": `${RADIO_MODULOS}%`,
        } as React.CSSProperties
      }
      aria-hidden="true"
    >
      {/* La jaula: gira al revés y más rápido que el Anillo 3. */}
      <div className="anillo-4-giro" key={disparo}>
        {/* La levitación va en un nivel aparte: si compartiera elemento
            con la rotación, una transformacion pisaria a la otra. */}
        <div className="anillo-4-flota">
        <img
          className="anillo-4-estructura"
          src="/assets/jarvis/reactor/anillo-4-estructura.png"
          alt=""
          draggable={false}
        />
        <img
          className="anillo-4-leds"
          key={`leds-${disparo}`}
          src="/assets/jarvis/reactor/anillo-4-leds.png"
          alt=""
          draggable={false}
        />
        <img
          className="anillo-4-glow"
          src="/assets/jarvis/reactor/anillo-4-glow.png"
          alt=""
          draggable={false}
        />
        </div>
      </div>

      {/* Las chispas entre la jaula y el Anillo 3. */}
      {!reducedMotion ? (
        <svg className="anillo-4-arcos" viewBox="0 0 100 100" preserveAspectRatio="none">
          {Array.from({ length: 5 }, (_, i) => (
            <path
              key={i}
              className="anillo-4-arco"
              style={{ animationDelay: `${i * 0.63}s` }}
              d="M 50 6 L 53 12 L 49 17 L 52 23 L 50 29"
            />
          ))}
        </svg>
      ) : null}
    </div>
  );
}
