import type { ComponentHealth, ComponentStatus, HealthReport } from "./events";

export function aggregateStatus(components: ComponentHealth[]): ComponentStatus {
  if (components.length === 0) return "unknown";
  if (components.some((component) => component.status === "down")) return "down";
  if (components.some((component) => component.status === "degraded")) return "degraded";
  if (components.some((component) => component.status === "unknown")) return "unknown";
  return "up";
}

export function mergeComponentHealth(
  report: HealthReport | null,
  component: string,
  status: ComponentStatus,
  detail: string | undefined,
  checkedAt: string,
): HealthReport {
  const previous = report?.components ?? [];
  const existing = previous.find((item) => item.component === component);
  const nextComponent: ComponentHealth = {
    component,
    status,
    detail,
    checkedAt,
    latencyMs: existing?.latencyMs,
  };
  const components = existing
    ? previous.map((item) => (item.component === component ? nextComponent : item))
    : [...previous, nextComponent];

  return {
    status: aggregateStatus(components),
    components,
    checkedAt,
  };
}
