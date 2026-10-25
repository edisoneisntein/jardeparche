import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BiometricsError, toBiometricsError } from "../errors.js";
import type {
  BiometricSample,
  Esp32BleAdapter,
  Esp32BridgeConfig,
  Esp32ByteStream,
  Esp32ControlFrame,
  Esp32EcgFrame,
  Esp32Frame,
  Esp32Transport,
  Esp32VitalsFrame,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAGIC_0 = 0xaa;
const MAGIC_1 = 0x55;
const PROTOCOL_VERSION = 1;
const HEADER_LENGTH = 20;
const CRC_OFFSET = 18;
const TYPE_PING = 0x01;
const TYPE_PONG = 0x02;
const TYPE_VITALS = 0x10;
const TYPE_ECG = 0x11;

/**
 * Cliente del protocolo binario DIY ESP32 + MAX30102.
 *
 * El protocolo usa tramas little-endian con cabecera de 20 bytes, payload de
 * longitud variable y CRC-16/CCITT-FALSE. Las tramas de constantes vitales
 * incluyen frecuencia cardíaca y HRV; las tramas ECG transportan muestras
 * PCM 16 bits con signo y su frecuencia de muestreo.
 */
export class Esp32Bridge {
  private readonly mode: "tcp" | "ble";
  private readonly timeoutMs: number;
  private readonly allowedHosts: Set<string>;
  private readonly allowedPorts: Set<number>;
  private readonly allowedDeviceIds: Set<string>;
  private readonly host?: string;
  private readonly port?: number;
  private readonly deviceId?: string;
  private readonly serviceUuid?: string;
  private readonly characteristicUuid?: string;
  private stream?: Esp32ByteStream;
  private removeDataListener?: () => void;
  private removeErrorListener?: () => void;
  private removeCloseListener?: () => void;
  private inactivityTimer?: ReturnType<typeof setTimeout>;
  private pendingPong?: () => void;
  private pendingPongReject?: (error: Error) => void;
  private running = false;

  /**
   * Crea un bridge ESP32 y valida su allowlist.
   *
   * @param config Transporte, destino, allowlists, timeout y callbacks.
   * @throws BiometricsError si el destino no está permitido o falta una UUID BLE.
   */
  constructor(private readonly config: Esp32BridgeConfig = {}) {
    this.mode = config.mode ?? "tcp";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new BiometricsError("configuration", "timeoutMs debe ser un número positivo.");
    }
    this.allowedHosts = new Set(config.allowedHosts ?? []);
    this.allowedPorts = new Set(config.allowedPorts ?? []);
    this.allowedDeviceIds = new Set(config.allowedDeviceIds ?? []);
    this.host = config.host;
    this.port = config.port;
    this.deviceId = config.deviceId;
    this.serviceUuid = config.serviceUuid;
    this.characteristicUuid = config.characteristicUuid;

    if (this.mode === "tcp") {
      if (this.host === undefined || this.host.length === 0) {
        throw new BiometricsError("configuration", "El modo TCP requiere un host ESP32.");
      }
      if (!this.allowedHosts.has(this.host)) {
        throw new BiometricsError("not_allowed", "El host ESP32 no está en la allowlist.");
      }
      if (this.port === undefined || !Number.isInteger(this.port) || this.port <= 0 || this.port > 65_535) {
        throw new BiometricsError("configuration", "El modo TCP requiere un puerto ESP32 válido.");
      }
      if (!this.allowedPorts.has(this.port)) {
        throw new BiometricsError("not_allowed", "El puerto ESP32 no está en la allowlist.");
      }
    } else {
      if (this.deviceId === undefined || this.deviceId.length === 0) {
        throw new BiometricsError("configuration", "El modo BLE requiere un identificador de dispositivo.");
      }
      if (!this.allowedDeviceIds.has(this.deviceId)) {
        throw new BiometricsError("not_allowed", "El dispositivo BLE no está en la allowlist.");
      }
      if (config.bleAdapter === undefined) {
        throw new BiometricsError(
          "configuration",
          "El modo BLE requiere un Esp32BleAdapter inyectado con acceso a la radio.",
        );
      }
      if (this.serviceUuid === undefined || this.characteristicUuid === undefined) {
        throw new BiometricsError("configuration", "El modo BLE requiere serviceUuid y characteristicUuid.");
      }
    }
  }

  /**
   * Indica si el bridge mantiene una conexión activa.
   *
   * @returns `true` después de completar el handshake PING/PONG.
   */
  get connected(): boolean {
    return this.running;
  }

  /**
   * Conecta con el dispositivo y completa un handshake PING/PONG.
   *
   * @returns Promesa resuelta cuando el dispositivo responde.
   * @throws BiometricsError si falla el transporte, el handshake o expira el timeout.
   */
  async start(): Promise<void> {
    if (this.running) return;
    const transport = this.createTransport();
    const stream = await transport.connect();
    this.stream = stream;
    const decoder = new Esp32FrameDecoder();

    this.removeDataListener = stream.onData((chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const frame of frames) this.handleFrame(frame);
      } catch (error: unknown) {
        this.reportError(toBiometricsError(error, "protocol", "esp32"));
      }
    });
    this.removeErrorListener = stream.onError((error) => {
      this.reportError(toBiometricsError(error, "network", "esp32"));
    });
    this.removeCloseListener = stream.onClose(() => {
      if (this.running) this.reportError(new BiometricsError("network", "El ESP32 cerró la conexión."));
      this.running = false;
    });

    const pong = new Promise<void>((resolve, reject) => {
      this.pendingPong = resolve;
      this.pendingPongReject = reject;
    });
    const handshakeTimer = setTimeout(() => {
      this.pendingPongReject?.(
        new BiometricsError("timeout", `El ESP32 no respondió al PING en ${this.timeoutMs} ms.`, {
          provider: "esp32",
        }),
      );
    }, this.timeoutMs);
    this.inactivityTimer = handshakeTimer;

    try {
      await stream.send(encodeEsp32ControlFrame("ping", 0, Date.now()));
      await pong;
      this.running = true;
      this.resetInactivityTimer();
    } catch (error: unknown) {
      await this.stop();
      throw toBiometricsError(error, "network", "esp32");
    } finally {
      this.pendingPong = undefined;
      this.pendingPongReject = undefined;
    }
  }

  /**
   * Detiene la conexión y libera todos los listeners.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.inactivityTimer !== undefined) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
    this.removeDataListener?.();
    this.removeErrorListener?.();
    this.removeCloseListener?.();
    this.removeDataListener = undefined;
    this.removeErrorListener = undefined;
    this.removeCloseListener = undefined;
    const stream = this.stream;
    this.stream = undefined;
    if (stream !== undefined) await stream.close();
  }

  /**
   * Construye el transporte según el modo configurado.
   *
   * @returns Transporte TCP, BLE o inyectado.
   */
  private createTransport(): Esp32Transport {
    if (this.config.transport !== undefined) return this.config.transport;
    if (this.mode === "tcp") {
      return new TcpEsp32Transport(this.host ?? "", this.port ?? 0, this.timeoutMs);
    }
    const adapter = this.config.bleAdapter as Esp32BleAdapter;
    return {
      connect: async () => adapter.connect({
        deviceId: this.deviceId ?? "",
        serviceUuid: this.serviceUuid ?? "",
        characteristicUuid: this.characteristicUuid ?? "",
        timeoutMs: this.timeoutMs,
      }),
    };
  }

  /**
   * Procesa una trama decodificada y actualiza el estado de conexión.
   *
   * @param frame Trama ESP32 válida.
   */
  private handleFrame(frame: Esp32Frame): void {
    this.resetInactivityTimer();
    if (frame.type === "pong") {
      this.pendingPong?.();
      return;
    }
    if (frame.type === "vitals") {
      const sample: BiometricSample = {
        ts: frame.timestampMs,
        heartRate: frame.heartRate,
        hrvMs: frame.hrvMs,
        source: "esp32",
      };
      void this.deliverSample(sample);
      return;
    }
    if (frame.type !== "ecg") return;
    void this.deliverEcg(frame);
  }

  /**
   * Entrega una muestra al callback configurado.
   *
   * @param sample Muestra de constantes vitales.
   */
  private async deliverSample(sample: BiometricSample): Promise<void> {
    const callback = this.config.onSample;
    if (callback === undefined) return;
    try {
      await callback(sample);
    } catch (error: unknown) {
      this.reportError(toBiometricsError(error, "unknown", "esp32"));
    }
  }

  /**
   * Entrega una trama ECG al callback configurado.
   *
   * @param frame Trama ECG decodificada.
   */
  private async deliverEcg(frame: Esp32EcgFrame): Promise<void> {
    const callback = this.config.onEcg;
    if (callback === undefined) return;
    try {
      await callback(frame);
    } catch (error: unknown) {
      this.reportError(toBiometricsError(error, "unknown", "esp32"));
    }
  }

  /**
   * Reinicia el temporizador de inactividad de la conexión.
   */
  private resetInactivityTimer(): void {
    if (this.inactivityTimer !== undefined) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.reportError(
        new BiometricsError("timeout", `El ESP32 dejó de enviar datos durante ${this.timeoutMs} ms.`, {
          provider: "esp32",
        }),
      );
      void this.stop();
    }, this.timeoutMs);
  }

  /**
   * Notifica un fallo sin lanzar excepciones desde listeners asíncronos.
   *
   * @param error Error ya tipado.
   */
  private reportError(error: BiometricsError): void {
    this.pendingPongReject?.(error);
    const callback = this.config.onError;
    if (callback === undefined) return;
    void Promise.resolve(callback(error)).catch((callbackError: unknown) => {
      if (callbackError instanceof Error) return;
    });
  }
}

