import type {
  Area,
  EntityRegistryItem,
  EntityStateChangedEvent,
  Scene,
} from "./types.js";

/** Fuente de datos mínima que necesita el registro de entidades. */
export interface EntitySource {
  /** Obtiene los estados actuales. */
  get_states(signal?: AbortSignal): Promise<EntityRegistryItem[]>;
  /** Obtiene, si está disponible, el registro de entidades. */
  list_entities?(signal?: AbortSignal): Promise<EntityRegistryItem[]>;
  /** Obtiene, si está disponible, las áreas registradas. */
  list_areas?(signal?: AbortSignal): Promise<Area[]>;
  /** Obtiene, si está disponible, las escenas registradas. */
  list_scenes?(signal?: AbortSignal): Promise<Scene[]>;
  /** Recibe cambios de estado si la fuente los publica. */
  onStateChanged?(listener: (event: EntityStateChangedEvent) => void): () => void;
}

/** Capacidades que puede tener una entidad de domótica. */
export interface EntityCapabilities {
  /** Puede activar o desactivar un interruptor. */
  switch: boolean;
  /** Puede regular o encender una luz. */
  light: boolean;
  /** Puede bloquear o desbloquear una cerradura. */
  lock: boolean;
  /** Puede modificar el clima o la temperatura. */
  climate: boolean;
  /** Puede producir una imagen. */
  camera: boolean;
  /** Es un sensor de valor continuo. */
  sensor: boolean;
  /** Es un sensor binario de apertura, movimiento o presencia. */
  binary_sensor: boolean;
  /** Es una escena ejecutable. */
  scene: boolean;
}

/** Capacidades indivisibles que se pueden consultar. */
export type EntityCapability = keyof EntityCapabilities;

/** Criterios de búsqueda del registro de entidades. */
export interface EntitySearchCriteria {
  /** Dominio exacto, por ejemplo `light`. */
  domain?: string;
  /** Identificador de área. */
  area?: string;
  /** Clase de dispositivo. */
  deviceClass?: string;
  /** Nombre visible, con coincidencia exacta o parcial. */
  name?: string;
}

/**
 * Registro de entidades de Home Assistant con búsqueda y capacidades.
 *
 * El registro se sincroniza al arrancar y mantiene una caché indexada por
 * `entity_id`. Las búsquedas son locales y no vuelven a consultar el servidor.
 */
export class EntityRegistry {
  private readonly cache = new Map<string, EntityRegistryItem>();
  private areaCache: Area[] = [];
  private sceneCache: Scene[] = [];
  private removeStateListener?: () => void;

  /**
   * Crea el registro sobre una fuente de Home Assistant.
   *
   * @param source Cliente o fake que implementa las operaciones de lectura.
   */
  constructor(private readonly source: EntitySource) {
    this.ensureStateListener();
  }

  /**
   * Sincroniza el registro, sus áreas y sus escenas.
   *
   * @param signal Señal opcional para cancelar las lecturas.
   * @returns Número de entidades que quedaron en la caché.
   */
  async sync(signal?: AbortSignal): Promise<number> {
    this.ensureStateListener();
    const registryPromise = this.source.list_entities ? this.source.list_entities(signal) : Promise.resolve([]);
    const [registryEntities, stateEntities, areas, scenes] = await Promise.all([
      registryPromise,
      this.source.get_states(signal),
      this.source.list_areas ? this.source.list_areas(signal) : Promise.resolve([]),
      this.source.list_scenes ? this.source.list_scenes(signal) : Promise.resolve([]),
    ]);

    const merged = new Map<string, EntityRegistryItem>();
    for (const entity of registryEntities) merged.set(entity.entity_id, entity);
    for (const entity of stateEntities) {
      const previous = merged.get(entity.entity_id);
      merged.set(entity.entity_id, previous ? mergeEntity(previous, entity) : entity);
    }

    this.cache.clear();
    for (const [entityId, entity] of merged) this.cache.set(entityId, entity);
    this.areaCache = [...areas];
    this.sceneCache = [...scenes];
    return this.cache.size;
  }

  /**
   * Devuelve todas las entidades cacheadas.
   *
   * @returns Copia de la lista de entidades.
   */
  list(): EntityRegistryItem[] {
    return [...this.cache.values()];
  }

