import { DomoticsError, toDomoticsError } from "./errors.js";
import type { PerimeterConfig, PerimeterMode, PerimeterModeChangedEvent } from "./types.js";

/** Cliente mínimo que necesita el controlador perimetral. */
export interface PerimeterHassClient {
  /** Invoca un servicio de Home Assistant. */
  call_service(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Listener de cambios del modo perimetral. */
export type PerimeterListener = (event: PerimeterModeChangedEvent) => void;

/**
 * Controlador del modo perimetral.
 *
 * Si se configura `modeEntityId`, el modo se representa mediante una entidad
 * `input_select` de Home Assistant y cada armado se publica con
 * `input_select.select_option`. Sin esa entidad, el controlador conserva el
 * estado local y permite delegarlo mediante `onModeChanged`.
 */
export class PerimeterService {
  private mode: PerimeterMode = "home";
  private readonly listeners = new Set<PerimeterListener>();

  /**
   * Crea el controlador perimetral.
   *
   * @param hass Cliente de Home Assistant para publicar el modo.
   * @param config Entidad de modo y callback alternativo.
   */
  constructor(
    private readonly hass: PerimeterHassClient,
    private readonly config: PerimeterConfig = {},
  ) {}

  /**
   * Obtiene el modo actual.
   *
   * @returns Modo perimetral vigente.
   */
  getMode(): PerimeterMode {
    return this.mode;
  }

  /**
   * Alias de `getMode`.
   *
   * @returns Modo perimetral vigente.
   */
  getCurrentMode(): PerimeterMode {
    return this.getMode();
  }

  /**
   * Registra un listener de cambios.
   *
   * @param listener Función que recibirá el evento.
   * @returns Función para retirar el listener.
   */
  subscribe(listener: PerimeterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Arma el perímetro en el modo indicado.
   *
   * @param nextMode Modo que se debe activar.
   * @param signal Señal opcional para cancelar la operación.
   * @returns Modo que quedó activo.
   */
  async arm(nextMode: PerimeterMode, signal?: AbortSignal): Promise<PerimeterMode> {
    if (nextMode !== "home" && nextMode !== "away" && nextMode !== "night") {
      throw new DomoticsError("configuration", "El modo perimetral solicitado no es válido.");
    }
    const previousMode = this.mode;
    try {
      if (this.config.modeEntityId) {
        await this.hass.call_service(
          "input_select",
          "select_option",
          { entity_id: this.config.modeEntityId, option: nextMode },
          undefined,
          signal,
        );
      }
      if (this.config.onModeChanged) {
        await this.config.onModeChanged(nextMode, previousMode);
      }
    } catch (error: unknown) {
      throw toDomoticsError(error, "connection");
    }

    this.mode = nextMode;
    const event: PerimeterModeChangedEvent = {
      type: "perimeter_mode_changed",
      mode: nextMode,
      previous_mode: previousMode,
      changed_at: new Date().toISOString(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        void toDomoticsError(error, "unknown");
      }
    }
    return this.mode;
  }

  /**
   * Alias de `arm`.
   *
   * @param nextMode Modo que se debe activar.
   * @param signal Señal opcional para cancelar la operación.
   * @returns Modo que quedó activo.
   */
  async setMode(nextMode: PerimeterMode, signal?: AbortSignal): Promise<PerimeterMode> {
    return this.arm(nextMode, signal);
  }
}

/** Alias de `PerimeterService` para consumidores que lo llaman manager. */
export type PerimeterManager = PerimeterService;
export const PerimeterManager = PerimeterService;
