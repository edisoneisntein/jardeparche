/**
 * Tipos compartidos del subsistema de domótica.
 *
 * El módulo no contiene estado mutable: únicamente define los contratos que
 * consumen Home Assistant, Matter/Thread, las cámaras y las herramientas del
 * agente. Los detalles de red y de persistencia viven en sus módulos
 * especializados.
 */

/** Clasificaciones de error expuestas por el subsistema de domótica. */
export type DomoticsErrorKind =
  | "configuration"
  | "connection"
  | "network"
  | "protocol"
  | "timeout"
  | "aborted"
  | "not_found"
  | "invalid_response"
  | "unsupported"
  | "security"
  | "process"
  | "vision"
  | "unknown";

/** Dominio de una entidad de Home Assistant, por ejemplo `switch` o `light`. */
export type EntityDomain = string;

/** Estado escalar expuesto por una entidad de Home Assistant. */
export type EntityState = string;

/** Metadatos y estado actual de una entidad de Home Assistant. */
export interface EntityRegistryItem {
  /** Identificador estable de la entidad, por ejemplo `light.entrada`. */
  entity_id: string;
  /** Dominio de la entidad. */
  domain: EntityDomain;
  /** Nombre visible para las personas usuarias. */
  friendly_name: string;
  /** Identificador del área a la que pertenece la entidad, si la tiene. */
  area?: string;
  /** Clase de dispositivo, si Home Assistant la publica. */
  device_class?: string;
  /** Estado actual de la entidad. */
  state: EntityState;
  /** Atributos adicionales publicados por Home Assistant. */
  attributes: Record<string, unknown>;
}

/** Área del registro de Home Assistant. */
export interface Area {
  /** Identificador estable del área. */
  area_id: string;
  /** Nombre visible del área. */
  name: string;
}

/** Escena del registro de Home Assistant. */
export interface Scene {
  /** Identificador estable de la escena. */
  scene_id: string;
  /** Nombre visible de la escena. */
  name: string;
}

/** Modos de vigilancia perimetral soportados por el subsistema. */
export type PerimeterMode = "home" | "away" | "night";

/** Instantánea inmutable de una cámara perimetral. */
export interface CameraSnapshot {
  /** Imagen codificada en Base64, sin prefijo `data:`. */
  imageBase64: string;
  /** Ancho real de la imagen en píxeles; `0` si el formato no se reconoce. */
  width: number;
  /** Alto real de la imagen en píxeles; `0` si el formato no se reconoce. */
  height: number;
  /** Instante de captura en formato ISO 8601. */
  timestamp: string;
  /** Identificador de la cámara de origen. */
  cameraId: string;
}

/** Resultado opcional de un modelo de visión sobre una instantánea. */
export interface CameraVisionAnalysis {
  /** Descripción o análisis devuelto por el proveedor de visión. */
  text: string;
  /** Confianza opcional entre cero y uno. */
  confidence?: number;
  /** Datos estructurados adicionales del proveedor. */
  raw?: unknown;
}

/** Callback de visión opcional para el servicio de cámaras. */
export type CameraVisionCallback = (
  snapshot: CameraSnapshot,
  signal?: AbortSignal,
) => Promise<CameraVisionAnalysis | undefined>;

/** Configuración de la conexión WebSocket con Home Assistant. */
export interface HassConfig {
  /** URL base HTTP(S) o WS(S) de Home Assistant. */
  url: string;
  /** Token de acceso de larga duración. */
  token?: string;
  /** Alias de `token` aceptado para integraciones que usan esa nomenclatura. */
  accessToken?: string;
  /** Alias en snake_case del token de Home Assistant. */
  access_token?: string;
  /** Tiempo máximo de espera de una orden o del handshake, en milisegundos. */
  requestTimeoutMs?: number;
  /** Política de reconexión después de una conexión autenticada. */
  reconnect?: Partial<HassReconnectConfig>;
  /** Factoría opcional para pruebas o transportes WebSocket especiales. */
  webSocketFactory?: HassWebSocketFactory;
}

/** Política de reconexión exponencial del cliente de Home Assistant. */
export interface HassReconnectConfig {
  /** Espera inicial en milisegundos. */
  initialDelayMs: number;
  /** Espera máxima en milisegundos. */
  maxDelayMs: number;
  /** Número máximo de reintentos; `Infinity` permite reintentos ilimitados. */
  maxAttempts: number;
}