  /**
   * Devuelve todas las entidades cacheadas.
   *
   * @returns Copia de la lista de entidades.
   */
  getAll(): EntityRegistryItem[] {
    return this.list();
  }

  /**
   * Busca una entidad por su identificador.
   *
   * @param entityId Identificador de la entidad.
   * @returns Entidad cacheada o `undefined`.
   */
  get(entityId: string): EntityRegistryItem | undefined {
    return this.cache.get(entityId);
  }

  /**
   * Busca metadatos de una entidad sin exponer el objeto mutable de la caché.
   *
   * @param entityId Identificador de la entidad.
   * @returns Copia de los metadatos o `undefined`.
   */
  getMetadata(entityId: string): EntityRegistryItem | undefined {
    const entity = this.get(entityId);
    if (!entity) return undefined;
    return {
      ...entity,
      attributes: { ...entity.attributes },
    };
  }

  /**
   * Busca entidades por varios criterios combinables.
   *
   * @param criteria Criterios de búsqueda.
   * @returns Entidades que satisfacen todos los criterios indicados.
   */
  search(criteria: EntitySearchCriteria): EntityRegistryItem[] {
    return this.list().filter((entity) => {
      if (criteria.domain && entity.domain !== criteria.domain) return false;
      if (criteria.area && entity.area !== criteria.area) return false;
      if (criteria.deviceClass && entity.device_class !== criteria.deviceClass) return false;
      if (criteria.name && !matchesName(entity.friendly_name, criteria.name)) return false;
      return true;
    });
  }

  /**
   * Alias de `search` para llamadas que usan la palabra `find`.
   *
   * @param criteria Criterios de búsqueda.
   * @returns Entidades que satisfacen los criterios.
   */
  find(criteria: EntitySearchCriteria): EntityRegistryItem[] {
    return this.search(criteria);
  }

  /**
   * Busca entidades de un dominio.
   *
   * @param domain Dominio exacto.
   * @returns Entidades del dominio.
   */
  findByDomain(domain: string): EntityRegistryItem[] {
    return this.search({ domain });
  }

  /**
   * Busca entidades de un área.
   *
   * @param area Identificador del área.
   * @returns Entidades del área.
   */
  findByArea(area: string): EntityRegistryItem[] {
    return this.search({ area });
  }

  /**
   * Busca entidades por clase de dispositivo.
   *
   * @param deviceClass Clase exacta.
   * @returns Entidades de la clase.
   */
  findByDeviceClass(deviceClass: string): EntityRegistryItem[] {
    return this.search({ deviceClass });
  }

  /**
   * Busca entidades por nombre visible.
   *
   * @param name Nombre exacto o parcial.
   * @returns Entidades coincidentes.
   */
  findByName(name: string): EntityRegistryItem[] {
    return this.search({ name });
  }

  /**
   * Expone las áreas cacheadas.
   *
   * @returns Copia de las áreas.
   */
  getAreas(): Area[] {
    return [...this.areaCache];
  }

  /**
   * Expone las escenas cacheadas.
   *
   * @returns Copia de las escenas.
   */
  getScenes(): Scene[] {
    return [...this.sceneCache];
  }

  /** Áreas cacheadas, en formato de propiedad de solo lectura. */
  get areas(): Area[] {
    return this.getAreas();
  }

  /** Escenas cacheadas, en formato de propiedad de solo lectura. */
  get scenes(): Scene[] {
    return this.getScenes();
  }

  /**
   * Calcula las capacidades de una entidad.
   *
   * @param entity Entidad a analizar.
   * @returns Capacidades detectadas.
   */
  capabilitiesFor(entity: EntityRegistryItem): EntityCapabilities {
    const capabilities: EntityCapabilities = {
      switch: false,
      light: false,
      lock: false,
      climate: false,
      camera: false,
      sensor: false,
      binary_sensor: false,
      scene: false,
    };
    switch (entity.domain) {
      case "switch":
        capabilities.switch = true;
        break;
      case "light":
        capabilities.light = true;
        break;
      case "lock":
        capabilities.lock = true;
        break;
      case "climate":
        capabilities.climate = true;
        break;
      case "camera":
        capabilities.camera = true;
        break;
      case "sensor":
        capabilities.sensor = true;
        break;
      case "binary_sensor":
        capabilities.binary_sensor = true;
        break;
      case "scene":
        capabilities.scene = true;
        break;
      default:
        break;
    }
    return capabilities;
  }