/**
 * Decodificador incremental de tramas del protocolo ESP32.
 */
export class Esp32FrameDecoder {
  private buffered = Buffer.alloc(0);

  /**
   * Incorpora bytes recibidos y devuelve las tramas completas.
   *
   * @param chunk Bytes recibidos del transporte.
   * @returns Tramas completas decodificadas.
   * @throws BiometricsError si el magic, la versión, el CRC o el payload son inválidos.
   */
  push(chunk: Uint8Array): Esp32Frame[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: Esp32Frame[] = [];
    while (this.buffered.length >= HEADER_LENGTH) {
      if (this.buffered[0] !== MAGIC_0 || this.buffered[1] !== MAGIC_1) {
        throw new BiometricsError("protocol", "La trama ESP32 no contiene el magic esperado.", {
          provider: "esp32",
        });
      }
      const payloadLength = this.buffered.readUInt16LE(15);
      const frameLength = HEADER_LENGTH + payloadLength;
      if (this.buffered.length < frameLength) break;
      const frameBuffer = this.buffered.subarray(0, frameLength);
      frames.push(decodeEsp32Frame(frameBuffer));
      this.buffered = this.buffered.subarray(frameLength);
    }
    return frames;
  }

  /**
   * Descarta bytes parciales pendientes.
   */
  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}

