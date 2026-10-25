import { z } from "zod";
import { hostname, loadavg, arch, cpus, freemem, platform, release, totalmem, type as osType, uptime } from "node:os";
import type { ToolDefinition } from "@jarvis/shared";

const ArgsSchema = z.object({ timezone: z.string().max(64).optional() });

/**
 * Algunos modelos envían el literal "None" (el `str(None)` de Python) cuando
 * no saben la zona horaria. Se interpreta como "sin especificar" en lugar de
 * provocar un fallo de la herramienta.
 */
const UNSET_TIMEZONES = new Set(["", "none", "null", "undefined", "n/a", "na", "-", "default"]);

export const timeTool: ToolDefinition<z.infer<typeof ArgsSchema>> = {
  name: "time.now",
  title: "Fecha y hora",
  description: "Devuelve la fecha y hora actual del sistema. Opcionalmente en una zona horaria IANA concreta.",
  risk: "public_read",
  requiresApproval: false,
  timeoutMs: 1000,
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "Zona horaria IANA, por ejemplo Europe/Madrid. Opcional." },
    },
    additionalProperties: false,
  },
  parse: (raw) => ArgsSchema.parse(raw ?? {}),
  availability: () => ({ available: true }),
  execute: async (input, ctx) => {
    const now = ctx.now();
    const requested = input.timezone?.trim();
    const zone =
      !requested || UNSET_TIMEZONES.has(requested.toLowerCase())
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : requested;
    let localized: string;
    try {
      localized = new Intl.DateTimeFormat("es-ES", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: zone,
      }).format(now);
    } catch {
      return {
        ok: false,
        summary: `Zona horaria desconocida: ${zone}`,
        unavailable: false,
        error: "invalid_timezone",
      };
    }
    return {
      ok: true,
      data: { iso: now.toISOString(), epochMs: now.getTime(), timezone: zone, localized },
      summary: `${localized} (${now.toISOString()})`,
      unavailable: false,
    };
  },
};

export const systemInfoTool: ToolDefinition<Record<string, never>> = {
  name: "system.info",
  title: "Información del sistema",
  description:
    "Devuelve información técnica del host donde corre JARVIS: sistema operativo, arquitectura, CPU, memoria y uptime. No expone secretos ni variables de entorno.",
  risk: "public_read",
  requiresApproval: false,
  timeoutMs: 1000,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  parse: (raw) => z.object({}).strict().parse(raw ?? {}) as Record<string, never>,
  availability: () => ({ available: true }),
  execute: async () => {
    const data = {
      type: osType(),
      platform: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
      uptimeSeconds: Math.round(uptime()),
      loadAverage: loadavg().map((value) => Number(value.toFixed(2))),
    };
    const totalGb = (totalmem() / 1024 ** 3).toFixed(1);
    return {
      ok: true,
      data,
      summary: `${platform()} ${release()} · ${cpus().length} CPU · ${totalGb} GB RAM · uptime ${Math.round(uptime() / 3600)} h`,
      unavailable: false,
    };
  },
};