  /**
   * Consulta las capacidades de una entidad cacheada.
   *
   * @param entityId Identificador de la entidad.
   * @returns Capacidades o `undefined` si no existe la entidad.
   */
  getCapabilities(entityId: string): EntityCapabilities | undefined {
    const entity = this.get(entityId);
    return entity ? this.capabilitiesFor(entity) : undefined;
  }

  /**
   * Alias de `getCapabilities`.
   *
   * @param entityId Identificador de la entidad.
   * @returns Capacidades o `undefined` si no existe la entidad.
   */
  capabilities(entityId: string): EntityCapabilities | undefined {
    return this.getCapabilities(entityId);
  }

  /**
   * Indica si una entidad admite una capacidad.
   *
   * @param entityId Identificador de la entidad.
   * @param capability Capacidad a comprobar.
   * @returns `true` si la entidad existe y admite la capacidad.
   */
  supports(entityId: string, capability: EntityCapability): boolean {
    return this.getCapabilities(entityId)?.[capability] ?? false;
  }

  /**
   * Alias de `supports`.
   *
   * @param entityId Identificador de la entidad.
   * @param capability Capacidad a comprobar.
   * @returns `true` si la entidad admite la capacidad.
   */
  hasCapability(entityId: string, capability: EntityCapability): boolean {
    return this.supports(entityId, capability);
  }

  /**
   * Aplica un cambio de estado recibido en tiempo real.
   *
   * @param event Evento normalizado de cambio de estado.
   */
  private applyStateChange(event: EntityStateChangedEvent): void {
    const current = this.cache.get(event.entity_id);
    if (!current) {
      const attributes = { ...(event.attributes ?? {}) };
      const friendlyName = typeof attributes.friendly_name === "string" ? attributes.friendly_name : event.entity_id;
      this.cache.set(event.entity_id, {
        entity_id: event.entity_id,
        domain: event.entity_id.split(".", 1)[0] ?? event.entity_id,
        friendly_name: friendlyName,
        state: event.new_state,
        attributes,
      });
      return;
    }
    const updated: EntityRegistryItem = {
      ...current,
      state: event.new_state,
    };
    if (event.attributes) updated.attributes = { ...event.attributes };
    this.cache.set(event.entity_id, updated);
  }

  /**
   * Registra el listener de cambios si la fuente lo ofrece.
   */
  private ensureStateListener(): void {
    if (this.removeStateListener || !this.source.onStateChanged) return;
    this.removeStateListener = this.source.onStateChanged((event) => {
      this.applyStateChange(event);
    });
  }

  /**
   * Libera el listener de cambios de estado.
   */
  dispose(): void {
    this.removeStateListener?.();
    this.removeStateListener = undefined;
  }
}

/** Alias de `EntityRegistry` para integraciones que lo llaman almacén. */
export type EntityStore = EntityRegistry;
export const EntityStore = EntityRegistry;

/**
 * Fusiona la entidad del registro con el estado actual.
 *
 * @param registry Entidad del registro de entidades.
 * @param state Entidad del estado actual.
 * @returns Entidad combinada, conservando los metadatos del registro.
 */
function mergeEntity(registry: EntityRegistryItem, state: EntityRegistryItem): EntityRegistryItem {
  const merged: EntityRegistryItem = {
    ...registry,
    state: state.state,
    attributes: { ...state.attributes },
  };
  if (state.friendly_name) merged.friendly_name = state.friendly_name;
  if (state.area) merged.area = state.area;
  if (state.device_class) merged.device_class = state.device_class;
  return merged;
}

/**
 * Compara nombres sin distinguir mayúsculas y acepta coincidencias parciales.
 *
 * @param friendlyName Nombre visible de la entidad.
 * @param query Texto buscado.
 * @returns `true` si hay coincidencia.
 */
function matchesName(friendlyName: string, query: string): boolean {
  const normalizedName = friendlyName.trim().toLocaleLowerCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return normalizedName === normalizedQuery || normalizedName.includes(normalizedQuery);
}
