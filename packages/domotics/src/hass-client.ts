import { DomoticsError, toDomoticsError } from "./errors.js";
import type {
  Area,
  EntityRegistryItem,
  EntityStateChangedEvent,
  HassClientOptions,
  HassConfig,
  HassEvent,
  HassReconnectConfig,
  HassWebSocket,
  HassWebSocketEvent,
  HassWebSocketFactory,
  Scene,
} from "./types.js";

/** Catálogo de servicios devuelto por `get_services`. */
export interface HassServiceCatalog {
  [domain: string]: string[];
}

/** Dispositivo registrado en Home Assistant. */
export interface HassDevice {
  /** Identificador estable del dispositivo. */
  id: string;
  /** Nombre configurado por la persona usuaria. */
  name?: string;
  /** Nombre predeterminado del dispositivo. */
  name_by_user?: string;
  /** Fabricante del dispositivo. */
  manufacturer?: string;
  /** Modelo del dispositivo. */
  model?: string;
  /** Identificadores del fabricante. */
  identifiers?: string[][];
  /** Área a la que pertenece el dispositivo. */
  area_id?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export type HassEventListener = (event: HassEvent) => void;
export type StateChangedListener = (event: EntityStateChangedEvent) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const OPEN_WEBSOCKET_STATE = 1;
const CLOSED_WEBSOCKET_STATE = 3;

/**
 * Cliente del protocolo WebSocket oficial de Home Assistant.
 *
 * La implementación sigue el flujo real `auth_required` → `auth` →
 * `auth_ok`, correlaciona cada orden por su identificador numérico, atiende
 * `event`, `ping` y `pong`, y mantiene una reconexión exponencial después de
 * una conexión autenticada. La factoría de WebSocket es inyectable para que
 * las pruebas no dependan de la red.
 */
export class HassClient {
  private readonly config?: HassConfig;
  private readonly factory: HassWebSocketFactory;
  private readonly reconnectConfig: HassReconnectConfig;
  private readonly requestTimeoutMs: number;
  private externalSignal?: AbortSignal;

  private socket?: HassWebSocket;
  private startPromise?: Promise<void>;
  private started = false;
  private stopping = false;
  private authenticated = false;
  private everAuthenticated = false;
  private handshakeResolve?: () => void;
  private handshakeReject?: (error: Error) => void;
  private handshakeSettled = false;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectAttempt = 0;
  private nextCommandId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<HassEventListener>();
  private readonly stateChangedListeners = new Set<StateChangedListener>();
  private externalAbortHandler?: () => void;

