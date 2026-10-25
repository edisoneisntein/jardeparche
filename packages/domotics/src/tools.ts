import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "@jarvis/shared";
import { toDomoticsError } from "./errors.js";
import type {
  Area,
  CameraSnapshot,
  EntityRegistryItem,
  PerimeterMode,
} from "./types.js";
import type { CameraSnapshotResult } from "./cameras.js";

/** Cliente de Home Assistant utilizado por las herramientas. */
export interface HassToolClient {
  /** Indica si la integración está configurada. */
  isConfigured?: () => boolean;
  /** Invoca un servicio. */
  call_service(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Recupera estados actuales. */
  get_states(signal?: AbortSignal): Promise<EntityRegistryItem[]>;
  /** Recupera áreas. */
  list_areas(signal?: AbortSignal): Promise<Area[]>;
}

/** Registro de entidades utilizado por las herramientas. */
export interface EntityToolStore {
  /** Busca una entidad cacheada. */
  get(entityId: string): EntityRegistryItem | undefined;
}

/** Controlador perimetral utilizado por las herramientas. */
export interface PerimeterToolController {
  /** Activa un modo perimetral. */
  arm(mode: PerimeterMode, signal?: AbortSignal): Promise<PerimeterMode>;
}

/** Servicio de cámaras utilizado por las herramientas. */
export interface CameraToolService {
  /** Lista las cámaras configuradas. */
  list(): Array<{ id: string }>;
  /** Captura una instantánea. */
  snapshot(
    cameraId: string,
    options?: { signal?: AbortSignal; analyze?: boolean },
  ): Promise<CameraSnapshot | CameraSnapshotResult>;
}

/** Servicios que necesita el conjunto de herramientas de domótica. */
export interface DomoticsToolServices {
  /** Cliente de Home Assistant. */
  hass: HassToolClient;
  /** Caché de entidades. */
  entities: EntityToolStore;
  /** Controlador perimetral. */
  perimeter: PerimeterToolController;
  /** Servicio de cámaras. */
  cameras: CameraToolService;
}

const HomeControlInputSchema = z.object({
  action: z.enum(["set_state", "get_state", "run_scene", "arm_perimeter"]),
  entity_id: z.string().min(1).optional(),
  state: z.union([z.string(), z.number(), z.boolean()]).optional(),
  scene_id: z.string().min(1).optional(),
  mode: z.enum(["home", "away", "night"]).optional(),
  perimeter_mode: z.enum(["home", "away", "night"]).optional(),
  service: z.string().min(1).optional(),
});

const HomeListAreasInputSchema = z.object({}).passthrough();

const CameraSnapshotInputSchema = z.object({
  camera_id: z.string().min(1).optional(),
  cameraId: z.string().min(1).optional(),
  analyze: z.boolean().optional(),
});

/** Entrada de `home.control`. */
export type HomeControlInput = z.infer<typeof HomeControlInputSchema>;

/** Entrada de `home.list_areas`. */
export type HomeListAreasInput = z.infer<typeof HomeListAreasInputSchema>;

/** Entrada de `camera.snapshot`. */
export type CameraSnapshotInput = z.infer<typeof CameraSnapshotInputSchema>;

/**
 * Crea la herramienta unificada de control del hogar.
 *
 * `set_state`, `run_scene` y `arm_perimeter` producen efectos externos y por
 * eso la definición exige aprobación. La lectura de un estado está en la
 * misma interfaz para mantener una superficie de tool estable; además se
 * exporta `createHomeGetStateTool` para consumidores que necesiten una
 * definición exclusivamente de lectura.
 *
 * @param services Servicios de domótica.
 * @returns Definición compatible con `@jarvis/shared`.
 */
export function createHomeControlTool(services: DomoticsToolServices): ToolDefinition<HomeControlInput> {
  return {
    name: "home.control",
    title: "Control del hogar",
    description: "Consulta o modifica entidades, ejecuta escenas y arma el perímetro del hogar.",
    risk: "external_effect",
    requiresApproval: true,
    timeoutMs: 15_000,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_state", "get_state", "run_scene", "arm_perimeter"] },
        entity_id: { type: "string", description: "Entidad de Home Assistant" },
        state: { description: "Nuevo estado de la entidad", oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
        scene_id: { type: "string", description: "Escena que se debe ejecutar" },
        mode: { type: "string", enum: ["home", "away", "night"], description: "Modo perimetral" },
        perimeter_mode: { type: "string", enum: ["home", "away", "night"], description: "Alias del modo perimetral" },
        service: { type: "string", description: "Servicio explícito de Home Assistant" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    parse: (raw) => HomeControlInputSchema.parse(raw),
    availability: () => availabilityForHass(services.hass),
    execute: async (input, ctx) => executeHomeControl(input, ctx, services),
  };
}

/**
 * Crea la herramienta de lectura de áreas.
 *
 * @param services Servicios de domótica.
 * @returns Definición compatible con `@jarvis/shared`.
 */
export function createHomeListAreasTool(services: DomoticsToolServices): ToolDefinition<HomeListAreasInput> {
  return {
    name: "home.list_areas",
    title: "Listar áreas del hogar",
    description: "Lista las áreas registradas en Home Assistant.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 5_000,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    parse: (raw) => HomeListAreasInputSchema.parse(raw ?? {}),
    availability: () => availabilityForHass(services.hass),
    execute: async (_input, ctx) => {
      try {
        const areas = await services.hass.list_areas(ctx.signal);
        return {
          ok: true,
          data: { areas, count: areas.length },
          summary: areas.length ? `${areas.length} área(s) registradas.` : "No hay áreas registradas.",
          unavailable: false,
        };
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  };
}

/**
 * Crea la herramienta de captura de cámara.
 *
 * @param services Servicios de domótica.
 * @returns Definición compatible con `@jarvis/shared`.
 */
export function createCameraSnapshotTool(services: DomoticsToolServices): ToolDefinition<CameraSnapshotInput> {
  return {
    name: "camera.snapshot",
    title: "Capturar cámara",
    description: "Captura una imagen de una cámara perimetral y opcionalmente la analiza con visión.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 20_000,
    parameters: {
      type: "object",
      properties: {
        camera_id: { type: "string", description: "Identificador de la cámara" },
        cameraId: { type: "string", description: "Alias del identificador de la cámara" },
        analyze: { type: "boolean", description: "Solicita análisis de visión opcional" },
      },
      additionalProperties: false,
    },
    parse: (raw) => CameraSnapshotInputSchema.parse(raw),
    availability: () => {
      const cameras = services.cameras.list();
      if (cameras.length === 0) return { available: false, reason: "No hay cámaras configuradas." };
      return { available: true };
    },
    execute: async (input, ctx) => {
      const cameraId = input.camera_id ?? input.cameraId;
      if (!cameraId) {
        return {
          ok: false,
          summary: "Falta el identificador de la cámara.",
          unavailable: false,
          error: "invalid_input",
        };
      }
      try {
        const snapshot = await services.cameras.snapshot(cameraId, { signal: ctx.signal, analyze: input.analyze });
        const result: CameraSnapshotResult = snapshot;
        return {
          ok: true,
          data: result,
          summary: `Instantánea capturada de ${cameraId}.`,
          unavailable: false,
        };
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  };
}

/**
 * Crea una herramienta independiente y de solo lectura para consultar el
 * estado de una entidad.
 *
 * @param services Servicios de domótica.
 * @returns Definición compatible con `@jarvis/shared`.
 */
export function createHomeGetStateTool(services: DomoticsToolServices): ToolDefinition<{ entity_id: string }> {
  const schema = z.object({ entity_id: z.string().min(1) });
  return {
    name: "home.get_state",
    title: "Consultar estado del hogar",
    description: "Lee el estado actual de una entidad de Home Assistant.",
    risk: "public_read",
    requiresApproval: false,
    timeoutMs: 5_000,
    parameters: {
      type: "object",
      properties: { entity_id: { type: "string", description: "Entidad de Home Assistant" } },
      required: ["entity_id"],
      additionalProperties: false,
    },
    parse: (raw) => schema.parse(raw),
    availability: () => availabilityForHass(services.hass),
    execute: async (input, ctx) => {
      try {
        const entity = await findEntity(services, input.entity_id, ctx.signal);
        if (!entity) {
          return { ok: false, summary: `No existe la entidad ${input.entity_id}.`, unavailable: false, error: "not_found" };
        }
        return {
          ok: true,
          data: entity,
          summary: `${entity.friendly_name}: ${entity.state}.`,
          unavailable: false,
        };
      } catch (error: unknown) {
        return failedToolResult(error);
      }
    },
  };
}

/**
 * Crea el conjunto de herramientas públicas del subsistema.
 *
 * @param services Servicios de domótica.
 * @returns Herramientas `home.control`, `home.list_areas` y `camera.snapshot`.
 */
export function createDomoticsTools(services: DomoticsToolServices): ToolDefinition[] {
  return [
    createHomeControlTool(services),
    createHomeListAreasTool(services),
    createCameraSnapshotTool(services),
  ];
}

/**
 * Ejecuta las cuatro acciones de `home.control`.
 *
 * @param input Entrada validada.
 * @param ctx Contexto de ejecución.
 * @param services Servicios de domótica.
 * @returns Resultado de la herramienta.
 */
async function executeHomeControl(
  input: HomeControlInput,
  ctx: ToolContext,
  services: DomoticsToolServices,
): Promise<ToolResult> {
  try {
    if (input.action === "set_state") {
      if (!input.entity_id || input.state === undefined) {
        return invalidInput("set_state requiere entity_id y state.");
      }
      const entity = services.entities.get(input.entity_id);
      const domain = entity?.domain ?? input.entity_id.split(".", 1)[0] ?? "homeassistant";
      const service = input.service ?? serviceForState(domain, input.state);
      if (!service) {
        return invalidInput(`El dominio ${domain} no admite el estado indicado.`);
      }
      const serviceData: Record<string, unknown> = { entity_id: input.entity_id };
      if (input.service !== undefined) {
        serviceData.state = input.state;
      } else if (domain === "climate" && typeof input.state === "number") {
        serviceData.temperature = input.state;
      } else if (domain === "light" && typeof input.state === "number") {
        serviceData.brightness = input.state;
      }
      await services.hass.call_service(domain, service, serviceData, { entity_id: input.entity_id }, ctx.signal);
      return {
        ok: true,
        data: { entity_id: input.entity_id, domain, service, state: input.state },
        summary: `Se envió ${service} a ${input.entity_id}.`,
        unavailable: false,
      };
    }

    if (input.action === "get_state") {
      if (!input.entity_id) return invalidInput("get_state requiere entity_id.");
      const entity = await findEntity(services, input.entity_id, ctx.signal);
      if (!entity) {
        return { ok: false, summary: `No existe la entidad ${input.entity_id}.`, unavailable: false, error: "not_found" };
      }
      return {
        ok: true,
        data: entity,
        summary: `${entity.friendly_name}: ${entity.state}.`,
        unavailable: false,
      };
    }

    if (input.action === "run_scene") {
      if (!input.scene_id) return invalidInput("run_scene requiere scene_id.");
      await services.hass.call_service("scene", "turn_on", { entity_id: input.scene_id }, undefined, ctx.signal);
      return {
        ok: true,
        data: { scene_id: input.scene_id },
        summary: `Se ejecutó la escena ${input.scene_id}.`,
        unavailable: false,
      };
    }

    const mode = input.perimeter_mode ?? input.mode;
    if (!mode) return invalidInput("arm_perimeter requiere mode o perimeter_mode.");
    const activeMode = await services.perimeter.arm(mode, ctx.signal);
    return {
      ok: true,
      data: { mode: activeMode },
      summary: `Perímetro armado en modo ${activeMode}.`,
      unavailable: false,
    };
  } catch (error: unknown) {
    return failedToolResult(error);
  }
}

/**
 * Busca una entidad en la caché y, si no está, consulta Home Assistant.
 *
 * @param services Servicios de domótica.
 * @param entityId Identificador de la entidad.
 * @param signal Señal opcional de cancelación.
 * @returns Entidad encontrada o `undefined`.
 */
async function findEntity(
  services: DomoticsToolServices,
  entityId: string,
  signal?: AbortSignal,
): Promise<EntityRegistryItem | undefined> {
  const cached = services.entities.get(entityId);
  if (cached) return cached;
  const states = await services.hass.get_states(signal);
  return states.find((entity) => entity.entity_id === entityId);
}

/**
 * Calcula el servicio de Home Assistant adecuado para un estado.
 *
 * @param domain Dominio de la entidad.
 * @param state Estado solicitado.
 * @returns Nombre del servicio o `undefined` si no se puede convertir.
 */
function serviceForState(domain: string, state: string | number | boolean): string | undefined {
  const normalized = typeof state === "string" ? state.trim().toLowerCase() : state;
  const isOn = normalized === true || normalized === "true" || normalized === "on" || normalized === "1" || normalized === 1;
  const isOff = normalized === false || normalized === "false" || normalized === "off" || normalized === "0" || normalized === 0;
  if (domain === "lock") {
    if (isOn || normalized === "locked") return "lock";
    if (isOff || normalized === "unlocked") return "unlock";
    return undefined;
  }
  if (domain === "cover") {
    if (isOn || normalized === "open") return "open_cover";
    if (isOff || normalized === "closed") return "close_cover";
    return undefined;
  }
  if (domain === "climate" && typeof state === "number") return "set_temperature";
  if (domain === "switch" || domain === "light" || domain === "fan" || domain === "input_boolean") {
    if (isOn) return "turn_on";
    if (isOff) return "turn_off";
    if (domain === "light" && typeof normalized === "number") return "turn_on";
    return undefined;
  }
  if (isOn) return "turn_on";
  if (isOff) return "turn_off";
  return undefined;
}

/**
 * Construye el resultado de disponibilidad de las herramientas de Home
 * Assistant.
 *
 * @param hass Cliente que puede indicar si está configurado.
 * @returns Resultado compatible con `ToolDefinition.availability`.
 */
function availabilityForHass(hass: HassToolClient): { available: boolean; reason?: string } {
  if (hass.isConfigured && !hass.isConfigured()) {
    return { available: false, reason: "Home Assistant no está configurado." };
  }
  return { available: true };
}

/**
 * Construye un resultado de entrada inválida.
 *
 * @param message Mensaje para la persona usuaria.
 * @returns Resultado de herramienta.
 */
function invalidInput(message: string): ToolResult {
  return { ok: false, summary: message, unavailable: false, error: "invalid_input" };
}

/**
 * Normaliza un error de ejecución como resultado de herramienta.
 *
 * @param error Error capturado.
 * @returns Resultado de herramienta sin filtrar datos sensibles.
 */
function failedToolResult(error: unknown): ToolResult {
  const normalized = toDomoticsError(error);
  return {
    ok: false,
    summary: normalized.message,
    unavailable: normalized.kind === "configuration",
    error: normalized.message,
  };
}
