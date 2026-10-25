import { z } from "zod";

export const COMPONENT_STATUS = ["up", "degraded", "down", "unknown"] as const;
export const ComponentStatusSchema = z.enum(COMPONENT_STATUS);
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export interface ComponentHealth {
  component: string;
  status: ComponentStatus;
  detail?: string;
  checkedAt: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: ComponentStatus;
  components: ComponentHealth[];
  checkedAt: string;
}

/** Worst status wins, but "unknown" never masquerades as "up". */
export function aggregateStatus(components: ComponentHealth[]): ComponentStatus {
  if (components.length === 0) return "unknown";
  if (components.some((c) => c.status === "down")) return "down";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  if (components.some((c) => c.status === "unknown")) return "unknown";
  return "up";
}
