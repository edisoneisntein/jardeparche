import { useClock } from "../../hooks/useClock";
import {
  agentStateLabel,
  connectionLabel,
  formatClock,
  shortId,
  statusLabel,
} from "../../lib/format";
import type {
  AgentState,
  CapabilitiesResponse,
  ConnectionState,
  HealthReport,
} from "../../lib/events";
import { SettingsIcon } from "./icons";

interface HeaderProps {
  agentState: AgentState | null;
  agentDetail: string | null;
  connection: ConnectionState;
  health: HealthReport | null;
  capabilities: CapabilitiesResponse | null;
  sessionId: string | null;
  onOpenSettings: () => void;
}

export function Header({
  agentState,
  agentDetail,
  connection,
  health,
  capabilities,
  sessionId,
  onOpenSettings,
}: HeaderProps) {
  const now = useClock();
  const stateClass = (agentState ?? "UNKNOWN").toLowerCase();
  const provider = capabilities?.provider ?? null;
  const model = capabilities?.models.chat ?? capabilities?.capabilities.model ?? null;
  const healthStatus = health?.status ?? "unknown";

  return (
    <header className="hud-header" data-agent={agentState ?? "UNKNOWN"}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div className="brand-text">
          <h1>J.A.R.V.I.S.</h1>
          <p>Just A Rather Very Intelligent System</p>
        </div>
      </div>

      <div className="header-status">
        <div className={`status-pill state-${stateClass}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span className="status-label">{agentStateLabel(agentState)}</span>
          {agentDetail ? <span className="status-detail">{agentDetail}</span> : null}
        </div>

        <div className={`connection-pill connection-${connection}`}>
          <span className="dot" aria-hidden="true" />
          <span>ENLACE {connectionLabel(connection)}</span>
        </div>

        <div className={`health-mini health-${healthStatus}`}>
          <span className="dot" aria-hidden="true" />
          <span>SISTEMA {statusLabel(healthStatus)}</span>
        </div>
      </div>

      <dl className="header-meta">
        <div>
          <dt>Proveedor</dt>
          <dd>{provider ?? "—"}</dd>
        </div>
        <div>
          <dt>Modelo</dt>
          <dd title={model ?? undefined}>{model ?? "—"}</dd>
        </div>
        <div>
          <dt>Sesión</dt>
          <dd title={sessionId ?? undefined}>{shortId(sessionId ?? undefined)}</dd>
        </div>
        <div>
          <dt>Hora</dt>
          <dd className="clock">{formatClock(now)}</dd>
        </div>
      </dl>

      <button type="button" className="icon-button" onClick={onOpenSettings} aria-label="Abrir ajustes">
        <SettingsIcon />
      </button>
    </header>
  );
}
