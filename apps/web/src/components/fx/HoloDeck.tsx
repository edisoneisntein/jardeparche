import type { AgentState } from "../../lib/events";

interface DeckProps {
  state: AgentState | null;
  reducedMotion: boolean;
}

/** Rotation speed of the reticle for each agent state (seconds per turn). */
const RETICLE_SPEED: Record<AgentState, number> = {
  IDLE: 120,
  LISTENING: 40,
  UNDERSTANDING: 22,
  PLANNING: 14,
  WAITING_FOR_APPROVAL: 60,
  EXECUTING: 10,
  SPEAKING: 34,
  INTERRUPTED: 160,
  COMPLETED: 26,
  FAILED: 200,
};

/**
 * Receptáculo circular (reticle) tomado del HUD del Mark VII. Gira despacio y
 * se acelera con la actividad del agente; su opacidad también sigue al estado.
 */
export function ReticleLayer({ state, reducedMotion }: DeckProps) {
  const resolved = state ?? "IDLE";
  const duration = RETICLE_SPEED[resolved];
  const idle = resolved === "IDLE" || resolved === "INTERRUPTED";

  return (
    <div className="reticle-layer" data-state={resolved} aria-hidden="true">
      <img
        src="/assets/jarvis/mk-suit.jpg"
        alt=""
        style={reducedMotion ? undefined : { animationDuration: `${duration}s` }}
        data-spin={reducedMotion || idle ? "slow" : "fast"}
      />
    </div>
  );
}

/**
 * Chips decorativos recortados de la lámina de paneles holográficos. Son
 * puramente ambientales y viven detrás del contenido.
 */
export function HoloPanels() {
  return (
    <div className="holo-panels" aria-hidden="true">
      <img className="holo-chip holo-chip-tall-a" src="/assets/jarvis/panels/chip-tall-a.jpg" alt="" />
      <img className="holo-chip holo-chip-tall-b" src="/assets/jarvis/panels/chip-tall-b.jpg" alt="" />
      <img className="holo-chip holo-chip-ring-a" src="/assets/jarvis/panels/chip-ring.jpg" alt="" />
      <img className="holo-chip holo-chip-ring-b" src="/assets/jarvis/panels/chip-ring2.jpg" alt="" />
      <img className="holo-chip holo-chip-wide" src="/assets/jarvis/panels/chip-wide.jpg" alt="" />
      <img className="holo-chip holo-chip-spectral" src="/assets/jarvis/panels/chip-spectral.jpg" alt="" />
      <img className="holo-chip holo-chip-bar" src="/assets/jarvis/panels/chip-wide-b.jpg" alt="" />
      <img className="holo-chip holo-chip-badge" src="/assets/jarvis/panels/chip-a.jpg" alt="" />
    </div>
  );
}