/**
 * Codifica una trama de constantes vitales ESP32.
 *
 * @param frame Datos que se deben serializar.
 * @returns Trama binaria completa.
 * @throws BiometricsError si un valor no cabe en el protocolo.
 */
export function encodeEsp32VitalsFrame(frame: Esp32VitalsFrame): Uint8Array {
  validateSequence(frame.sequence);
  validateTimestamp(frame.timestampMs);
  validateUint16(frame.heartRate, "heartRate");
  validateUint16(frame.hrvMs, "hrvMs");
  const payload = Buffer.alloc(8);
  payload.writeUInt16LE(frame.heartRate, 0);
  payload.writeUInt16LE(frame.hrvMs, 2);
  payload.writeUInt16LE(0, 4);
  payload.writeUInt16LE(0, 6);
  return encodeEsp32Frame(TYPE_VITALS, frame.sequence, frame.timestampMs, payload);
}

/**
 * Codifica una trama ECG ESP32.
 *
 * @param frame Datos que se deben serializar.
 * @returns Trama binaria completa.
 * @throws BiometricsError si el payload no cabe en el protocolo.
 */
export function encodeEsp32EcgFrame(frame: Esp32EcgFrame): Uint8Array {
  validateSequence(frame.sequence);
  validateTimestamp(frame.timestampMs);
  if (!Number.isInteger(frame.sampleRateHz) || frame.sampleRateHz <= 0 || frame.sampleRateHz > 65_535) {
    throw new BiometricsError("invalid_input", "sampleRateHz debe ser un entero entre 1 y 65535.");
  }
  const payloadLength = 2 + frame.samples.length * 2;
  if (payloadLength > 65_535) {
    throw new BiometricsError("invalid_input", "La trama ECG supera el payload máximo.");
  }
  const payload = Buffer.alloc(payloadLength);
  payload.writeUInt16LE(frame.sampleRateHz, 0);
  for (let index = 0; index < frame.samples.length; index += 1) {
    const sample = frame.samples[index];
    if (sample === undefined) continue;
    payload.writeInt16LE(sample, 2 + index * 2);
  }
  return encodeEsp32Frame(TYPE_ECG, frame.sequence, frame.timestampMs, payload);
}

/**
 * Codifica una trama de control PING o PONG.
 *
 * @param type Tipo de control.
 * @param sequence Número de secuencia.
 * @param timestampMs Marca temporal en milisegundos desde Unix.
 * @returns Trama binaria completa.
 */
