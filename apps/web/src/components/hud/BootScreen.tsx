import { useCallback, useMemo, useState } from "react";
import type { HealthReport } from "../../lib/events";
import { formatDuration, statusLabel } from "../../lib/format";
import { usePrefersReducedMotion } from "../../hooks/useReducedMotion";
import { WarningIcon } from "./icons";

interface BootScreenProps {
  health: HealthReport | null;
  loading: boolean;
  error: string | null;
  onEnter: () => void;
  onRetry: () => void;
}

const ENTER_COLLAPSE_MS = 520;

export function BootScreen({ health, loading, error, onEnter, onRetry }: BootScreenProps) {
  const [entering, setEntering] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const degraded = useMemo(
    () =>
      health
        ? health.components.some(
            (component) =>
              component.status === "down" ||
              component.status === "degraded" ||
              component.status === "unknown",
          )
        : true,
    [health],
  );

  // Estado real del backend: el rótulo lo refleja, no lo inventa.
  const healthState = error ? "down" : loading ? "checking" : (health?.status ?? "unknown");
  const healthLabel =
    healthState === "up"
      ? "100% ONLINE"
      : healthState === "down"
        ? "BACKEND INACCESIBLE"
        : healthState === "checking"
          ? "COMPROBANDO"
          : healthState === "degraded"
            ? "MODO DEGRADADO"
            : "ESTADO DESCONOCIDO";
  const calibrationLabel =
    healthState === "up"
      ? "CALIBRACIÓN OK"
      : healthState === "down"
        ? "SIN ENLACE"
        : healthState === "checking"
          ? "CALIBRANDO"
          : healthState === "degraded"
            ? "CALIBRACIÓN PARCIAL"
            : "CALIBRACIÓN PENDIENTE";

  const handleEnter = useCallback(() => {
    if (reducedMotion) {
      onEnter();
      return;
    }
    // Los anillos colapsan hacia el centro antes de ceder el paso al intro.
    setEntering(true);
    window.setTimeout(onEnter, ENTER_COLLAPSE_MS);
  }, [onEnter, reducedMotion]);

  return (
    <div
      className="boot-screen"
      role="dialog"
      aria-label="Inicialización de J.A.R.V.I.S."
      data-entering={entering ? "true" : "false"}
      data-reduced={reducedMotion ? "true" : "false"}
    >
      <div className="boot-backdrop" aria-hidden="true" />
      <div className="boot-sweep" aria-hidden="true" />

      <div className="boot-core" data-loading={loading ? "true" : "false"}>
        <div className="boot-core-reticle" aria-hidden="true">
          <span className="reticle-axis-h" />
          <span className="reticle-axis-v" />
          <span className="reticle-deg reticle-deg-0">0°</span>
          <span className="reticle-deg reticle-deg-90">90°</span>
          <span className="reticle-deg reticle-deg-180">180°</span>
          <span className="reticle-deg reticle-deg-270">270°</span>
        </div>
        <span className="boot-ring boot-ring-outer" aria-hidden="true" />
        <span className="boot-ring boot-ring-mid" aria-hidden="true" />
        <span className="boot-ring boot-ring-inner" aria-hidden="true" />
        <img src="/assets/jarvis/arc-reactor-disc.jpg" alt="" />
        <span className="boot-flare" aria-hidden="true" />
        <div className="boot-core-tag" aria-hidden="true">
          ARC REACTOR MK-85 · {healthLabel}
        </div>
      </div>

      <div className="boot-panel">
        <span className="hud-corner hud-corner-tl" aria-hidden="true" />
        <span className="hud-corner hud-corner-tr" aria-hidden="true" />
        <span className="hud-corner hud-corner-bl" aria-hidden="true" />
        <span className="hud-corner hud-corner-br" aria-hidden="true" />

        <div className="boot-telemetry-bar" aria-hidden="true">
          <span className="telemetry-chip">SYS // STARK-MK85</span>
          <span className="telemetry-chip">PROTOCOLO NEURAL v4.8</span>
          <span className="telemetry-chip telemetry-status" data-state={healthState}>
            {calibrationLabel}
          </span>
        </div>

        <header>
          <span className="boot-mark" aria-hidden="true" />
          <div>
            <h1>J.A.R.V.I.S.</h1>
            <p>Diagnóstico de Subsistemas // Protocolo de Arranque</p>
          </div>
        </header>

        <ul className="boot-list" aria-live="polite">
          {error ? (
            <li className="boot-item boot-down" style={{ animationDelay: "0ms" }}>
              <div className="boot-item-main">
                <span className="boot-index">ERR</span>
                <span className="dot" aria-hidden="true" />
                <span className="boot-name">backend</span>
                <span className="boot-meta">
                  <span className="boot-status">INACCESIBLE</span>
                </span>
              </div>
              <span className="boot-detail" title={error}>› {error}</span>
            </li>
          ) : null}

          {!health && !error ? (
            <li className="boot-item boot-unknown" style={{ animationDelay: "0ms" }}>
              <div className="boot-item-main">
                <span className="boot-index">--</span>
                <span className="dot" aria-hidden="true" />
                <span className="boot-name">comprobando /api/health…</span>
              </div>
            </li>
          ) : null}

          {health?.components.map((component, index) => (
            <li
              key={component.component}
              className={`boot-item boot-${component.status}`}
              style={{ animationDelay: `${120 + index * 40}ms` }}
            >
              <div className="boot-item-main">
                <span className="boot-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="dot" aria-hidden="true" />
                <span className="boot-name">{component.component}</span>
                <span className="boot-meta">
                  {component.latencyMs !== undefined ? (
                    <span className="boot-latency">[{formatDuration(component.latencyMs)}]</span>
                  ) : null}
                  <span className="boot-status">{statusLabel(component.status)}</span>
                </span>
              </div>
              {component.detail ? (
                <span className="boot-detail" title={component.detail}>
                  › {component.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="boot-actions">
          {degraded ? (
            <p className="boot-warning" style={{ animationDelay: `${140 + (health?.components.length ?? 0) * 40}ms` }}>
              <WarningIcon />
              Advertencia: subsistemas no operativos detectados. Jarvis mantendrá telemetría activa en consola.
            </p>
          ) : (
            <p className="boot-ok" style={{ animationDelay: `${140 + (health?.components.length ?? 0) * 40}ms` }}>
              Diagnóstico completado: todos los subsistemas nominales.
            </p>
          )}
          <div className="boot-buttons">
            <button type="button" className="ghost-button" onClick={onRetry} disabled={loading}>
              Recalibrar
            </button>
            <button type="button" className="primary-button" onClick={handleEnter} disabled={entering}>
              {entering ? "Inicializando…" : "Inicializar HUD"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