  /**
   * Crea un cliente de Home Assistant.
   *
   * @param config Configuración de URL y token. Si se omite, el cliente queda
   *   deliberadamente no configurado y las herramientas lo informan como no
   *   disponible.
   * @param options Opciones de testing, señal de cancelación y factoría de
   *   WebSocket. También se acepta directamente una función de factoría.
   */
  constructor(config?: HassConfig, options: HassClientOptions | HassWebSocketFactory = {}) {
    this.config = config;
    const normalizedOptions: HassClientOptions = typeof options === "function" ? { webSocketFactory: options } : options;
    this.factory =
      normalizedOptions.webSocketFactory ??
      normalizedOptions.socketFactory ??
      normalizedOptions.createWebSocket ??
      config?.webSocketFactory ??
      defaultWebSocketFactory;
    this.requestTimeoutMs = Math.max(
      1,
      config?.requestTimeoutMs ?? normalizedOptions.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.reconnectConfig = normalizeReconnectConfig(config?.reconnect, normalizedOptions.reconnect);
    this.externalSignal = normalizedOptions.signal;
  }

  /**
   * Indica si el cliente tiene URL y token para establecer una conexión.
   *
   * @returns `true` cuando la integración está configurada.
   */
  isConfigured(): boolean {
    return Boolean(this.config?.url.trim() && this.resolveToken());
  }

  /**
   * Indica si el socket está abierto y autenticado.
   *
   * @returns Estado de disponibilidad de la conexión.
   */
  isConnected(): boolean {
    return this.authenticated && this.socket !== undefined;
  }

  /**
   * Abre la conexión y completa el handshake de autenticación.
   *
   * El primer intento falla de forma explícita si no se puede autenticar. Si
   * una conexión ya autenticada se pierde, los reintentos posteriores se
   * ejecutan en segundo plano con espera exponencial.
   *
   * @param signal Señal opcional que cancela el ciclo de vida.
   * @returns Promesa que termina cuando Home Assistant acepta la autenticación.
   */
  start(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (!this.isConfigured()) {
      return Promise.reject(
        new DomoticsError("configuration", "Home Assistant no está configurado con una URL y un token."),
      );
    }
    if (signal?.aborted || this.externalSignal?.aborted) {
      return Promise.reject(new DomoticsError("aborted", "La conexión con Home Assistant fue cancelada."));
    }

    this.started = true;
    this.stopping = false;
    this.attachExternalSignal(signal ?? this.externalSignal);

    const promise = this.openAndAuthenticate();
    this.startPromise = promise;
    void promise.catch(() => {
      if (this.startPromise === promise) this.startPromise = undefined;
    });
    return promise;
  }

  /**
   * Detiene la conexión, cancela órdenes pendientes y detiene la reconexión.
   *
   * @returns Promesa resuelta después de cerrar el transporte.
   */
  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.rejectHandshake(new DomoticsError("aborted", "La conexión con Home Assistant fue cancelada."));
    this.rejectAllPending(new DomoticsError("aborted", "La conexión con Home Assistant fue cerrada."));
    this.detachExternalSignal();

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close(1000, "Cliente detenido");
      } catch (error: unknown) {
        void toDomoticsError(error, "connection");
      }
    }
    this.authenticated = false;
    if (this.startPromise) this.startPromise = undefined;
  }

  /**
   * Espera a que el cliente esté autenticado.
   *
   * @returns Promesa resuelta cuando la sesión está lista.
   */
  async waitUntilReady(): Promise<void> {
    if (this.isConnected()) return;
    await this.start();
  }

  /**
   * Alias de `start` para consumidores que llaman `connect` a la conexión.
   *
   * @param signal Señal opcional que cancela el ciclo de vida.
   * @returns Promesa resuelta cuando la sesión está autenticada.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
  }

  /**
   * Registra un listener para todos los eventos de Home Assistant.
   *
   * @param listener Función que recibirá cada evento.
   * @returns Función para retirar el listener.
   */
  onEvent(listener: HassEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Registra un listener para eventos `state_changed`.
   *
   * @param listener Función que recibirá los cambios normalizados.
   * @returns Función para retirar el listener.
   */
  onStateChanged(listener: StateChangedListener): () => void {
    this.stateChangedListeners.add(listener);
    return () => this.stateChangedListeners.delete(listener);
  }

  /**
   * Suscribe el servidor a todos los eventos o a un tipo concreto.
   *
   * @param eventType Tipo opcional de evento de Home Assistant.
   * @param listener Listener opcional que se registra antes de la orden.
   * @returns Promesa resuelta con el resultado del protocolo.
   */
  async subscribe_events(eventType?: string, listener?: HassEventListener): Promise<void> {
    const removeListener = listener ? this.onEvent(listener) : undefined;
    try {
      await this.request(eventType ? { type: "subscribe_events", event_type: eventType } : { type: "subscribe_events" });
    } catch (error: unknown) {
      removeListener?.();
      throw error;
    }
  }

  /**
   * Cancela una suscripción de eventos del servidor.
   *
   * @param eventType Tipo opcional que se quiere cancelar.
   * @returns Promesa resuelta con el resultado del protocolo.
   */
  async unsubscribe_events(eventType?: string): Promise<void> {
    await this.request(eventType ? { type: "unsubscribe_events", event_type: eventType } : { type: "unsubscribe_events" });
  }

  /**
   * Suscribe el cliente a cambios de estado mediante `subscribe_events`.
   *
   * Home Assistant no ofrece un filtro de `entity_id` en el comando
   * `subscribe_events`; cuando se recibe un identificador, el filtrado se
   * realiza localmente sobre el evento ya normalizado.
   *
   * @param entityId Entidad opcional que se debe observar.
   * @param listener Listener opcional para cambios de estado.
   * @returns Promesa resuelta con el resultado del protocolo.
   */
  async subscribe_state_changed(entityId?: string | StateChangedListener, listener?: StateChangedListener): Promise<void> {
    const normalizedEntityId = typeof entityId === "string" ? entityId : undefined;
    const normalizedListener = typeof entityId === "function" ? entityId : listener;
    const removeListener = normalizedListener ? this.onStateChanged(normalizedListener) : undefined;
    try {
      await this.request({ type: "subscribe_events", event_type: "state_changed" });
      this.entityIdFilter = normalizedEntityId;
    } catch (error: unknown) {
      removeListener?.();
      throw error;
    }
  }

  /**
   * Recupera todos los estados actuales de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Entidades normalizadas con sus atributos.
   */
  async get_states(signal?: AbortSignal): Promise<EntityRegistryItem[]> {
    const result = await this.request({ type: "get_states" }, signal);
    return normalizeEntityList(result);
  }

  /**
   * Recupera las entidades del registro de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Entidades normalizadas; el estado se deja como `unknown` si el
   *   registro no lo publica.
   */
  async list_entities(signal?: AbortSignal): Promise<EntityRegistryItem[]> {
    const result = await this.request({ type: "config/entity_registry/list" }, signal);
    return normalizeEntityList(result, true);
  }

  /**
   * Invoca un servicio de Home Assistant.
   *
   * @param domain Dominio del servicio, por ejemplo `light`.
   * @param service Nombre del servicio, por ejemplo `turn_on`.
   * @param serviceData Datos opcionales del servicio.
   * @param target Objetivo opcional del servicio.
   * @param signal Señal opcional para cancelar la orden.
   * @returns Resultado crudo devuelto por Home Assistant.
   */
  async call_service(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const command: Record<string, unknown> = { type: "call_service", domain, service };
    if (serviceData) command.service_data = serviceData;
    if (target) command.target = target;
    return this.request(command, signal);
  }

  /**
   * Recupera el catálogo de servicios de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Mapa de dominios y nombres de servicio.
   */
  async list_services(signal?: AbortSignal): Promise<HassServiceCatalog> {
    const result = await this.request({ type: "get_services" }, signal);
    return normalizeServiceCatalog(result);
  }

  /**
   * Recupera las áreas del registro de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Áreas normalizadas.
   */
  async list_areas(signal?: AbortSignal): Promise<Area[]> {
    const result = await this.request({ type: "config/area_registry/list" }, signal);
    return normalizeAreas(result);
  }

  /**
   * Recupera las escenas del registro de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Escenas normalizadas.
   */
  async list_scenes(signal?: AbortSignal): Promise<Scene[]> {
    const result = await this.request({ type: "scene_registry/list" }, signal);
    return normalizeScenes(result);
  }

  /**
   * Recupera los dispositivos del registro de Home Assistant.
   *
   * @param signal Señal opcional para cancelar la orden.
   * @returns Dispositivos normalizados.
   */
  async list_devices(signal?: AbortSignal): Promise<HassDevice[]> {
    const result = await this.request({ type: "config/device_registry/list" }, signal);
    return normalizeDevices(result);
  }

  /** Alias en camelCase de `subscribe_events`. */
  async subscribeEvents(eventType?: string, listener?: HassEventListener): Promise<void> {
    return this.subscribe_events(eventType, listener);
  }

  /** Alias en camelCase de `unsubscribe_events`. */
  async unsubscribeEvents(eventType?: string): Promise<void> {
    return this.unsubscribe_events(eventType);
  }

  /** Alias en camelCase de `subscribe_state_changed`. */
  async subscribeStateChanged(entityId?: string | StateChangedListener, listener?: StateChangedListener): Promise<void> {
    return this.subscribe_state_changed(entityId, listener);
  }

  /** Alias en camelCase de `get_states`. */
  async getStates(signal?: AbortSignal): Promise<EntityRegistryItem[]> {
    return this.get_states(signal);
  }

  /** Alias en camelCase de `list_entities`. */
  async listEntities(signal?: AbortSignal): Promise<EntityRegistryItem[]> {
    return this.list_entities(signal);
  }

  /** Alias en camelCase de `call_service`. */
  async callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.call_service(domain, service, serviceData, target, signal);
  }

  /** Alias en camelCase de `list_services`. */
  async listServices(signal?: AbortSignal): Promise<HassServiceCatalog> {
    return this.list_services(signal);
  }

  /** Alias en camelCase de `list_areas`. */
  async listAreas(signal?: AbortSignal): Promise<Area[]> {
    return this.list_areas(signal);
  }

  /** Alias en camelCase de `list_scenes`. */
  async listScenes(signal?: AbortSignal): Promise<Scene[]> {
    return this.list_scenes(signal);
  }

  /** Alias en camelCase de `list_devices`. */
  async listDevices(signal?: AbortSignal): Promise<HassDevice[]> {
    return this.list_devices(signal);
  }

  /**
   * Calcula la espera de un reintento concreto.
   *
   * @param attempt Número de reintento, empezando en cero.
   * @returns Espera exponencial limitada por `maxDelayMs`.
   */
  getReconnectDelay(attempt = this.reconnectAttempt): number {
    const multiplier = 2 ** Math.min(attempt, 30);
    return Math.min(this.reconnectConfig.maxDelayMs, this.reconnectConfig.initialDelayMs * multiplier);
  }

  /**
   * Envía una orden correlacionada y espera su resultado.
   *
   * @param command Cuerpo del comando sin identificador.
   * @param signal Señal opcional para cancelar la orden.
   * @returns Resultado de la orden.
   */
  private async request(command: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.authenticated || !this.socket) {
      throw new DomoticsError("connection", "Home Assistant no está conectado.");
    }
    if (signal?.aborted) {
      throw new DomoticsError("aborted", "La orden a Home Assistant fue cancelada.");
    }

    const id = this.nextCommandId++;
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abortHandler = (): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(key);
        if (timer) clearTimeout(timer);
        reject(new DomoticsError("aborted", "La orden a Home Assistant fue cancelada."));
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abortHandler);
        this.pending.delete(key);
      };
      const pending: PendingRequest = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
        cleanup,
      };
      this.pending.set(key, pending);
      if (signal) signal.addEventListener("abort", abortHandler, { once: true });
      timer = setTimeout(() => {
        pending.reject(new DomoticsError("timeout", `Home Assistant no respondió a la orden ${id}.`));
      }, this.requestTimeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      try {
        this.sendJson({ id, ...command });
      } catch (error: unknown) {
        pending.reject(toDomoticsError(error, "connection"));
      }
    });
  }

  /**
   * Abre un socket y completa el handshake.
   *
   * @returns Promesa resuelta al recibir `auth_ok`.
   */
  private async openAndAuthenticate(): Promise<void> {
    if (!this.isConfigured()) {
      throw new DomoticsError("configuration", "Home Assistant no está configurado.");
    }
    if (this.stopping || !this.started) {
      throw new DomoticsError("aborted", "La conexión con Home Assistant fue cancelada.");
    }

    const url = toWebSocketUrl(this.config?.url ?? "");
    let socket: HassWebSocket;
    try {
      socket = this.factory(url);
    } catch (error: unknown) {
      throw toDomoticsError(error, "connection");
    }
    this.socket = socket;
    this.attachSocket(socket);

    return new Promise<void>((resolve, reject) => {
      this.handshakeSettled = false;
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeTimer = setTimeout(() => {
        this.rejectHandshake(new DomoticsError("timeout", "Home Assistant no completó el handshake a tiempo."));
      }, this.requestTimeoutMs);
      if (typeof this.handshakeTimer === "object" && "unref" in this.handshakeTimer) this.handshakeTimer.unref();
      if (socket.readyState === OPEN_WEBSOCKET_STATE) this.handleOpen();
    });
  }

  /**
   * Engancha los listeners del transporte WebSocket.
   *
   * @param socket Transporte recién creado.
   */
  private attachSocket(socket: HassWebSocket): void {
    if (socket.addEventListener) {
      socket.addEventListener("open", () => this.handleOpen());
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("error", (event) => this.handleError(event));
      socket.addEventListener("close", (event) => this.handleClose(event));
      return;
    }
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onerror = (event) => this.handleError(event);
    socket.onclose = (event) => this.handleClose(event);
  }

  /**
   * Procesa la apertura del socket.
   */
  private handleOpen(): void {
    if (this.stopping) return;
  }

  /**
   * Procesa un mensaje de texto del protocolo.
   *
   * @param event Evento de transporte con los datos recibidos.
   */
  private handleMessage(event: HassWebSocketEvent): void {
    const text = extractText(event.data ?? event);
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      void toDomoticsError(error, "protocol");
      return;
    }
    if (!isRecord(parsed)) return;
    const type = asString(parsed.type);
    if (!type) return;

    if (type === "auth_required") {
      this.handleAuthRequired();
      return;
    }
    if (type === "auth_ok") {
      this.handleAuthOk();
      return;
    }
    if (type === "auth_invalid") {
      this.rejectHandshake(new DomoticsError("protocol", "Home Assistant rechazó el token de acceso."));
      try {
        this.socket?.close(1008, "Authentication rejected");
      } catch (error: unknown) {
        void toDomoticsError(error, "connection");
      }
      return;
    }
    if (type === "result") {
      this.handleResult(parsed);
      return;
    }
    if (type === "event") {
      this.handleEvent(parsed.event);
      return;
    }
    if (type === "ping") {
      const id = parsed.id;
      if (id !== undefined) this.sendJson({ id, type: "pong" });
      return;
    }
    if (type === "pong") return;
    if (type === "error") {
      const message = errorMessage(parsed);
      this.rejectHandshake(new DomoticsError("protocol", message));
      this.rejectAllPending(new DomoticsError("protocol", message));
    }
  }

  /**
   * Envía las credenciales después de `auth_required`.
   */
  private handleAuthRequired(): void {
    const token = this.resolveToken();
    if (!token) {
      this.rejectHandshake(new DomoticsError("configuration", "Home Assistant no tiene un token de acceso configurado."));
      return;
    }
    try {
      this.sendJson({ type: "auth", access_token: token });
    } catch (error: unknown) {
      this.rejectHandshake(toDomoticsError(error, "connection"));
    }
  }

  /**
   * Marca la sesión como autenticada y completa el arranque.
   */
  private handleAuthOk(): void {
    this.authenticated = true;
    this.everAuthenticated = true;
    this.reconnectAttempt = 0;
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      try {
        this.sendJson({ id: this.nextCommandId++, type: "ping" });
      } catch (error: unknown) {
        void toDomoticsError(error, "connection");
      }
    }, PING_INTERVAL_MS);
    if (typeof this.pingTimer === "object" && "unref" in this.pingTimer) this.pingTimer.unref();
    if (!this.handshakeSettled) {
      this.handshakeSettled = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeResolve?.();
    }
  }

  /**
   * Resuelve una orden por el identificador de correlación.
   *
   * @param message Mensaje `result` recibido.
   */
  private handleResult(message: Record<string, unknown>): void {
    const id = message.id;
    if (id === undefined) return;
    const pending = this.pending.get(String(id));
    if (!pending) return;
    if (message.success === false) {
      pending.reject(new DomoticsError("protocol", errorMessage(message)));
      return;
    }
    pending.resolve(message.result);
  }

  /**
   * Normaliza y distribuye un evento de Home Assistant.
   *
   * @param rawEvent Evento bruto recibido dentro del mensaje WebSocket.
   */
  private handleEvent(rawEvent: unknown): void {
    if (!isRecord(rawEvent)) return;
    const eventType = asString(rawEvent.event_type);
    if (!eventType) return;
    const event: HassEvent = {
      event_type: eventType,
      data: isRecord(rawEvent.data) ? rawEvent.data : {},
    };
    const timeFired = asString(rawEvent.time_fired);
    if (timeFired) event.time_fired = timeFired;
    const origin = asString(rawEvent.origin);
    if (origin) event.origin = origin;

    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        void toDomoticsError(error, "unknown");
      }
    }

    if (eventType !== "state_changed") return;
    const entityId = asString(event.data.entity_id);
    const newState = isRecord(event.data.new_state) ? asString(event.data.new_state.state) : undefined;
    if (!entityId || newState === undefined) return;
    if (this.entityIdFilter && this.entityIdFilter !== entityId) return;
    const oldState = isRecord(event.data.old_state) ? asString(event.data.old_state.state) : undefined;
    const newStateRecord = isRecord(event.data.new_state) ? event.data.new_state : undefined;
    const newAttributes = newStateRecord && isRecord(newStateRecord.attributes) ? newStateRecord.attributes : undefined;
    const changed: EntityStateChangedEvent = {
      type: "entity_state_changed",
      entity_id: entityId,
      new_state: newState,
      changed_at: timeFired ?? new Date().toISOString(),
    };
    if (oldState !== undefined) changed.old_state = oldState;
    if (newAttributes) changed.attributes = newAttributes;
    for (const listener of this.stateChangedListeners) {
      try {
        listener(changed);
      } catch (error: unknown) {
        void toDomoticsError(error, "unknown");
      }
    }
  }

  /**
   * Procesa un error del transporte.
   *
   * @param event Evento de error recibido.
   */
  private handleError(event: HassWebSocketEvent): void {
    const detail = event.data instanceof Error ? event.data.message : "Error de transporte WebSocket.";
    const error = new DomoticsError("connection", detail, { cause: event.data });
    if (!this.authenticated) this.rejectHandshake(error);
    this.rejectAllPending(error);
  }

  /**
   * Procesa el cierre del transporte y programa una reconexión si procede.
   *
   * @param event Evento de cierre recibido.
   */
  private handleClose(event: HassWebSocketEvent): void {
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    this.clearPingTimer();
    this.rejectHandshake(new DomoticsError("connection", "La conexión con Home Assistant se cerró."));
    this.rejectAllPending(new DomoticsError("connection", "La conexión con Home Assistant se cerró."));
    if (wasAuthenticated || this.everAuthenticated) this.scheduleReconnect();
    void event;
  }

  /**
   * Programa una reconexión exponencial.
   */
  private scheduleReconnect(): void {
    if (!this.started || this.stopping || this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.reconnectConfig.maxAttempts) return;
    const delay = this.getReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openAndAuthenticate().catch((error: unknown) => {
        void toDomoticsError(error, "connection");
        this.scheduleReconnect();
      });
    }, delay);
    if (typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) this.reconnectTimer.unref();
  }

  /**
   * Envía un objeto JSON por el socket activo.
   *
   * @param message Mensaje que se serializa y envía.
   */
  private sendJson(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState === CLOSED_WEBSOCKET_STATE) {
      throw new DomoticsError("connection", "Home Assistant no está conectado.");
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (error: unknown) {
      throw toDomoticsError(error, "connection");
    }
  }

  /**
   * Resuelve la promesa de handshake una sola vez.
   *
   * @param error Error que termina el handshake.
   */
  private rejectHandshake(error: Error): void {
    if (this.handshakeSettled) return;
    this.handshakeSettled = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeReject?.(error);
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
  }

  /**
   * Rechaza todas las órdenes pendientes.
   *
   * @param error Error que se entrega a cada orden.
   */
  private rejectAllPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  /**
   * Elimina el temporizador de reconexión.
   */
  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /**
   * Elimina el temporizador de ping.
   */
  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /**
   * Conecta una señal externa al ciclo de vida.
   *
   * @param signal Señal que se debe observar.
   */
  private attachExternalSignal(signal?: AbortSignal): void {
    this.detachExternalSignal();
    this.externalSignal = signal;
    if (!signal) return;
    if (signal.aborted) {
      void this.stop();
      return;
    }
    this.externalAbortHandler = () => {
      void this.stop();
    };
    signal.addEventListener("abort", this.externalAbortHandler, { once: true });
  }

  /**
   * Desconecta la señal externa del ciclo de vida.
   */
  private detachExternalSignal(): void {
    if (!this.externalSignal || !this.externalAbortHandler) return;
    this.externalSignal.removeEventListener("abort", this.externalAbortHandler);
    this.externalAbortHandler = undefined;
  }

  /**
   * Obtiene el token configurado sin exponerlo en errores.
   *
   * @returns Token de acceso o `undefined`.
   */
  private resolveToken(): string | undefined {
    const token = this.config?.token ?? this.config?.accessToken ?? this.config?.access_token;
    const trimmed = token?.trim();
    return trimmed ? trimmed : undefined;
  }

  /** Filtro local opcional para `subscribe_state_changed`. */
  private entityIdFilter?: string;
}