/** Evento genérico publicado por el WebSocket de Home Assistant. */
export interface HassEvent {
  /** Tipo de evento de Home Assistant, por ejemplo `state_changed`. */
  event_type: string;
  /** Carga útil específica del evento. */
  data: Record<string, unknown>;
  /** Fecha y hora de activación publicada por Home Assistant. */
  time_fired?: string;
  /** Origen opcional del evento. */
  origin?: string;
}

/** Evento de cambio de estado normalizado para consumidores de entidades. */
export interface EntityStateChangedEvent {
  /** Tipo discriminante del evento. */
  type: "entity_state_changed";
  /** Entidad cuyo estado ha cambiado. */
  entity_id: string;
  /** Estado anterior, si Home Assistant lo publicó. */
  old_state?: EntityState;
  /** Estado nuevo. */
  new_state: EntityState;
  /** Atributos publicados junto al estado nuevo, si están disponibles. */
  attributes?: Record<string, unknown>;
  /** Fecha y hora del cambio en formato ISO 8601. */
  changed_at: string;
}

/** Evento de cambio del modo perimetral. */
export interface PerimeterModeChangedEvent {
  /** Tipo discriminante del evento. */
  type: "perimeter_mode_changed";
  /** Modo anterior. */
  previous_mode?: PerimeterMode;
  /** Modo actual. */
  mode: PerimeterMode;
  /** Fecha y hora del cambio en formato ISO 8601. */
  changed_at: string;
}

/** Evento de captura de una cámara. */
export interface CameraSnapshotEvent {
  /** Tipo discriminante del evento. */
  type: "camera_snapshot";
  /** Cámara de origen. */
  cameraId: string;
  /** Instante de captura en formato ISO 8601. */
  timestamp: string;
}

/** Unión de eventos emitidos por el subsistema de domótica. */
export type DomoticsEvent =
  | EntityStateChangedEvent
  | PerimeterModeChangedEvent
  | CameraSnapshotEvent
  | { type: "hass_event"; event: HassEvent };

/** Función que recibe un evento de domótica. */
export type DomoticsEventListener = (event: DomoticsEvent) => void;

/** Definición de una cámara configurada. */
export interface CameraDefinition {
  /** Identificador único utilizado por las herramientas. */
  id: string;
  /** URL HTTP(S) de la instantánea ONVIF o de un recurso de vídeo. */
  url: string;
  /** URL RTSP alternativa para ffmpeg. */
  rtspUrl?: string;
  /** Credenciales opcionales para la cámara. */
  username?: string;
  /** Contraseña opcional para la cámara. */
  password?: string;
  /** Cabeceras HTTP opcionales para una instantánea ONVIF. */
  headers?: Record<string, string>;
}

/** Colección de definiciones de cámara. */
export type CameraCollection = CameraDefinition[] | Record<string, CameraDefinition | string>;

/** Configuración de las cámaras y de su captura local. */
export interface CameraConfig {
  /** Cámaras conocidas por el servicio. */
  cameras: CameraCollection;
  /** Ruta del ejecutable ffmpeg. */
  ffmpegPath?: string;
  /** Tiempo máximo de captura en milisegundos. */
  timeoutMs?: number;
  /** Tope de bytes que se pueden acumular desde ffmpeg. */
  maxBytes?: number;
  /** Permite fuentes RTSP explícitamente configuradas. */
  allowRtsp?: boolean;
  /** Callback opcional para analizar las instantáneas. */
  vision?: CameraVisionCallback;
  /** Factoría de procesos opcional para pruebas. */
  spawner?: CameraSpawner;
}

