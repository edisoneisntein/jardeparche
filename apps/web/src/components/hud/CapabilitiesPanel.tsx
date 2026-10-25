import type { CapabilitiesResponse } from "../../lib/events";
import { formatRelative, riskLabel } from "../../lib/format";
import { RefreshIcon, ShieldIcon } from "./icons";

interface CapabilitiesPanelProps {
  capabilities: CapabilitiesResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const MODEL_FLAGS: Array<{ key: keyof CapabilitiesResponse["capabilities"]; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "streaming", label: "Streaming" },
  { key: "tools", label: "Herramientas" },
  { key: "vision", label: "Visión" },
  { key: "embeddings", label: "Embeddings" },
];

export function CapabilitiesPanel({ capabilities, loading, error, onRefresh }: CapabilitiesPanelProps) {
  return (
    <section className="panel capabilities-panel" aria-label="Capacidades">
      <div className="section-heading">
        <h3>CAPACIDADES</h3>
        <button type="button" className="text-button" onClick={onRefresh} disabled={loading}>
          <RefreshIcon />
          {loading ? "Consultando" : "Refrescar"}
        </button>
      </div>

      {error ? <p className="inline-error">{error}</p> : null}

      {!capabilities ? (
        <p className="empty-note">{error ? "Sin datos del backend." : "Consultando /api/capabilities…"}</p>
      ) : (
        <>
          <dl className="capability-meta">
            <div>
              <dt>Proveedor</dt>
              <dd>{capabilities.provider}</dd>
            </div>
            <div>
              <dt>Voz</dt>
              <dd title={capabilities.voice?.notes ?? ""}>
                STT {capabilities.voice?.stt ?? "—"} · TTS {capabilities.voice?.tts ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Modelo</dt>
              <dd title={capabilities.models.chat}>{capabilities.models.chat}</dd>
            </div>
            <div>
              <dt>Visión</dt>
              <dd title={capabilities.models.vision}>{capabilities.models.vision}</dd>
            </div>
          </dl>

          <ul className="capability-flags">
            {MODEL_FLAGS.map(({ key, label }) => {
              const value = capabilities.capabilities[key];
              return (
                <li key={key} className={value ? "flag-on" : "flag-off"}>
                  <span className="dot" aria-hidden="true" />
                  {label}
                  <span className="flag-value">{typeof value === "boolean" ? (value ? "SÍ" : "NO") : String(value)}</span>
                </li>
              );
            })}
          </ul>
          <p className="capability-source">
            Fuente: {capabilities.capabilities.source} · verificada {formatRelative(capabilities.capabilities.checkedAt)}
            {capabilities.capabilities.notes ? ` · ${capabilities.capabilities.notes}` : ""}
          </p>

          <h4 className="subheading">
            <ShieldIcon /> Herramientas ({capabilities.tools.filter((tool) => tool.available).length}/
            {capabilities.tools.length})
          </h4>
          <ul className="tool-list">
            {capabilities.tools.map((tool) => (
              <li key={tool.name} className={tool.available ? "tool-available" : "tool-unavailable"}>
                <div className="tool-line">
                  <span className="tool-name">{tool.name}</span>
                  <span className={`risk-badge risk-${tool.risk}`}>{riskLabel(tool.risk)}</span>
                  {tool.requiresApproval ? <span className="approval-badge">APROBACIÓN</span> : null}
                </div>
                <p className="tool-desc">{tool.description}</p>
                {!tool.available ? <p className="tool-reason">No disponible: {tool.reason ?? "sin configurar"}</p> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