/**
 * Alias descriptivo para consumidores que prefieren el nombre completo.
 */
export type HomeAssistantClient = HassClient;
export const HomeAssistantClient = HassClient;

/**
 * Normaliza una configuración de reconexión y aplica valores por defecto.
 *
 * @param fromConfig Política procedente de la configuración.
 * @param fromOptions Política procedente de las opciones del constructor.
 * @returns Política completa y validada.
 */
function normalizeReconnectConfig(
  fromConfig?: Partial<HassReconnectConfig>,
  fromOptions?: Partial<HassReconnectConfig>,
): HassReconnectConfig {
  const source = { ...fromConfig, ...fromOptions };
  const initialDelayMs = Math.max(0, source.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, source.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS);
  const maxAttempts = source.maxAttempts === undefined ? Number.POSITIVE_INFINITY : Math.max(0, source.maxAttempts);
  return { initialDelayMs, maxDelayMs, maxAttempts };
}

/**
 * Convierte la URL base de Home Assistant en la URL del protocolo WebSocket.
 *
 * @param rawUrl URL HTTP(S) o WS(S) configurada.
 * @returns URL `ws://` o `wss://` con la ruta del protocolo.
 */
export function toWebSocketUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error: unknown) {
    throw new DomoticsError("configuration", "La URL de Home Assistant no es válida.", { cause: error });
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new DomoticsError("configuration", "La URL de Home Assistant debe usar HTTP(S) o WS(S).");
  }
  const currentPath = parsed.pathname.replace(/\/$/, "");
  if (!currentPath.endsWith("/api/websocket")) {
    parsed.pathname = `${currentPath}/api/websocket`;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Crea un adaptador del WebSocket nativo de Node.
 *
 * @param url URL del servidor Home Assistant.
 * @returns Transporte compatible con `HassWebSocket`.
 */
function defaultWebSocketFactory(url: string): HassWebSocket {
  const NativeWebSocket = globalThis.WebSocket;
  if (typeof NativeWebSocket !== "function") {
    throw new DomoticsError("configuration", "Este runtime no dispone de un WebSocket global compatible.");
  }
  const nativeSocket = new NativeWebSocket(url);
  return {
    get readyState(): number {
      return nativeSocket.readyState;
    },
    send(data: string): void {
      nativeSocket.send(data);
    },
    close(code?: number, reason?: string): void {
      nativeSocket.close(code, reason);
    },
    addEventListener(type, listener): void {
      if (type === "message") {
        nativeSocket.addEventListener("message", (event) => listener({ type: "message", data: event.data }));
        return;
      }
      if (type === "error") {
        nativeSocket.addEventListener("error", (event) => listener({ type: "error", data: event }));
        return;
      }
      if (type === "close") {
        nativeSocket.addEventListener("close", (event) => listener({ type: "close", data: event }));
        return;
      }
      nativeSocket.addEventListener("open", (event) => listener({ type: "open", data: event }));
    },
  };
}

/**
 * Extrae texto JSON de los datos de un transporte.
 *
 * @param data Datos recibidos del WebSocket.
 * @returns Texto decodificado o `undefined`.
 */
function extractText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (isRecord(data) && "data" in data) return extractText(data.data);
  return undefined;
}

