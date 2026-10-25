/**
 * Resultado que puede completarse de forma síncrona o asíncrona.
 *
 * @typeParam T Tipo del valor producido.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Función HTTP compatible con la API global `fetch` de Node 22.
 *
 * Permite inyectar transportes deterministas en pruebas sin sustituir el
 * prototipo global de `fetch`.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Origen de una muestra biométrica.
 */
export type BiometricSource = "garmin" | "oura" | "polar" | "esp32" | "apple" | "manual";

/**
 * Métricas de variabilidad de frecuencia cardíaca calculadas a partir de
 * intervalos RR instantáneos.
 */
export interface HrvMetrics {
  /** Raíz cuadrada del promedio de los cuadrados de diferencias RR adyacentes. */
  rmssdMs: number;
  /** Desviación estándar muestral de los intervalos RR. */
  sdnnMs: number;
  /** Porcentaje de diferencias RR adyacentes superiores a 50 ms. */
  pnn50Percent: number;
  /** Potencia de banda LF dividida por la potencia de banda HF. */
  lfHfRatio: number;
  /** Número de intervalos RR empleados en el cálculo. */
  sampleCount: number;
}

/**
 * Zona de estrés derivada del índice de Baevsky y de la puntuación de estrés.
 */
export type StressZone = "recovery" | "low" | "medium" | "high";

/**
 * Muestra biométrica unificada.
 *
 * `ts` representa milisegundos desde Unix. `hrvMs` contiene el intervalo RR
 * instantáneo observado, expresado en milisegundos; esta semántica permite
 * calcular métricas HRV reales sin convertir una métrica agregada en una
 * secuencia de latidos. Los bridges que solo reciben una métrica agregada
 * publican su valor original y no fabrican intervalos RR adicionales.
 */
export interface BiometricSample {
  /** Marca temporal de la muestra en milisegundos desde Unix. */
  ts: number;
  /** Frecuencia cardíaca en latidos por minuto. */
  heartRate?: number;
  /** Intervalo RR instantáneo o métrica HRV expresada en milisegundos. */
  hrvMs?: number;
  /** Saturación de oxígeno en porcentaje. */
  spo2?: number;
  /** Temperatura corporal en grados Celsius. */
  temperatureC?: number;
  /** Puntuación de estrés en una escala de 0 a 100. */
  stressScore?: number;
  /** Puntuación de sueño en una escala de 0 a 100. */
  sleepScore?: number;
  /** Dispositivo o proveedor que originó la muestra. */
  source: BiometricSource;
}

/**
 * Huella vocal normalizada asociada a una persona usuaria.
 */
export interface Voiceprint {
  /** Identificador estable de la persona usuaria. */
  userId: string;
  /** Vector de embedding normalizado. */
  embedding: number[];
  /** Fecha de creación en formato ISO 8601. */
  createdAt: string;
}

/**
 * Segmento PCM mono usado para generar una huella vocal.
 */
export interface VoiceprintSample {
  /** Muestras PCM en punto flotante, normalmente en el intervalo `[-1, 1]`. */
  pcm: Float32Array;
  /** Frecuencia de muestreo de las muestras de audio. */
  sampleRate: number;
}

/**
 * Contrato de un generador de embeddings para huellas vocales.
 *
 * Una implementación real puede devolver un vector de forma síncrona o
 * asíncrona. ECAPA-TDNN ejecutado con `onnxruntime-node` encaja en este
 * contrato sin modificar el gestor de huellas.
 */
export interface VoiceprintEmbedder {
  /**
   * Calcula el embedding de un segmento de audio.
   *
   * @param sample Segmento PCM y su frecuencia de muestreo.
   * @returns Vector numérico sin valores no finitos.
   */
  embed(sample: VoiceprintSample): MaybePromise<readonly number[]>;
}

/**
 * Resultado de comparar una muestra vocal con una huella registrada.
 */
export interface VoiceprintVerification {
  /** Indica si la similitud alcanza el umbral configurado. */
  verified: boolean;
  /** Similitud coseno, acotada al intervalo `[-1, 1]`. */
  score: number;
  /** Umbral utilizado para decidir la verificación. */
  threshold: number;
}

