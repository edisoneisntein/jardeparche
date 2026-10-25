import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../../lib/events";

/**
 * ANILLO 1 · armadura exterior.
 *
 * La estructura pesada de acero industrial con sus 8 pestillos magnéticos.
 * No es un anillo que lleve energía: es el que la CONTIENE. Por eso se
 * mueve con inercia de masa, no con la velocidad de los anillos internos.
 *
 *   · Rotación base: 0,2 RPM (una vuelta cada 5 minutos) en sentido horario.
 *     Se ve maciza, arrastrada.
 *   · Calibración: al cambiar el estado del agente, el anillo da un
 *     micro-giro de 36° en dentos —un salto de precisión— para realinear
 *     los pestillos.
 *   · Pestillos: cada uno se mueve por su cuenta. Se retiran hacia fuera y
 *     después presionan hacia dentro, como una compresión hidráulica.
 *   · Sellado: con carga alta, todo el cuerpo se hunde en Z para apoyarse
 *     contra los anillos interiores.
 *   · Luz pasiva: no lleva luces propias. El acero bruñido solo devuelve
 *     los destellos cian que llegan de los anillos 2 y 3 por detrás.
 *
 * Las medidas salen del propio render (1280×1280, centro en 640,640):
 * el cuerpo ocupa el 100 % y el pestillo es una ventana de 148 px
 * (11,5625 %) cuyo centro cae a un 37,5 % del radio.
 */

const PESTILLOS = 8;
const PASO_PESTILLOS = 45;
const PASO_CALIBRACION = 36;
/** 0,2 RPM → 300 s por vuelta. */
const ROTACION_BASE_SEGUNDOS = 300;
/** Estados con carga: el anillo se sella contra los anillos interiores. */
const CARGA_ALTA: ReadonlySet<string> = new Set(["PLANNING", "EXECUTING", "SPEAKING", "UNDERSTANDING"]);

interface Anillo1Props {
  state: AgentState | null;
  reducedMotion: boolean;
}

export function Anillo1({ state, reducedMotion }: Anillo1Props) {
  const [calibracion, setCalibracion] = useState(0);
  const estadoPrevio = useRef<AgentState | null>(state);

  // Cada cambio de estado provoca un escalón de calibración.
  useEffect(() => {
    if (estadoPrevio.current === state) return;
    estadoPrevio.current = state;
    setCalibracion((valor) => valor + PASO_CALIBRACION);
  }, [state]);

  const carga = state !== null && CARGA_ALTA.has(state);
  const colorEstado =
    state === "FAILED" ? "#ff1100" : state === "WAITING_FOR_APPROVAL" ? "#ffaa00" : "#00f0ff";

  return (
    <div className="anillo-1" data-carga={carga ? "alta" : "baja"} aria-hidden="true">
      {/* Rotación continua: inercia pesada, una vuelta cada 5 minutos. */}
      <div
        className="anillo-1-rotacion"
        style={reducedMotion ? undefined : { animationDuration: `${ROTACION_BASE_SEGUNDOS}s` }}
      >
        {/* Calibración: los escalones que alinean los pestillos. */}
        <div className="anillo-1-calibracion" style={{ transform: `rotate(${calibracion}deg)` }}>
          {/* El cuerpo de acero, sin los pestillos: esos van aparte para
              poder moverse por su cuenta. */}
          <img className="anillo-1-cuerpo" src="/assets/jarvis/reactor/anillo-1-cuerpo.png" alt="" draggable={false} />

          {Array.from({ length: PESTILLOS }, (_, indice) => (
            <div
              key={indice}
              className="anillo-1-pestillo"
              style={{
                transform: `rotate(${indice * PASO_PESTILLOS}deg)`,
                // Escalonado: se mueven uno detrás de otro, no en bloque.
                animationDelay: reducedMotion ? undefined : `${indice * 55}ms`,
              }}
            >
              <div className="anillo-1-pestillo-mov">
                <div className="anillo-1-pestillo-tiro">
                  <img
                    className="anillo-1-pestillo-img"
                    src="/assets/jarvis/reactor/anillo-1-pestillo.png"
                    alt=""
                    draggable={false}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Luz pasiva: el acero solo devuelve lo que le llega de detrás. */}
      <div
        className="anillo-1-reflejo"
        style={{ "--anillo-color": colorEstado } as React.CSSProperties}
      />
    </div>
  );
}
