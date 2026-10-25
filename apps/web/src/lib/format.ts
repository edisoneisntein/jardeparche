export function formatClock(date: Date): string {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const delta = Date.now() - date.getTime();
  if (delta < 10_000) return "ahora";
  if (delta < 60_000) return `hace ${Math.floor(delta / 1000)} s`;
  if (delta < 3_600_000) return `hace ${Math.floor(delta / 60_000)} min`;
  return `hace ${Math.floor(delta / 3_600_000)} h`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("es-ES").format(value);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function prettyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

export function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export function shortId(value: string | undefined, length = 8): string {
  if (!value) return "—";
  return value.slice(0, length);
}

export function riskLabel(risk: string): string {
  switch (risk) {
    case "public_read":
      return "LECTURA PÚBLICA";
    case "local_reversible":
      return "LOCAL REVERSIBLE";
    case "external_effect":
      return "EFECTO EXTERNO";
    case "destructive":
      return "DESTRUCTIVO";
    default:
      return risk.toUpperCase();
  }
}

export function agentStateLabel(state: string | null): string {
  switch (state) {
    case "IDLE":
      return "EN ESPERA";
    case "LISTENING":
      return "ESCUCHANDO";
    case "UNDERSTANDING":
      return "COMPRENDIENDO";
    case "PLANNING":
      return "PLANIFICANDO";
    case "WAITING_FOR_APPROVAL":
      return "ESPERANDO APROBACIÓN";
    case "EXECUTING":
      return "EJECUTANDO";
    case "SPEAKING":
      return "HABLANDO";
    case "INTERRUPTED":
      return "INTERRUMPIDO";
    case "COMPLETED":
      return "COMPLETADO";
    case "FAILED":
      return "FALLIDO";
    default:
      return "DESCONOCIDO";
  }
}

export function connectionLabel(state: string): string {
  switch (state) {
    case "open":
      return "ABIERTO";
    case "reconnecting":
      return "RECONECTANDO";
    case "connecting":
      return "CONECTANDO";
    default:
      return "CERRADO";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "up":
      return "OPERATIVO";
    case "degraded":
      return "DEGRADADO";
    case "down":
      return "CAÍDO";
    default:
      return "DESCONOCIDO";
  }
}
