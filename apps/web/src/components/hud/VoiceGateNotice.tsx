import type { MicGate } from "../../lib/micGate";

interface VoiceGateNoticeProps {
  gate: MicGate;
  onRetry: () => void;
}

/**
 * Aviso accionable para el bloqueo del micrófono.
 *
 * Antes el HUD solo decía "micrófono bloqueado, revisa los ajustes del sitio",
 * lo que es inútil cuando el origen no es seguro (no existe ajuste que lo
 * arregle). Aquí cada causa muestra su remedio real y, cuando el bloqueo se
 * puede resolver en un clic, ofrece el botón que lo resuelve.
 */
export function VoiceGateNotice({ gate, onRetry }: VoiceGateNoticeProps) {
  if (gate.state === "ready" || gate.state === "unknown") return null;

  const action = gate.remedy === "use-localhost" && gate.localUrl;

  return (
    <div className="voice-gate" role="alert" data-state={gate.state}>
      <div className="voice-gate-body">
        <strong className="voice-gate-title">
          {gate.state === "insecure-origin"
            ? "Micrófono bloqueado por el origen"
            : gate.state === "permission-blocked"
              ? "Micrófono bloqueado por el navegador"
              : "Voz no disponible en este navegador"}
        </strong>
        <span className="voice-gate-reason">{gate.reason}</span>
        <span className="voice-gate-guidance">{gate.guidance}</span>
      </div>
      <div className="voice-gate-actions">
        {action ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              window.location.replace(action);
            }}
          >
            Abrir en {new URL(action).host}
          </button>
        ) : null}
        <button type="button" className="ghost-button" onClick={onRetry}>
          Reintentar
        </button>
      </div>
    </div>
  );
}