/**
 * Comprueba si un valor es un objeto con propiedades indexables.
 *
 * @param value Valor a comprobar.
 * @returns `true` cuando el valor es un objeto no nulo.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lee una propiedad string de un objeto desconocido.
 *
 * @param value Valor de la propiedad.
 * @returns String no vacío o `undefined`.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extrae un mensaje de error de una respuesta de protocolo.
 *
 * @param value Respuesta desconocida.
 * @returns Mensaje legible.
 */
function errorMessage(value: unknown): string {
  if (isRecord(value)) {
    const direct = asString(value.error);
    if (direct) return direct;
    if (isRecord(value.error)) {
      const nested = asString(value.error.message);
      if (nested) return nested;
    }
    const message = asString(value.message);
    if (message) return message;
  }
  return "Home Assistant rechazó la operación.";
}

/**
 * Normaliza una lista de entidades de Home Assistant.
 *
 * @param value Resultado bruto del protocolo.
 * @param registry Si es `true`, se interpretan campos del registro de entidades.
 * @returns Lista de entidades normalizadas.
 */
export function normalizeEntityList(value: unknown, registry = false): EntityRegistryItem[] {
  const raw = extractArray(value, registry ? "entities" : undefined);
  const entities: EntityRegistryItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const entityId = asString(item.entity_id);
    if (!entityId) continue;
    const attributes = isRecord(item.attributes) ? item.attributes : {};
    const domain = asString(item.domain) ?? entityId.split(".", 1)[0] ?? entityId;
    const friendlyName = asString(item.friendly_name) ?? asString(attributes.friendly_name) ?? asString(item.name) ?? entityId;
    const area = asString(item.area) ?? asString(item.area_id);
    const deviceClass = asString(item.device_class) ?? asString(item.original_device_class) ?? asString(attributes.device_class);
    const state = asString(item.state) ?? (registry ? "unknown" : "unknown");
    const entity: EntityRegistryItem = {
      entity_id: entityId,
      domain,
      friendly_name: friendlyName,
      state,
      attributes,
    };
    if (area) entity.area = area;
    if (deviceClass) entity.device_class = deviceClass;
    entities.push(entity);
  }
  return entities;
}