/**
 * Configuración del gestor de huellas vocales.
 */
export interface VoiceprintConfig {
  /** Generador de embeddings; por defecto se usa la implementación determinista. */
  embedder?: VoiceprintEmbedder;
  /** Umbral coseno predeterminado de 0.85. */
  threshold?: number;
  /** Huellas precargadas en memoria. */
  voiceprints?: readonly Voiceprint[];
}

/**
 * Detector neuronal alternativo para VAD.
 *
 * El contrato es síncrono para mantener `Vad.process()` síncrono. Un adaptador
 * Silero puede ejecutar inferencia ONNX sincrónica, o consumir una cola de
 * inferencias precalculadas por un worker, y exponer su probabilidad aquí.
 */
export interface NeuralVadDetector {
  /**
   * Estima la probabilidad de voz para una trama PCM.
   *
   * @param frame Trama PCM 16 bits, mono y 16 kHz.
   * @returns Probabilidad acotada al intervalo `[0, 1]`.
   */
  probability(frame: Int16Array): number;
}

/**
 * Configuración del detector de actividad de voz basado en energía.
 */
export interface VadConfig {
  /** Umbral probabilístico de actividad de voz. */
  threshold?: number;
  /** RMS mínimo, en unidades PCM 16 bits, para considerar energía de voz. */
  energyThreshold?: number;
  /** RMS al que la energía alcanza probabilidad uno. */
  energyCeiling?: number;
  /** Número de tramas no habladas que mantienen activo el estado de habla. */
  hangoverFrames?: number;
  /** Tasa mínima de cambios de signo aceptada para voz. */
  zeroCrossingMin?: number;
  /** Tasa máxima de cambios de signo aceptada para voz. */
  zeroCrossingMax?: number;
  /** Detector neuronal opcional que sustituye la puntuación energética. */
  neural?: NeuralVadDetector;
}

/**
 * Resultado de analizar una trama de audio.
 */
export interface VadResult {
  /** Estado de habla tras aplicar el hangover. */
  speech: boolean;
  /** Probabilidad de voz acotada al intervalo `[0, 1]`. */
  probability: number;
  /** RMS de la trama en unidades PCM 16 bits. */
  rms: number;
}

/**
 * Token OAuth2 persistido de forma externa al package.
 */
export interface OAuthToken {
  /** Token de acceso actual. */
  accessToken: string;
  /** Token usado para renovar el acceso. */
  refreshToken?: string;
  /** Instante de expiración en milisegundos desde Unix. */
  expiresAt?: number;
  /** Tipo de token, normalmente `Bearer`. */
  tokenType?: string;
  /** Ámbitos concedidos por el proveedor. */
  scope?: string;
  /** Identificador de usuario devuelto por el proveedor, si existe. */
  userId?: string;
}

/**
 * Almacén de tokens inyectado en los bridges OAuth2.
 *
 * La implementación decide si los tokens viven en memoria, una base de datos
 * o un gestor seguro del proceso anfitrión.
 */
export interface TokenStore {
  /**
   * Recupera un token por su clave.
   *
   * @param key Clave lógica del token.
   * @returns Token almacenado o `undefined` si no existe.
   */
  get(key: string): MaybePromise<OAuthToken | undefined>;
  /**
   * Guarda o reemplaza un token.
   *
   * @param key Clave lógica del token.
   * @param token Token que debe persistirse.
   */
  set(key: string, token: OAuthToken): MaybePromise<void>;
  /**
   * Elimina un token.
   *
   * @param key Clave lógica del token.
   */
  remove(key: string): MaybePromise<void>;
}

/**
 * Callback que persiste una muestra y su estado calculado.
 */
export type BiometricPipelineSink = (
  sample: BiometricSample,
  state: BiometricState,
) => MaybePromise<void>;

/**
 * Callback que persiste la aparición de una alerta de estrés.
 */
export type BiometricAlertSink = (
  alert: BiometricAlert,
  state: BiometricState,
) => MaybePromise<void>;

/**
 * Configuración del pipeline biométrico.
 */
