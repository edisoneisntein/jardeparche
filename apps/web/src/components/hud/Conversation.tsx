import type { ThreadItem } from "../../state/jarvisStore";
import type { ConnectionState } from "../../lib/events";
import { formatDuration, formatTime, prettyJson, riskLabel } from "../../lib/format";
import { useTypewriter } from "../../hooks/useTypewriter";
import { Markdown } from "./Markdown";

interface ConversationProps {
  thread: ThreadItem[];
  agentState: string | null;
  sessionError: string | null;
  /** Estado real del enlace con el núcleo. */
  connection: ConnectionState;
  /** Respeta la preferencia de "reducir movimiento". */
  reducedMotion: boolean;
}

interface BubbleProps {
  item: Extract<ThreadItem, { kind: "message" }>;
  reducedMotion: boolean;
}

/**
 * Burbuja de la conversación. El texto del núcleo se escribe carácter a
 * carácter mientras llega (máquina de escribir del HUD).
 */
function MessageBubble({ item, reducedMotion }: BubbleProps) {
  const mensaje = item.message;
  const enVivo = Boolean(mensaje.streaming);
  const texto = useTypewriter(mensaje.text, enVivo && !reducedMotion);
  return (
    <article className={`bubble bubble-${mensaje.role}${enVivo ? " streaming" : ""}`}>
      <header>
        <span className="bubble-role">
          {mensaje.role === "user"
            ? mensaje.source === "voice"
              ? "STARK // VOZ"
              : "STARK // CONSOLA"
            : mensaje.role === "assistant"
              ? "J.A.R.V.I.S. // NÚCLEO IA"
              : "SISTEMA // PROTOCOLO"}
        </span>
        <span className="bubble-time">{formatTime(mensaje.createdAt)}</span>
        {mensaje.usage?.totalTokens ? (
          <span className="bubble-tokens">{mensaje.usage.totalTokens} tok</span>
        ) : null}
      </header>
      {mensaje.reasoning ? (
        <details className="bubble-reasoning">
          <summary>razonamiento</summary>
          <p>{mensaje.reasoning}</p>
        </details>
      ) : null}
      <div className="bubble-body">
        <Markdown text={texto} />
        {enVivo ? <span className="bubble-caret" aria-hidden="true" /> : null}
      </div>
    </article>
  );
}

function ToolCardView({ tool }: { tool: Extract<ThreadItem, { kind: "tool" }>["tool"] }) {
  const statusLabelMap: Record<string, string> = {
    started: "EN EJECUCIÓN",
    awaiting_approval: "ESPERA APROBACIÓN",
    approved: "APROBADA",
    rejected: "RECHAZADA",
    completed: "COMPLETADA",
    failed: "FALLIDA",
    unavailable: "NO DISPONIBLE",
  };

  return (
    <article className={`tool-card tool-${tool.status}`}>
      <header>
        <span className="tool-glyph" aria-hidden="true" />
        <strong>{tool.name}</strong>
        <span className={`risk-badge risk-${tool.risk ?? "none"}`}>{tool.risk ? riskLabel(tool.risk) : "RIESGO N/D"}</span>
        <span className="tool-status">{statusLabelMap[tool.status] ?? tool.status}</span>
      </header>

      {tool.summary ? <p className="tool-summary">{tool.summary}</p> : null}
      {tool.error ? <p className="tool-error">{tool.error}</p> : null}
      {tool.durationMs !== undefined ? (
        <p className="tool-meta">Duración: {formatDuration(tool.durationMs)}</p>
      ) : null}

      {tool.args !== undefined ? (
        <details className="tool-details">
          <summary>Argumentos / resultado</summary>
          <pre>{prettyJson(tool.args)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function Conversation({ thread, agentState, sessionError, connection, reducedMotion }: ConversationProps) {
  return (
    <section className="conversation" aria-label="Conversación" data-agent={agentState ?? "UNKNOWN"}>
      <span className="hud-corner hud-corner-tl" aria-hidden="true" />
      <span className="hud-corner hud-corner-tr" aria-hidden="true" />
      <span className="hud-corner hud-corner-bl" aria-hidden="true" />
      <span className="hud-corner hud-corner-br" aria-hidden="true" />

      <div className="section-heading">
        <div className="heading-group">
          <h3>TACTICAL COMMS // REGISTRO</h3>
          <span className="hud-subchip" data-state={connection}>
            {connection === "open" ? "ENLACE NEURAL ACTIVO" : "ENLACE NEURAL INTERRUMPIDO"}
          </span>
        </div>
        <span className="conversation-count">{thread.length} entradas</span>
      </div>

      {sessionError ? <p className="inline-error">{sessionError}</p> : null}

      <div className="thread" role="log" aria-live="polite">
        {thread.length === 0 ? (
          <div className="empty-note hud-empty-state">
            <span className="hud-crosshair" aria-hidden="true">+</span>
            <p>
              SISTEMAS EN ESPERA ·{" "}
              {connection === "open" ? "ENLACE COMUNICACIÓN LISTO" : "ESPERANDO ENLACE CON EL NÚCLEO"}
            </p>
            <span className="hud-note-sub">Emita una orden verbal o textual para activar la matriz neuronal.</span>
          </div>
        ) : (
          thread.map((item, index) =>
            item.kind === "tool" ? (
              <ToolCardView key={`tool-${item.tool.toolCallId}-${index}`} tool={item.tool} />
            ) : (
              <MessageBubble key={item.message.id} item={item} reducedMotion={reducedMotion} />
            ),
          )
        )}
      </div>
    </section>
  );
}
