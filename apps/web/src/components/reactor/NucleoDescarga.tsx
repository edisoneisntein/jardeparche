import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../../lib/events";
import { animoDeEstado } from "./estados";

/**
 * DESCARGA DEL NÚCLEO.
 *
 * El instante exacto en que JARVIS empieza a hablar: la energía acumulada
 * sale disparada.
 *
 *   · Onda de choque: un anillo concéntrico que nace en el centro, cruza
 *     los anillos 3, 2 y 1 y se va por encima del marco metálico.
 *   · Destello anamórfico: la raya horizontal de lente que se dispara
 *     hacia los lados, rompiendo el límite del reactor.
 *
 * Las dos cosas se disparan con el cambio de estado a SPEAKING (no con
 * cualquier cambio): es la descarga, no un parpadeo.
 */

interface NucleoDescargaProps {
  state: AgentState | null;
  reducedMotion: boolean;
}

export function NucleoDescarga({ state, reducedMotion }: NucleoDescargaProps) {
  const [disparo, setDisparo] = useState(0);
  const estadoPrevio = useRef<AgentState | null>(state);

  useEffect(() => {
    if (estadoPrevio.current === state) return;
    estadoPrevio.current = state;
    if (state === "SPEAKING") setDisparo((valor) => valor + 1);
  }, [state]);

  const animo = animoDeEstado(state);

  return (
    <div className="nucleo-descarga" aria-hidden="true">
      {disparo > 0 && !reducedMotion ? (
        <>
          <div
            className="nucleo-onda"
            key={`onda-${disparo}`}
            style={{ "--descarga-color": animo.estela } as React.CSSProperties}
          />
          <div
            className="nucleo-flare"
            key={`flare-${disparo}`}
            style={{ "--descarga-color": animo.estela } as React.CSSProperties}
          />
        </>
      ) : null}
    </div>
  );
}