/**
 * Extrae un array de una respuesta de registro o de una lista directa.
 *
 * @param value Resultado bruto.
 * @param key Clave opcional que contiene el array.
 * @returns Array de valores desconocidos.
 */
function extractArray(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && key && Array.isArray(value[key])) return value[key];
  return [];
}

/**
 * Normaliza la respuesta de `config/area_registry/list`.
 *
 * @param value Resultado bruto.
 * @returns Áreas normalizadas.
 */
export function normalizeAreas(value: unknown): Area[] {
  const areas: Area[] = [];
  for (const item of extractArray(value, "areas")) {
    if (!isRecord(item)) continue;
    const areaId = asString(item.area_id) ?? asString(item.id);
    const name = asString(item.name);
    if (!areaId || !name) continue;
    areas.push({ area_id: areaId, name });
  }
  return areas;
}

/**
 * Normaliza la respuesta de `scene_registry/list`.
 *
 * @param value Resultado bruto.
 * @returns Escenas normalizadas.
 */
export function normalizeScenes(value: unknown): Scene[] {
  const scenes: Scene[] = [];
  for (const item of extractArray(value, "scenes")) {
    if (!isRecord(item)) continue;
    const sceneId = asString(item.scene_id) ?? asString(item.id);
    const name = asString(item.name);
    if (!sceneId || !name) continue;
    scenes.push({ scene_id: sceneId, name });
  }
  return scenes;
}