export interface BiometricPipelineConfig {
  /** Ventana temporal deslizante en milisegundos. */
  windowMs?: number;
  /** Número máximo de muestras retenidas en la ventana. */
  maxSamples?: number;
  /** Número mínimo de intervalos RR necesario para publicar métricas HRV. */
  minHrvSamples?: number;
  /** RMSSD basal utilizado por la aproximación de Baevsky. */
  baevskyBaselineRmssdMs?: number;
  /** Factor de suavizado EMA de la tendencia de estrés. */
  emaAlpha?: number;
  /** Umbral de alerta de estrés en una escala de 0 a 100. */
  stressAlertThreshold?: number;
  /** Puntuación por debajo de la cual se resuelve una alerta activa. */
  stressRecoveryThreshold?: number;
  /** Límites superiores de las zonas `recovery`, `low` y `medium`. */
  stressZoneThresholds?: {
    /** Límite superior de recuperación. */
    recovery: number;
    /** Límite superior de estrés bajo. */
    low: number;
    /** Límite superior de estrés medio. */
    medium: number;
  };
  /** Número de frecuencias evaluadas por Lomb–Scargle. */
  lombScargleFrequencies?: number;
  /** Callback de persistencia de muestras; no accede directamente a una base de datos. */
  sink?: BiometricPipelineSink;
  /** Callback de persistencia de alertas. */
  alertSink?: BiometricAlertSink;
}

/**
 * Alerta emitida al cruzar el umbral de estrés configurado.
 */
export interface BiometricAlert {
  /** Identificador único de la alerta. */
  id: string;
  /** Clasificación estable de la alerta. */
  kind: "stress_threshold";
  /** Zona de estrés asociada a la alerta. */
  severity: StressZone;
  /** Puntuación que activó la alerta. */
  value: number;
  /** Umbral que activó la alerta. */
  threshold: number;
  /** Instante de activación en milisegundos desde Unix. */
  triggeredAt: number;
  /** Instante de resolución en milisegundos desde Unix, si ya se resolvió. */
  resolvedAt?: number;
  /** Muestra que activó la alerta. */
  sample: BiometricSample;
}

/**
 * Estado biométrico calculado para una muestra.
 */
export interface BiometricState {
  /** Muestra original recibida por el pipeline. */
  sample: BiometricSample;
  /** Métricas HRV cuando hay suficientes intervalos RR. */
  hrv?: HrvMetrics;
  /** Índice de Baevsky; valores próximos a uno indican mayor estrés. */
  baevskyIndex?: number;
  /** Puntuación de estrés calculada en una escala de 0 a 100. */
  stressScore: number;
  /** Zona de estrés correspondiente a la puntuación. */
  stressZone: StressZone;
  /** Media móvil exponencial de la puntuación de estrés. */
  stressTrend: number;
  /** Alerta activa en el instante de la muestra. */
  alert?: BiometricAlert;
}

/**
 * Contrato común de los bridges que recuperan muestras históricas.
 */
export interface BiometricBridge {
  /** Proveedor al que pertenece el bridge. */
  readonly source: BiometricSource;
  /**
   * Recupera las muestras disponibles en un intervalo.
   *
   * @param start Inicio inclusivo del intervalo.
   * @param end Fin inclusivo del intervalo.
   * @param signal Señal opcional que cancela las peticiones REST pendientes.
   * @returns Muestras normalizadas y ordenadas cronológicamente.
   */
  fetchSamples(
    start: Date | number,
    end: Date | number,
    signal?: AbortSignal,
  ): Promise<BiometricSample[]>;
}

/**
 * Configuración del bridge OAuth2 de Garmin Health API.
 */
export interface GarminBridgeConfig {
  /** Client ID de la aplicación OAuth2 de Garmin. */
  clientId: string;
  /** Client secret de la aplicación OAuth2 de Garmin. */
  clientSecret?: string;
  /** Almacén de tokens inyectado. */
  tokenStore: TokenStore;
  /** Clave lógica del token en el almacén. */
  tokenKey?: string;
  /** Implementación HTTP inyectable. */
  fetch?: FetchLike;
  /** Tiempo máximo de cada petición en milisegundos. */
  timeoutMs?: number;
  /** URL base de Garmin Wellness API. */
  baseUrl?: string;
  /** Endpoint de tokens OAuth2. */
  tokenUrl?: string;
  /** Endpoint de autorización OAuth2. */
  authorizationUrl?: string;
  /** URI de redirección registrado en Garmin. */
  redirectUri?: string;
  /** Ámbitos solicitados durante la autorización. */
  scopes?: readonly string[];
}

