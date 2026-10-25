import { useEffect, useRef } from "react";
import type { PendingApproval } from "../../state/jarvisStore";
import { prettyJson, riskLabel } from "../../lib/format";
import { CloseIcon, ShieldIcon, WarningIcon } from "./icons";

interface ApprovalModalProps {
  approval: PendingApproval;
  onApprove: () => void;
  onReject: () => void;
}

export function ApprovalModal({ approval, onApprove, onReject }: ApprovalModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const approveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    approveRef.current?.focus();
  }, [approval.approvalId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onReject();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onReject]);

  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-description"
        ref={dialogRef}
      >
        <header className="modal-header">
          <span className="modal-icon" aria-hidden="true">
            <WarningIcon />
          </span>
          <div>
            <h2 id="approval-title">Confirmación requerida</h2>
            <p id="approval-description">{approval.description}</p>
          </div>
          <button type="button" className="icon-button" onClick={onReject} aria-label="Cerrar y rechazar">
            <CloseIcon />
          </button>
        </header>

        <dl className="modal-meta">
          <div>
            <dt>Herramienta</dt>
            <dd>{approval.name}</dd>
          </div>
          <div>
            <dt>Riesgo</dt>
            <dd>
              <span className={`risk-badge risk-${approval.risk}`}>{riskLabel(approval.risk)}</span>
            </dd>
          </div>
          <div>
            <dt>Autorización</dt>
            <dd>{approval.approvalId.slice(0, 8)}</dd>
          </div>
        </dl>

        <details className="modal-args" open>
          <summary>
            <ShieldIcon /> Argumentos validados
          </summary>
          <pre>{prettyJson(approval.args)}</pre>
        </details>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onReject}>
            Rechazar
          </button>
          <button type="button" className="danger-button" ref={approveRef} onClick={onApprove}>
            Aprobar ejecución
          </button>
        </div>
      </div>
    </div>
  );
}