/**
 * Normaliza la respuesta de `config/device_registry/list`.
 *
 * @param value Resultado bruto.
 * @returns Dispositivos normalizados.
 */
export function normalizeDevices(value: unknown): HassDevice[] {
  const devices: HassDevice[] = [];
  for (const item of extractArray(value, "devices")) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    const device: HassDevice = { id };
    const name = asString(item.name);
    if (name) device.name = name;
    const nameByUser = asString(item.name_by_user);
    if (nameByUser) device.name_by_user = nameByUser;
    const manufacturer = asString(item.manufacturer);
    if (manufacturer) device.manufacturer = manufacturer;
    const model = asString(item.model);
    if (model) device.model = model;
    const areaId = asString(item.area_id);
    if (areaId) device.area_id = areaId;
    if (Array.isArray(item.identifiers)) {
      const identifiers = item.identifiers.filter(
        (identifier): identifier is string[] => Array.isArray(identifier) && identifier.every((part) => typeof part === "string"),
      );
      if (identifiers.length > 0) device.identifiers = identifiers;
    }
    devices.push(device);
  }
  return devices;
}

/**
 * Normaliza la respuesta de `get_services`.
 *
 * @param value Resultado bruto.
 * @returns Catálogo de servicios.
 */
export function normalizeServiceCatalog(value: unknown): HassServiceCatalog {
  const catalog: HassServiceCatalog = {};
  if (!isRecord(value)) return catalog;
  for (const [domain, services] of Object.entries(value)) {
    if (!Array.isArray(services)) continue;
    catalog[domain] = services.filter((service): service is string => typeof service === "string");
  }
  return catalog;
}