/**
 * Configuración del bridge OAuth2 de Oura API v2.
 */
export interface OuraBridgeConfig {
  /** Client ID de la aplicación OAuth2 de Oura. */
  clientId: string;
  /** Client secret de la aplicación OAuth2 de Oura. */
  clientSecret: string;
  /** Almacén de tokens inyectado. */
  tokenStore: TokenStore;
  /** Clave lógica del token en el almacén. */
  tokenKey?: string;
  /** Implementación HTTP inyectable. */
  fetch?: FetchLike;
  /** Tiempo máximo de cada petición en milisegundos. */
  timeoutMs?: number;
  /** URL base de Oura API v2. */
  baseUrl?: string;
  /** Endpoint de tokens OAuth2. */
  tokenUrl?: string;
  /** Endpoint de autorización OAuth2. */
  authorizationUrl?: string;
  /** URI de redirección registrado en Oura. */
  redirectUri?: string;
  /** Ámbitos solicitados durante la autorización. */
  scopes?: readonly string[];
}

/**
 * Configuración del bridge OAuth2 de Polar AccessLink API v3.
 */
export interface PolarBridgeConfig {
  /** Client ID de la aplicación OAuth2 de Polar. */
  clientId: string;
  /** Client secret de la aplicación OAuth2 de Polar. */
  clientSecret: string;
  /** Almacén de tokens inyectado. */
  tokenStore: TokenStore;
  /** Clave lógica del token en el almacén. */
  tokenKey?: string;
  /** Implementación HTTP inyectable. */
  fetch?: FetchLike;
  /** Tiempo máximo de cada petición en milisegundos. */
  timeoutMs?: number;
  /** URL base de Polar AccessLink. */
  baseUrl?: string;
  /** Endpoint de tokens OAuth2. */
  tokenUrl?: string;
  /** Endpoint de autorización OAuth2. */
  authorizationUrl?: string;
  /** Ámbitos solicitados durante la autorización. */
  scopes?: readonly string[];
}

/**
 * Trama de constantes vitales recibida del ESP32.
 */
export interface Esp32VitalsFrame {
  /** Tipo de trama. */
  type: "vitals";
  /** Número de secuencia de la trama. */
  sequence: number;
  /** Marca temporal en milisegundos desde Unix. */
  timestampMs: number;
  /** Frecuencia cardíaca en latidos por minuto. */
  heartRate: number;
  /** Variabilidad de frecuencia cardíaca en milisegundos. */
  hrvMs: number;
}

/**
 * Trama de ECG crudo recibida del ESP32.
 */
export interface Esp32EcgFrame {
  /** Tipo de trama. */
  type: "ecg";
  /** Número de secuencia de la trama. */
  sequence: number;
  /** Marca temporal en milisegundos desde Unix. */
  timestampMs: number;
  /** Frecuencia de muestreo del ECG en hercios. */
  sampleRateHz: number;
  /** Muestras ECG en formato PCM 16 bits con signo. */
  samples: Int16Array;
}

/**
 * Trama de control PING o PONG.
 */
export interface Esp32ControlFrame {
  /** Tipo de trama. */
  type: "ping" | "pong";
  /** Número de secuencia de la trama. */
  sequence: number;
  /** Marca temporal en milisegundos desde Unix. */
  timestampMs: number;
}

/**
 * Trama binaria decodificable del protocolo ESP32.
 */
export type Esp32Frame = Esp32VitalsFrame | Esp32EcgFrame | Esp32ControlFrame;

/**
 * Flujo de bytes bidireccional usado por el transporte ESP32.
 */