/** Proceso de captura inyectado en el servicio de cámaras. */
export interface CameraProcess {
  /** Flujo de salida estándar de ffmpeg. */
  stdout: NodeJS.ReadableStream | null;
  /** Flujo de error estándar de ffmpeg. */
  stderr: NodeJS.ReadableStream | null;
  /** Identificador de proceso, si está disponible. */
  readonly pid?: number;
  /** Registra un listener de cierre o error del proceso. */
  once?(event: string, listener: (...args: unknown[]) => void): this;
  /** Registra un listener alternativo cuando el proceso no ofrece `once`. */
  on?(event: string, listener: (...args: unknown[]) => void): this;
  /** Envía una señal al proceso. */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Factoría de procesos utilizada por el servicio de cámaras. */
export type CameraSpawner = (
  command: string,
  args: string[],
  options: { detached: boolean; shell?: boolean },
) => CameraProcess;

/** Evento que puede producir un transporte WebSocket inyectable. */
export interface HassWebSocketEvent {
  /** Datos recibidos. El cliente solo acepta texto JSON. */
  data?: unknown;
  /** Nombre del evento, por ejemplo `message`. */
  type?: string;
}

/** Transporte WebSocket mínimo necesario para Home Assistant. */
export interface HassWebSocket {
  /** Estado de apertura; `1` significa abierto. */
  readonly readyState: number;
  /** Envía un mensaje de texto. */
  send(data: string): void;
  /** Cierra el transporte. */
  close(code?: number, reason?: string): void;
  /** Registra listeners si el transporte implementa la API DOM. */
  addEventListener?: (
    type: "open" | "message" | "error" | "close",
    listener: (event: HassWebSocketEvent) => void,
  ) => void;
  /** Callback alternativo de apertura. */
  onopen?: ((event: HassWebSocketEvent) => void) | null;
  /** Callback alternativo de mensajes. */
  onmessage?: ((event: HassWebSocketEvent) => void) | null;
  /** Callback alternativo de errores. */
  onerror?: ((event: HassWebSocketEvent) => void) | null;
  /** Callback alternativo de cierre. */
  onclose?: ((event: HassWebSocketEvent) => void) | null;
}

/** Factoría de WebSocket inyectable en Home Assistant. */
export type HassWebSocketFactory = (url: string) => HassWebSocket;

/** Opciones adicionales del cliente de Home Assistant. */
export interface HassClientOptions {
  /** Factoría usada para crear cada conexión WebSocket. */
  webSocketFactory?: HassWebSocketFactory;
  /** Alias de `webSocketFactory`. */
  socketFactory?: HassWebSocketFactory;
  /** Alias de `webSocketFactory`. */
  createWebSocket?: HassWebSocketFactory;
  /** Política de reconexión que sobrescribe la configuración. */
  reconnect?: Partial<HassReconnectConfig>;
  /** Tiempo máximo de espera de una orden en milisegundos. */
  requestTimeoutMs?: number;
  /** Señal que cancela el ciclo de vida del cliente. */
  signal?: AbortSignal;
}

/** Configuración del cliente Matter/Thread basado en HTTP o CLI. */
export interface MatterConfig {
  /** Transporte seleccionado. */
  transport?: "http" | "cli" | "memory";
  /** URL base del Border Router o del servicio HTTP. */
  endpoint?: string;
  /** Token opcional para autenticar las peticiones HTTP. */
  token?: string;
  /** Comando del cliente CLI de Matter. */
  cliCommand?: string;
  /** Argumentos base del cliente CLI. */
  cliArgs?: string[];
  /** Tiempo máximo de una operación en milisegundos. */
  timeoutMs?: number;
  /** Transporte HTTP inyectable para pruebas. */
  fetch?: MatterFetch;
  /** Factoría de procesos CLI inyectable para pruebas. */
  spawner?: MatterSpawner;
}

/** Respuesta mínima de un transporte HTTP de Matter. */
export interface MatterHttpResponse {
  /** Indica si la respuesta HTTP fue correcta. */
  ok: boolean;
  /** Código de estado HTTP. */
  status: number;
  /** Lee el cuerpo JSON, si existe. */
  json?: () => Promise<unknown>;
  /** Lee el cuerpo textual, si existe. */
  text?: () => Promise<string>;
}

/** Función HTTP inyectable para Matter. */
export type MatterFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<MatterHttpResponse>;

/** Proceso CLI mínimo utilizado por Matter. */
export interface MatterCliProcess {
  /** Flujo de entrada estándar del proceso. */
  stdin: NodeJS.WritableStream | null;
  /** Flujo de salida estándar del proceso. */
  stdout: NodeJS.ReadableStream | null;
  /** Flujo de error estándar del proceso. */
  stderr: NodeJS.ReadableStream | null;
  /** Registra un listener de cierre o error del proceso. */
  once?(event: string, listener: (...args: unknown[]) => void): this;
  /** Registra un listener alternativo cuando el proceso no ofrece `once`. */
  on?(event: string, listener: (...args: unknown[]) => void): this;
  /** Envía una señal al proceso. */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Factoría de procesos CLI inyectable en Matter. */
export type MatterSpawner = (
  command: string,
  args: string[],
  options: { detached: boolean; shell?: boolean },
) => MatterCliProcess;

/** Contrato común de los clientes Matter/Thread. */
export interface MatterClient {
  /** Empareja un dispositivo con el Border Router. */
  pair(deviceId: string): Promise<MatterPairResult>;
  /** Comisiona un dispositivo ya emparejado. */
  commission(deviceId: string, options?: MatterCommissionOptions): Promise<MatterCommissionResult>;
  /** Escribe un atributo de un cluster Matter. */
  set(deviceId: string, cluster: string, attribute: string, value: unknown): Promise<MatterSetResult>;
  /** Lee un atributo de un cluster Matter. */
  read(deviceId: string, cluster: string, attribute: string): Promise<unknown>;
  /** Consulta el estado de un dispositivo o del Border Router. */
  status(deviceId?: string): Promise<MatterStatus>;
}

/** Opciones de comisión de un dispositivo Matter. */
export interface MatterCommissionOptions {
  /** Red Thread o Wi-Fi de destino. */
  network?: string;
  /** Código de acceso opcional de la comisión. */
  passcode?: string;
  /** Datos adicionales enviados al Border Router. */
  metadata?: Record<string, unknown>;
}

/** Resultado de pairar un dispositivo Matter. */
export interface MatterPairResult {
  /** Dispositivo procesado. */
  deviceId: string;
  /** Si el dispositivo ha quedado emparejado. */
  paired: boolean;
  /** Estado textual devuelto por el Border Router. */
  status?: string;
}

/** Resultado de comisionar un dispositivo Matter. */
export interface MatterCommissionResult {
  /** Dispositivo procesado. */
  deviceId: string;
  /** Si el dispositivo ha quedado comisionado. */
  commissioned: boolean;
  /** Estado textual devuelto por el Border Router. */
  status?: string;
}

/** Resultado de escribir un atributo de un dispositivo Matter. */
export interface MatterSetResult {
  /** Dispositivo procesado. */
  deviceId: string;
  /** Cluster Matter utilizado. */
  cluster: string;
  /** Atributo Matter utilizado. */
  attribute: string;
  /** Valor que se intentó escribir. */
  value: unknown;
}

/** Estado de un dispositivo o del Border Router Matter. */
export interface MatterStatus {
  /** Dispositivo consultado, si la consulta fue por dispositivo. */
  deviceId?: string;
  /** Si el dispositivo está emparejado. */
  paired: boolean;
  /** Si el dispositivo está comisionado. */
  commissioned: boolean;
  /** Si el dispositivo está conectado. */
  connected: boolean;
  /** Red o topología informada por el Border Router. */
  network?: string;
}

/** Configuración del control perimetral. */
export interface PerimeterConfig {
  /** Entidad `input_select` que representa el modo actual. */
  modeEntityId?: string;
  /** Entidades adicionales controladas por el modo perimetral. */
  entityIds?: string[];
  /** Callback opcional para delegar el armado en otro sistema. */
  onModeChanged?: (mode: PerimeterMode, previousMode: PerimeterMode) => void | Promise<void>;
}

/** Configuración completa del subsistema de domótica. */
export interface DomoticsConfig {
  /** Configuración de Home Assistant. */
  hass?: HassConfig;
  /** Alias de `hass` para integraciones que lo llaman `homeAssistant`. */
  homeAssistant?: HassConfig;
  /** Factoría WebSocket opcional compartida por las pruebas. */
  webSocketFactory?: HassWebSocketFactory;
  /** Configuración de Matter/Thread. */
  matter?: MatterConfig;
  /** Configuración de cámaras. */
  cameras?: CameraConfig | CameraDefinition[] | Record<string, CameraDefinition | string>;
  /** Callback de visión de la configuración de cámaras. */
  vision?: CameraVisionCallback;
  /** Configuración del modo perimetral. */
  perimeter?: PerimeterConfig;
}