export function encodeEsp32ControlFrame(
  type: "ping" | "pong",
  sequence: number,
  timestampMs: number,
): Uint8Array {
  validateSequence(sequence);
  validateTimestamp(timestampMs);
  return encodeEsp32Frame(type === "ping" ? TYPE_PING : TYPE_PONG, sequence, timestampMs, Buffer.alloc(0));
}

/**
 * Transporte TCP funcional basado en el cliente `nc` del sistema.
 *
 * Antes de abrir el flujo de datos se ejecuta una sonda TCP sin payload. El
 * proceso se invoca sin shell y con argumentos separados para evitar
 * interpretación de comandos.
 */
export class TcpEsp32Transport implements Esp32Transport {
  /**
   * Crea un transporte TCP.
   *
   * @param host Host permitido de destino.
   * @param port Puerto permitido de destino.
   * @param timeoutMs Tiempo máximo de conexión e inactividad.
   */
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Sonda el puerto y abre el flujo TCP de datos.
   *
   * @returns Flujo de bytes conectado.
   * @throws BiometricsError si la sonda o el proceso `nc` fallan.
   */
  async connect(): Promise<Esp32ByteStream> {
    await probeTcpPort(this.host, this.port, this.timeoutMs);
    return new NetcatEsp32Stream(this.host, this.port);
  }
}

/**
 * Decodifica una trama ESP32 completa.
 *
 * @param frameBuffer Trama binaria completa.
 * @returns Trama tipada.
 * @throws BiometricsError si la trama no cumple el protocolo.
 */
export function decodeEsp32Frame(frameBuffer: Uint8Array): Esp32Frame {
  const buffer = Buffer.from(frameBuffer);
  if (buffer.length < HEADER_LENGTH) {
    throw new BiometricsError("protocol", "La trama ESP32 está truncada.", { provider: "esp32" });
  }
  if (buffer[0] !== MAGIC_0 || buffer[1] !== MAGIC_1) {
    throw new BiometricsError("protocol", "La trama ESP32 no contiene el magic esperado.", {
      provider: "esp32",
    });
  }
  const version = buffer[2];
  if (version !== PROTOCOL_VERSION) {
    throw new BiometricsError("protocol", `Versión ESP32 no soportada: ${version}.`, {
      provider: "esp32",
    });
  }
  const type = buffer[3];
  const sequence = buffer.readUInt16LE(5);
  const timestampMs = Number(buffer.readBigUInt64LE(7));
  const payloadLength = buffer.readUInt16LE(15);
  if (buffer.length !== HEADER_LENGTH + payloadLength) {
    throw new BiometricsError("protocol", "La longitud del payload ESP32 no coincide.", {
      provider: "esp32",
    });
  }
  const payload = buffer.subarray(HEADER_LENGTH);
  const expectedCrc = crc16Esp32(Buffer.concat([buffer.subarray(0, CRC_OFFSET), payload]));
  const receivedCrc = buffer.readUInt16LE(CRC_OFFSET);
  if (expectedCrc !== receivedCrc) {
    throw new BiometricsError("protocol", "El CRC de la trama ESP32 no es válido.", {
      provider: "esp32",
    });
  }

  if (type === TYPE_PING || type === TYPE_PONG) {
    const control: Esp32ControlFrame = {
      type: type === TYPE_PING ? "ping" : "pong",
      sequence,
      timestampMs,
    };
    return control;
  }
  if (type === TYPE_VITALS) {
    if (payload.length !== 8) {
      throw new BiometricsError("protocol", "El payload de constantes vitales ESP32 es inválido.", {
        provider: "esp32",
      });
    }
    const vitals: Esp32VitalsFrame = {
      type: "vitals",
      sequence,
      timestampMs,
      heartRate: payload.readUInt16LE(0),
      hrvMs: payload.readUInt16LE(2),
    };
    return vitals;
  }
  if (type === TYPE_ECG) {
    if (payload.length < 2 || (payload.length - 2) % 2 !== 0) {
      throw new BiometricsError("protocol", "El payload ECG ESP32 es inválido.", {
        provider: "esp32",
      });
    }
    const sampleCount = (payload.length - 2) / 2;
    const samples = new Int16Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = payload.readInt16LE(2 + index * 2);
    }
    const ecg: Esp32EcgFrame = {
      type: "ecg",
      sequence,
      timestampMs,
      sampleRateHz: payload.readUInt16LE(0),
      samples,
    };
    return ecg;
  }
  throw new BiometricsError("protocol", `Tipo de trama ESP32 desconocido: ${type}.`, {
    provider: "esp32",
  });
}

