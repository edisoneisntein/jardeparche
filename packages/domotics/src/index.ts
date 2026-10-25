import type { ToolDefinition } from "@jarvis/shared";
import { CameraService } from "./cameras.js";
import { EntityRegistry } from "./entities.js";
import { HassClient } from "./hass-client.js";
import { createMatterClient } from "./matter.js";
import { PerimeterService } from "./perimeter.js";
import { createDomoticsTools } from "./tools.js";
import type { DomoticsConfig, MatterClient } from "./types.js";

/** Fachada funcional del subsistema de domótica. */
export interface Domotics {
  /** Cliente WebSocket de Home Assistant. */
  hass: HassClient;
  /** Registro cacheado de entidades. */
  entities: EntityRegistry;
  /** Cliente Matter/Thread seleccionado. */
  matter: MatterClient;
  /** Servicio de captura de cámaras. */
  cameras: CameraService;
  /** Controlador del modo perimetral. */
  perimeter: PerimeterService;
  /** Herramientas públicas para el runtime. */
  tools: ToolDefinition[];
  /** Arranca Home Assistant y sincroniza el registro de entidades. */
  start(signal?: AbortSignal): Promise<void>;
  /** Detiene las conexiones activas. */
  stop(): Promise<void>;
}

/**
 * Crea la fachada de domótica con todas sus dependencias.
 *
 * Home Assistant es opcional: sin configuración, el cliente se conserva
 * para que las herramientas puedan informar correctamente de que la
 * integración no está disponible. Matter utiliza un cliente en memoria si no
 * se indica ningún transporte, y las herramientas de cámara solo quedan
 * disponibles cuando hay cámaras configuradas.
 *
 * @param config Configuración de Home Assistant, Matter, cámaras y perímetro.
 * @returns Fachada lista para iniciar.
 */
export function createDomotics(config: DomoticsConfig = {}): Domotics {
  const hassConfig = config.hass ?? config.homeAssistant;
  const hass = new HassClient(hassConfig, config.webSocketFactory ? { webSocketFactory: config.webSocketFactory } : {});
  const entities = new EntityRegistry(hass);
  const matter = createMatterClient(config.matter);
  const cameras = new CameraService(config.cameras ?? { cameras: [] }, config.vision);
  const perimeter = new PerimeterService(hass, config.perimeter);
  const tools = createDomoticsTools({ hass, entities, perimeter, cameras });

  return {
    hass,
    entities,
    matter,
    cameras,
    perimeter,
    tools,
    start: async (signal?: AbortSignal): Promise<void> => {
      if (hass.isConfigured()) {
        await hass.start(signal);
        await entities.sync();
      }
    },
    stop: async (): Promise<void> => {
      await hass.stop();
      entities.dispose();
    },
  };
}

export * from "./types.js";
export * from "./errors.js";
export * from "./hass-client.js";
export * from "./entities.js";
export * from "./matter.js";
export * from "./cameras.js";
export * from "./perimeter.js";
export * from "./tools.js";
