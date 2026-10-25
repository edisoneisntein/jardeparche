import { useJarvisStore } from "../../state/jarvisStore";

const SCANNING_STATES = new Set(["UNDERSTANDING", "PLANNING"]);

/**
 * Full-bleed analysis sweep. It only appears while the agent is actually
 * parsing or planning, and everything printed on it comes from the live
 * session: no decorative fake telemetry.
 */
export function ScanOverlay() {
  const state = useJarvisStore((store) => store.agentState);
  const detail = useJarvisStore((store) => store.agentDetail);
  const taskId = useJarvisStore((store) => store.currentTaskId);
  const metrics = useJarvisStore((store) => store.metrics);
  const usage = useJarvisStore((store) => store.usage);
  const session = useJarvisStore((store) => store.session);

  const active = state !== null && SCANNING_STATES.has(state);
  const failure = state === "FAILED";

  return (
    <div className="scan-overlay" data-active={active ? "true" : "false"} data-failed={failure ? "true" : "false"} aria-hidden="true">
      <div className="scan-grid" />
      <div className="scan-sweep" />
      <div className="scan-bracket scan-bracket-tl" />
      <div className="scan-bracket scan-bracket-tr" />
      <div className="scan-bracket scan-bracket-bl" />
      <div className="scan-bracket scan-bracket-br" />

      <div className="scan-readout">
        <div className="scan-readout-row">
          <span className="scan-key">SESIÓN</span>
          <span className="scan-value">{session ? session.id.slice(0, 8) : "—"}</span>
        </div>
        <div className="scan-readout-row">
          <span className="scan-key">TAREA</span>
          <span className="scan-value">{taskId ? taskId.slice(0, 8) : "—"}</span>
        </div>
        <div className="scan-readout-row">
          <span className="scan-key">HERRAMIENTAS</span>
          <span className="scan-value">
            {metrics.toolCalls} · {metrics.toolFailures} fallos
          </span>
        </div>
        <div className="scan-readout-row">
          <span className="scan-key">TOKENS</span>
          <span className="scan-value">{usage.totalTokens ?? 0}</span>
        </div>
        <div className="scan-readout-row">
          <span className="scan-key">EVENTOS</span>
          <span className="scan-value">{metrics.events}</span>
        </div>
      </div>

      <div className="scan-status">
        <span className="scan-status-dot" />
        <span>{active ? detail ?? "analizando" : failure ? "interrupción detectada" : "en espera"}</span>
      </div>
    </div>
  );
}
