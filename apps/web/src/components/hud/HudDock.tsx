import { useEffect, useId, useState, type ReactNode } from "react";
import { CloseIcon } from "./icons";

export type DockPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "right-edge";

interface HudDockProps {
  label: string;
  icon: ReactNode;
  position: DockPosition;
  children: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  align?: "start" | "end";
}

export function HudDock({
  label,
  icon,
  position,
  children,
  defaultOpen = false,
  badge,
  align,
}: HudDockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const resolvedAlign = align ?? (position === "top-right" || position === "bottom-right" || position === "right-edge" ? "end" : "start");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="hud-dock" data-position={position} data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="hud-dock-button"
        aria-label={open ? `Cerrar ${label}` : `Abrir ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="hud-dock-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="hud-dock-label">{label}</span>
        {badge !== undefined ? <span className="hud-dock-badge">{badge}</span> : null}
      </button>

      <section
        id={panelId}
        className="hud-dock-panel"
        data-align={resolvedAlign}
        role="region"
        aria-label={label}
        hidden={!open}
      >
        <header className="hud-dock-panel-head">
          <h3>{label}</h3>
          <button
            type="button"
            className="hud-dock-close"
            aria-label={`Cerrar ${label}`}
            onClick={() => setOpen(false)}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="hud-dock-panel-body">{children}</div>
      </section>
    </div>
  );
}