/**
 * Serializa una cabecera y payload con CRC-16/CCITT-FALSE.
 *
 * @param type Tipo de trama.
 * @param sequence Número de secuencia.
 * @param timestampMs Marca temporal en milisegundos desde Unix.
 * @param payload Payload de la trama.
 * @returns Trama completa.
 */
function encodeEsp32Frame(
  type: number,
  sequence: number,
  timestampMs: number,
  payload: Buffer,
): Uint8Array {
  const header = Buffer.alloc(HEADER_LENGTH);
  header[0] = MAGIC_0;
  header[1] = MAGIC_1;
  header[2] = PROTOCOL_VERSION;
  header[3] = type;
  header[4] = 0;
  header.writeUInt16LE(sequence, 5);
  header.writeBigUInt64LE(BigInt(timestampMs), 7);
  header.writeUInt16LE(payload.length, 15);
  header[17] = 0;
  const crc = crc16Esp32(Buffer.concat([header.subarray(0, CRC_OFFSET), payload]));
  header.writeUInt16LE(crc, CRC_OFFSET);
  return Buffer.concat([header, payload]);
}

/**
 * Calcula CRC-16/CCITT-FALSE sobre bytes del protocolo ESP32.
 *
 * @param bytes Bytes protegidos por CRC.
 * @returns CRC de 16 bits.
 */
export function crc16Esp32(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/**
 * Valida un número de secuencia de 16 bits.
 *
 * @param sequence Secuencia que se debe validar.
 */
function validateSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65_535) {
    throw new BiometricsError("invalid_input", "El número de secuencia ESP32 debe caber en uint16.");
  }
}

/**
 * Valida una marca temporal que se serializa como uint64.
 *
 * @param timestampMs Marca temporal en milisegundos.
 */
function validateTimestamp(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new BiometricsError("invalid_input", "La marca temporal ESP32 no es un entero seguro válido.");
  }
}

/**
 * Valida un entero que se serializa como uint16.
 *
 * @param value Valor que se debe validar.
 * @param name Nombre público del campo.
 */
function validateUint16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new BiometricsError("invalid_input", `${name} debe ser un entero entre 0 y 65535.`);
  }
}

/**
 * Ejecuta una sonda TCP sin payload mediante `nc -z`.
 *
 * @param host Host de destino.
 * @param port Puerto de destino.
 * @param timeoutMs Tiempo máximo de la sonda.
 * @returns Promesa resuelta cuando el puerto acepta conexiones.
 */
async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("nc", ["-z", host, String(port)], { stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new BiometricsError("timeout", `No se pudo abrir TCP ${host}:${port} en ${timeoutMs} ms.`, {
        provider: "esp32",
      }));
    }, timeoutMs);

    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new BiometricsError("network", "No se pudo ejecutar la sonda TCP del ESP32.", {
        provider: "esp32",
        cause: error,
      }));
    });
    child.once("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(new BiometricsError("network", `No se pudo conectar con el ESP32 en ${host}:${port}.`, {
          provider: "esp32",
        }));
      }
    });
  });
}

/**
 * Flujo de bytes TCP respaldado por `nc`.
 */
class NetcatEsp32Stream implements Esp32ByteStream {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();

  /**
   * Inicia el proceso `nc` que transporta la conexión ESP32.
   *
   * @param host Host de destino.
   * @param port Puerto de destino.
   */
  constructor(host: string, port: number) {
    this.child = spawn("nc", [host, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const listener of this.dataListeners) listener(chunk);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length > 0) {
        const error = new Error(`netcat ESP32: ${chunk.toString("utf8").slice(0, 200)}`);
        for (const listener of this.errorListeners) listener(error);
      }
    });
    this.child.once("error", (error: Error) => {
      for (const listener of this.errorListeners) listener(error);
    });
    this.child.once("close", () => {
      for (const listener of this.closeListeners) listener();
    });
  }

  /**
   * Escribe bytes en la conexión TCP.
   *
   * @param data Bytes que se deben enviar.
   */
  async send(data: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error?: Error | null) => {
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    });
  }

  /**
   * Cierra stdin y termina el proceso `nc`.
   */
  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
  }

  /**
   * Registra un listener de datos recibidos.
   *
   * @param listener Listener de datos.
   * @returns Función para retirarlo.
   */
  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /**
   * Registra un listener de error del proceso.
   *
   * @param listener Listener de error.
   * @returns Función para retirarlo.
   */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /**
   * Registra un listener de cierre del proceso.
   *
   * @param listener Listener de cierre.
   * @returns Función para retirarlo.
   */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}
