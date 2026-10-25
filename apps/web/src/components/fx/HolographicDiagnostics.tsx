import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HealthReport } from "../../lib/events";
import { useJarvisStore } from "../../state/jarvisStore";
import type { ActivityItem } from "../../state/jarvisStore";

interface MetricsSnapshot {
  messages: number;
  events: number;
  toolCalls: number;
  toolFailures: number;
}

interface Props {
  metrics: MetricsSnapshot;
  health: HealthReport | null;
  activities: ActivityItem[];
  color: string;
  /**
   * "overlay": la tarjeta flota sobre el HUD completo (su diseño original).
   * "inline": se adapta al panel del dock, donde el overlay absoluto colapsaba
   * a cero y el contenido salía cortado.
   */
  variant?: "overlay" | "inline";
}

const WINDOW = 42;

/**
 * Serie incremental de una magnitud del store.
 *
 * El store REEMPLAZA los objetos (no los muta), así que capturar `metrics` en
 * la closure del primer render congelaba la serie en 0: `tok/min` y
 * `eventos/s` mostraban siempre cero. Ahora se lee el store vivo en cada tick.
 */
function useRollingSeries(select: (state: ReturnType<typeof useJarvisStore.getState>) => number, intervalMs = 1000) {
  const [series, setSeries] = useState<number[]>([]);
  const last = useRef<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      const value = select(useJarvisStore.getState());
      const delta = last.current === null ? 0 : Math.max(0, value - last.current);
      last.current = value;
      setSeries((previous) => [...previous, delta].slice(-WINDOW));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [select, intervalMs]);

  return series;
}

/** Escala de la barra de eventos: máximo observado de la serie (nunca una constante inventada). */
function eventScale(series: number[]): number {
  const max = Math.max(0, ...series);
  return max === 0 ? 0 : Math.max(0, (series.at(-1) ?? 0) / max);
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 150;
    const height = canvas.clientHeight || 26;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const max = Math.max(1, ...data);
    const step = width / Math.max(1, WINDOW - 1);

    ctx.strokeStyle = "rgba(94, 215, 255, 0.18)";
    ctx.lineWidth = 1;
    for (let row = 1; row < 3; row += 1) {
      const y = (height / 3) * row;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (data.length < 2) return;
    const offset = WINDOW - data.length;
    const points = data.map((value, index) => {
      const x = (offset + index) * step;
      const y = height - 2 - (value / max) * (height - 6);
      return [x, y] as const;
    });

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${color}55`);
    gradient.addColorStop(1, `${color}00`);

    const first = points[0]!;
    const last = points[points.length - 1]!;

    ctx.beginPath();
    ctx.moveTo(first[0], height);
    for (const [x, y] of points) ctx.lineTo(x, y);
    ctx.lineTo(last[0], height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
  }, [data, color]);

  return <canvas ref={canvasRef} className="holo-diag-spark" aria-hidden="true" />;
}

function Bar({ ratio, color }: { ratio: number; color: string }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <span className="holo-diag-bar">
      <i style={{ width: `${Math.round(clamped * 100)}%`, "--diag-accent": color } as React.CSSProperties} />
    </span>
  );
}

export function HolographicDiagnostics({ metrics, health, activities, color, variant = "overlay" }: Props) {
  const selectEvents = useCallback((state: ReturnType<typeof useJarvisStore.getState>) => state.metrics.events, []);
  const selectTokens = useCallback((state: ReturnType<typeof useJarvisStore.getState>) => state.usage.totalTokens ?? 0, []);
  const eventSeries = useRollingSeries(selectEvents);
  const tokenSeries = useRollingSeries(selectTokens);

  const tokensPerMin = useMemo(
    () => tokenSeries.reduce((total, value) => total + value, 0),
    [tokenSeries],
  );

  const components = health?.components ?? [];
  const upCount = components.filter((item) => item.status === "up").length;
  const degraded = components.filter((item) => item.status === "degraded").length;
  const down = components.filter((item) => item.status === "down").length;
  const known = components.length;
  const healthRatio = known === 0 ? 0 : upCount / known;

  const latencies = components
    .map((item) => item.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const avgLatency = latencies.length === 0
    ? null
    : Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length);

  const toolRatio = metrics.toolCalls === 0 ? 1 : (metrics.toolCalls - metrics.toolFailures) / metrics.toolCalls;
  const toolErrors = activities.filter((item) => item.tone === "error").length;

  return (
    <div className={variant === "inline" ? "holo-diag holo-diag--inline" : "holo-diag"} aria-hidden="true">
      <div
        className="holo-diag-card"
        style={{ ...(variant === "inline" ? {} : { top: 6, left: 2 }), "--diag-accent": color } as React.CSSProperties}
      >
        <div className="holo-diag-head">
          <span>Flujo</span>
          <strong>ventana {WINDOW}s (1 s/muestra)</strong>
        </div>
        <div className="holo-diag-value">
          {tokensPerMin}
          <small>tok/{WINDOW}s</small>
        </div>
        <Sparkline data={tokenSeries} color={color} />
        <div className="holo-diag-rows">
          <div className="holo-diag-row">
            <span>eventos/s</span>
            <Bar ratio={eventScale(eventSeries)} color={color} />
            <span>{eventSeries.at(-1) ?? 0}</span>
          </div>
        </div>
      </div>

      <div className="holo-diag-card" style={{ bottom: 6, right: 2, "--diag-accent": color } as React.CSSProperties}>
        <div className="holo-diag-head">
          <span>Diagnóstico</span>
          <strong>{health?.status?.toUpperCase() ?? "SIN DATO"}</strong>
        </div>
        <div className="holo-diag-rows">
          <div className="holo-diag-row">
            <span>herramientas</span>
            <Bar ratio={toolRatio} color={color} />
            <span>{metrics.toolCalls}·{metrics.toolFailures}✗</span>
          </div>
          <div className="holo-diag-row">
            <span>servicios</span>
            <Bar ratio={healthRatio} color={color} />
            <span>{upCount}/{known || "—"}</span>
          </div>
          <div className="holo-diag-row">
            <span>latencia</span>
            <span>{avgLatency === null ? "—" : `${avgLatency} ms`}</span>
          </div>
          <div className="holo-diag-row">
            <span>alertas</span>
            <span>
              {degraded} deg · {down} off · {toolErrors} err
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
