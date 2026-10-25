import type { HealthReport } from "../../lib/events";
import { formatDuration, formatRelative, statusLabel } from "../../lib/format";

interface HealthStripProps {
  health: HealthReport | null;
  error: string | null;
  onRefresh?: () => void;
}

export function HealthStrip({ health, error, onRefresh }: HealthStripProps) {
  return (
    <section className="health-strip" aria-label="Estado de componentes">
      <div className="section-heading">
        <h3>SALUD DEL SISTEMA</h3>
        {onRefresh ? (
          <button type="button" className="text-button" onClick={onRefresh}>
            Actualizar
          </button>
        ) : null}
      </div>

      {error ? <p className="inline-error">{error}</p> : null}

      {!health ? (
        <p className="empty-note">
          {error ? "Sin lectura de salud del backend." : "Consultando /api/health…"}
        </p>
      ) : (
        <>
          <div className={`health-summary health-${health.status}`}>
            <span className="dot" aria-hidden="true" />
            <strong>{statusLabel(health.status)}</strong>
            <span>{formatRelative(health.checkedAt)}</span>
          </div>
          <ul className="health-list">
            {health.components.length === 0 ? (
              <li className="empty-note">El backend no reportó componentes.</li>
            ) : (
              health.components.map((component) => (
                <li key={component.component} className={`health-item health-${component.status}`}>
                  <span className="dot" aria-hidden="true" />
                  <span className="health-name">{component.component}</span>
                  <span className="health-status">{statusLabel(component.status)}</span>
                  {component.latencyMs !== undefined ? (
                    <span className="health-latency">{formatDuration(component.latencyMs)}</span>
                  ) : null}
                  {component.detail ? <span className="health-detail">{component.detail}</span> : null}
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </section>
  );
}
