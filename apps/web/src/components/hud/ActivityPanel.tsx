import type { HealthReport, TokenUsage } from "../../lib/events";
import type { ActivityItem } from "../../state/jarvisStore";
import type { ConnectionState } from "../../lib/events";
import { formatNumber, formatRelative, formatTime } from "../../lib/format";
import { HealthStrip } from "./HealthStrip";

interface ActivityPanelProps {
  activities: ActivityItem[];
  /** Estado real del enlace con el núcleo. */
  connection: ConnectionState;
  metrics: { messages: number; events: number; toolCalls: number; toolFailures: number };
  usage: TokenUsage;
  health: HealthReport | null;
  healthError: string | null;
  onRefreshHealth: () => void;
}

export function ActivityPanel({
  activities,
  connection,
  metrics,
  usage,
  health,
  healthError,
  onRefreshHealth,
}: ActivityPanelProps) {
  return (
    <section className="panel activity-panel" aria-label="Actividad y métricas">
      <div className="section-heading">
        <h3>ACTIVIDAD</h3>
        <span className="conversation-count">{connection === "open" ? "en vivo" : "sin enlace"}</span>
      </div>

      <ul className="metric-grid">
        <li>
          <span className="metric-value">{formatNumber(metrics.messages)}</span>
          <span className="metric-label">Mensajes</span>
        </li>
        <li>
          <span className="metric-value">{formatNumber(metrics.toolCalls)}</span>
          <span className="metric-label">Herramientas</span>
        </li>
        <li>
          <span className="metric-value">{formatNumber(metrics.toolFailures)}</span>
          <span className="metric-label">Fallos</span>
        </li>
        <li>
          <span className="metric-value">{formatNumber(usage.totalTokens)}</span>
          <span className="metric-label">Tokens</span>
        </li>
      </ul>

      <HealthStrip health={health} error={healthError} onRefresh={onRefreshHealth} />

      <h4 className="subheading">REGISTRO DE EVENTOS</h4>
      <ul className="activity-list" aria-live="polite">
        {activities.length === 0 ? (
          <li className="empty-note">Sin eventos todavía.</li>
        ) : (
          activities.map((activity) => (
            <li key={activity.id} className={`activity-item activity-${activity.tone}`}>
              <span className="activity-time">{formatTime(activity.ts)}</span>
              <div className="activity-body">
                <span className="activity-title">{activity.title}</span>
                {activity.detail ? <span className="activity-detail">{activity.detail}</span> : null}
                {activity.durationMs !== undefined ? (
                  <span className="activity-meta">· {Math.round(activity.durationMs)} ms</span>
                ) : null}
              </div>
            </li>
          ))
        )}
      </ul>

      {health ? <p className="panel-footnote">Última lectura de salud: {formatRelative(health.checkedAt)}</p> : null}
    </section>
  );
}