export interface Esp32ByteStream {
  /**
   * Envía bytes al dispositivo.
   *
   * @param data Bytes que deben enviarse.
   */
  send(data: Uint8Array): Promise<void>;
  /** Cierra el flujo de forma idempotente. */
  close(): Promise<void>;
  /**
   * Registra un receptor de datos.
   *
   * @param listener Receptor de bytes recibidos.
   * @returns Función que retira el receptor.
   */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /**
   * Registra un receptor de errores de transporte.
   *
   * @param listener Receptor de errores.
   * @returns Función que retira el receptor.
   */
  onError(listener: (error: Error) => void): () => void;
  /**
   * Registra un receptor de cierre remoto.
   *
   * @param listener Receptor de cierre.
   * @returns Función que retira el receptor.
   */
  onClose(listener: () => void): () => void;
}

/**
 * Transporte ESP32 completo, inyectable para pruebas o para otro sistema.
 */
export interface Esp32Transport {
  /**
   * Abre una conexión con el dispositivo.
   *
   * @returns Flujo de bytes conectado.
   */
  connect(): Promise<Esp32ByteStream>;
}

/**
 * Adaptador BLE necesario porque Node.js no expone radio BLE portable.
 */
export interface Esp32BleAdapter {
  /**
   * Conecta con la characteristic BLE configurada.
   *
   * @param options Identificador y UUIDs del dispositivo y characteristic.
   * @returns Flujo de bytes BLE conectado.
   */
  connect(options: {
    /** Identificador del dispositivo BLE. */
    deviceId: string;
    /** UUID del servicio GATT. */
    serviceUuid: string;
    /** UUID de la characteristic de datos. */
    characteristicUuid: string;
    /** Tiempo máximo de conexión en milisegundos. */
    timeoutMs: number;
  }): Promise<Esp32ByteStream>;
}

/**
 * Configuración del bridge del prototipo DIY ESP32 + MAX30102.
 */
export interface Esp32BridgeConfig {
  /** Transporte físico utilizado. */
  mode?: "tcp" | "ble";
  /** Host TCP permitido y destino de la conexión. */
  host?: string;
  /** Puerto TCP permitido y destino de la conexión. */
  port?: number;
  /** Lista explícita de hosts TCP permitidos. */
  allowedHosts?: readonly string[];
  /** Lista explícita de puertos TCP permitidos. */
  allowedPorts?: readonly number[];
  /** Identificador BLE del dispositivo. */
  deviceId?: string;
  /** Lista explícita de identificadores BLE permitidos. */
  allowedDeviceIds?: readonly string[];
  /** UUID del servicio GATT BLE. */
  serviceUuid?: string;
  /** UUID de la characteristic GATT BLE. */
  characteristicUuid?: string;
  /** Tiempo máximo de inactividad o de espera de PONG en milisegundos. */
  timeoutMs?: number;
  /** Transporte completo inyectado, útil para pruebas y para BLE nativo. */
  transport?: Esp32Transport;
  /** Adaptador BLE inyectado cuando `mode` es `ble`. */
  bleAdapter?: Esp32BleAdapter;
  /** Callback que recibe las muestras de constantes vitales. */
  onSample?: (sample: BiometricSample) => MaybePromise<void>;
  /** Callback que recibe las tramas ECG decodificadas. */
  onEcg?: (frame: Esp32EcgFrame) => MaybePromise<void>;
  /** Callback que recibe fallos del dispositivo o del protocolo. */
  onError?: (error: Error) => MaybePromise<void>;
}

/**
 * Configuración de los bridges disponibles en una instancia de biometría.
 */
export interface BiometricBridgeConfigs {
  /** Bridge de Garmin Health API. */
  garmin?: GarminBridgeConfig;
  /** Bridge de Oura API v2. */
  oura?: OuraBridgeConfig;
  /** Bridge de Polar AccessLink API v3. */
  polar?: PolarBridgeConfig;
  /** Bridge del dispositivo ESP32. */
  esp32?: Esp32BridgeConfig;
}

/**
 * Configuración agregada del subsistema biométrico.
 */
export interface BiometricsConfig {
  /** Configuración del pipeline HRV y de estrés. */
  pipeline?: BiometricPipelineConfig;
  /** Configuración del verificador de huella vocal. */
  voiceprint?: VoiceprintConfig;
  /** Configuración del detector de actividad de voz. */
  vad?: VadConfig;
  /** Bridges de proveedores y dispositivos que se deben construir. */
  bridges?: BiometricBridgeConfigs;
}
