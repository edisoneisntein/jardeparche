import type { AgentState } from "../../lib/events";

/**
 * ESTADO DE ÁNIMO DEL NÚCLEO.
 *
 * El color del plasma no lo dicta el estado técnico del agente, sino el
 * "tono" con el que está trabajando: frío y preciso mientras espera,
 * violeta cuando analiza de verdad, y carmesí cuando algo va mal o la
 * decisión es del usuario.
 *
 * Es una interpolación, no un salto: el material del plasma va hacia el
 * color de destino con un `lerp` en cada frame, así que el cambio de
 * talante se ve como una mezcla de la paleta, no como un corte.
 */

export type ModoAnimo = "NEUTRAL" | "ANALITICO" | "ALERTA";

export interface PaletaAnimo {
  modo: ModoAnimo;
  /** Plasma del núcleo. */
  plasma: string;
  /** Estelas de partícula y destellos. */
  estela: string;
  /** Halo que abraza la gema. */
  halo: string;
  /** Acento de los módulos de potencia. */
  acento: string;
  /**
   * Tinte para las capas que son imagen (el plasma y los módulos son PNG
   * azules): con un `hue-rotate` se les cambia de color sin volver a
   * exportar las texturas.
   */
  tinte: string;
  /** Tinte de los módulos de potencia. */
  tinteAcento: string;
}

const PALETAS: Record<ModoAnimo, PaletaAnimo> = {
  NEUTRAL: {
    modo: "NEUTRAL",
    plasma: "#00d2ff",
    estela: "#5ce8ff",
    halo: "#a8f0ff",
    acento: "#00f0ff",
    tinte: "0deg",
    tinteAcento: "0deg",
  },
  ANALITICO: {
    modo: "ANALITICO",
    plasma: "#a800ff",
    estela: "#ff3ad0",
    halo: "#d9a3ff",
    acento: "#b46bff",
    tinte: "105deg",
    tinteAcento: "112deg",
  },
  ALERTA: {
    modo: "ALERTA",
    plasma: "#ff0033",
    estela: "#ff7a3d",
    halo: "#ffb08a",
    acento: "#ff3300",
    tinte: "172deg",
    tinteAcento: "168deg",
  },
};

/** Estados en los que el núcleo está calculando de verdad. */
const ANALITICOS: ReadonlySet<string> = new Set(["UNDERSTANDING", "PLANNING"]);
/** Estados en los que algo Requiere atención o ha salido mal. */
const ALERTAS: ReadonlySet<string> = new Set(["FAILED", "WAITING_FOR_APPROVAL"]);

export function modoDeEstado(state: AgentState | null): ModoAnimo {
  if (state !== null && ANALITICOS.has(state)) return "ANALITICO";
  if (state !== null && ALERTAS.has(state)) return "ALERTA";
  return "NEUTRAL";
}

export function animoDeEstado(state: AgentState | null): PaletaAnimo {
  return PALETAS[modoDeEstado(state)];
}

/**
 * Dirección de la energía según el estado.
 *
 *   · IMPLOSION: el núcleo está cargando — escucha, entiende o planifica.
 *     La energía de los anillos converge hacia la gema.
 *   · EXPLOSION: JARVIS está hablando. La energía sale disparada.
 */
export type FlujoEnergia = "IMPLOSION" | "EXPLOSION" | "CALMA";

export function flujoDeEstado(state: AgentState | null): FlujoEnergia {
  if (state === "SPEAKING") return "EXPLOSION";
  if (state === "LISTENING" || state === "UNDERSTANDING" || state === "PLANNING") return "IMPLOSION";
  return "CALMA";
}
