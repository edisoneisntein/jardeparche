import { spawn as spawnChildProcess } from "node:child_process";
import { DomoticsError, toDomoticsError } from "./errors.js";
import type {
  MatterCliProcess,
  MatterClient,
  MatterCommissionOptions,
  MatterCommissionResult,
  MatterConfig,
  MatterFetch,
  MatterHttpResponse,
  MatterPairResult,
  MatterSetResult,
  MatterSpawner,
  MatterStatus,
} from "./types.js";

/**
 * Cliente Matter/Thread basado en HTTP.
 *
 * El Border Router Thread real se despliega aparte de este paquete. Esta
 * clase solo habla con ese servicio mediante un contrato HTTP estable; no
 * intenta cargar un driver nativo dentro de Node.js.
 */
export class HttpMatterClient implements MatterClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: MatterFetch;
  private readonly token?: string;
  private readonly timeoutMs: number;

  /**
   * Crea un cliente HTTP de Matter.
   *
   * @param config URL base, credenciales, timeout y transporte inyectable.
   */
  constructor(config: MatterConfig) {
    if (!config.endpoint?.trim()) {
      throw new DomoticsError("configuration", "Matter HTTP necesita un endpoint configurable.");
    }
    try {
      this.endpoint = new URL(config.endpoint.endsWith("/") ? config.endpoint : `${config.endpoint}/`);
    } catch (error: unknown) {
      throw new DomoticsError("configuration", "El endpoint HTTP de Matter no es válido.", { cause: error });
    }
    if (this.endpoint.protocol !== "http:" && this.endpoint.protocol !== "https:") {
      throw new DomoticsError("configuration", "El endpoint HTTP de Matter debe usar HTTP o HTTPS.");
    }
    this.fetchImpl = config.fetch ?? defaultMatterFetch();
    this.token = config.token?.trim() || undefined;
    this.timeoutMs = Math.max(1, config.timeoutMs ?? 10_000);
  }

  /**
   * Empareja un dispositivo mediante `POST /pair`.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @returns Resultado de pairado.
   */
  async pair(deviceId: string): Promise<MatterPairResult> {
    validateDeviceId(deviceId);
    const result = await this.call("pair", "POST", { deviceId });
    return {
      deviceId,
      paired: readBoolean(result, "paired") ?? true,
      ...(readString(result, "status") ? { status: readString(result, "status") } : {}),
    };
  }

  /**
   * Comisiona un dispositivo mediante `POST /commission`.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param options Red, passcode y metadatos opcionales.
   * @returns Resultado de comisión.
   */
  async commission(deviceId: string, options: MatterCommissionOptions = {}): Promise<MatterCommissionResult> {
    validateDeviceId(deviceId);
    const result = await this.call("commission", "POST", { deviceId, ...options });
    return {
      deviceId,
      commissioned: readBoolean(result, "commissioned") ?? true,
      ...(readString(result, "status") ? { status: readString(result, "status") } : {}),
    };
  }

  /**
   * Escribe un atributo mediante `POST /set`.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @param value Valor JSON que se debe escribir.
   * @returns Resultado de la escritura.
   */
  async set(deviceId: string, cluster: string, attribute: string, value: unknown): Promise<MatterSetResult> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    await this.call("set", "POST", { deviceId, cluster, attribute, value });
    return { deviceId, cluster, attribute, value };
  }

  /**
   * Lee un atributo mediante `POST /read`.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @returns Valor leído o la respuesta completa si el Border Router no la envuelve.
   */
  async read(deviceId: string, cluster: string, attribute: string): Promise<unknown> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    const result = await this.call("read", "POST", { deviceId, cluster, attribute });
    if (isRecord(result) && "value" in result) return result.value;
    return result;
  }

  /**
   * Consulta el estado mediante `GET /status`.
   *
   * @param deviceId Dispositivo opcional que se quiere consultar.
   * @returns Estado normalizado del dispositivo o del Border Router.
   */
  async status(deviceId?: string): Promise<MatterStatus> {
    const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
    const result = await this.call(`status${query}`, "GET");
    const status: MatterStatus = {
      paired: readBoolean(result, "paired") ?? false,
      commissioned: readBoolean(result, "commissioned") ?? false,
      connected: readBoolean(result, "connected") ?? false,
    };
    if (deviceId) status.deviceId = deviceId;
    const network = readString(result, "network");
    if (network) status.network = network;
    return status;
  }

  /**
   * Ejecuta una operación HTTP y devuelve su cuerpo JSON.
   *
   * @param operation Ruta relativa de la operación.
   * @param method Método HTTP.
   * @param body Cuerpo JSON opcional.
   * @returns Respuesta JSON desconocida.
   */
  private async call(operation: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
    const url = new URL(operation, this.endpoint);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DomoticsError("protocol", `Matter respondió con estado HTTP ${response.status}.`);
      }
      const payload = await readResponseBody(response);
      return payload;
    } catch (error: unknown) {
      if (error instanceof DomoticsError) throw error;
      if (controller.signal.aborted) {
        throw new DomoticsError("timeout", "La operación HTTP de Matter excedió el tiempo previsto.");
      }
      throw toDomoticsError(error, "network");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Cliente Matter/Thread basado en una CLI local.
 *
 * La CLI recibe un comando fijo (`pair`, `commission`, `set`, `read` o
 * `status`) y un payload JSON por entrada estándar. No se construye una
 * cadena de shell, por lo que los identificadores de dispositivo no pueden
 * inyectar argumentos adicionales.
 */
export class CliMatterClient implements MatterClient {
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;
  private readonly spawner: MatterSpawner;

  /**
   * Crea un cliente CLI de Matter.
   *
   * @param config Comando, argumentos base, timeout y factoría de proceso.
   */
  constructor(config: MatterConfig) {
    this.command = config.cliCommand?.trim() || "matter";
    this.baseArgs = [...(config.cliArgs ?? [])];
    this.timeoutMs = Math.max(1, config.timeoutMs ?? 10_000);
    this.spawner = config.spawner ?? defaultMatterSpawner;
  }

  /**
   * Empareja un dispositivo mediante la CLI.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @returns Resultado de pairado.
   */
  async pair(deviceId: string): Promise<MatterPairResult> {
    validateDeviceId(deviceId);
    const result = await this.run("pair", { deviceId });
    return {
      deviceId,
      paired: readBoolean(result, "paired") ?? true,
      ...(readString(result, "status") ? { status: readString(result, "status") } : {}),
    };
  }

  /**
   * Comisiona un dispositivo mediante la CLI.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param options Red, passcode y metadatos opcionales.
   * @returns Resultado de comisión.
   */
  async commission(deviceId: string, options: MatterCommissionOptions = {}): Promise<MatterCommissionResult> {
    validateDeviceId(deviceId);
    const result = await this.run("commission", { deviceId, ...options });
    return {
      deviceId,
      commissioned: readBoolean(result, "commissioned") ?? true,
      ...(readString(result, "status") ? { status: readString(result, "status") } : {}),
    };
  }

  /**
   * Escribe un atributo mediante la CLI.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @param value Valor JSON que se debe escribir.
   * @returns Resultado de la escritura.
   */
  async set(deviceId: string, cluster: string, attribute: string, value: unknown): Promise<MatterSetResult> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    await this.run("set", { deviceId, cluster, attribute, value });
    return { deviceId, cluster, attribute, value };
  }

  /**
   * Lee un atributo mediante la CLI.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @returns Valor leído.
   */
  async read(deviceId: string, cluster: string, attribute: string): Promise<unknown> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    const result = await this.run("read", { deviceId, cluster, attribute });
    if (isRecord(result) && "value" in result) return result.value;
    return result;
  }

  /**
   * Consulta el estado mediante la CLI.
   *
   * @param deviceId Dispositivo opcional que se quiere consultar.
   * @returns Estado normalizado.
   */
  async status(deviceId?: string): Promise<MatterStatus> {
    const result = await this.run("status", deviceId ? { deviceId } : {});
    const status: MatterStatus = {
      paired: readBoolean(result, "paired") ?? false,
      commissioned: readBoolean(result, "commissioned") ?? false,
      connected: readBoolean(result, "connected") ?? false,
    };
    if (deviceId) status.deviceId = deviceId;
    const network = readString(result, "network");
    if (network) status.network = network;
    return status;
  }

  /**
   * Ejecuta una operación CLI y decodifica su salida JSON.
   *
   * @param operation Operación permitida.
   * @param payload Payload JSON enviado por entrada estándar.
   * @returns Respuesta JSON desconocida.
   */
  private async run(operation: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_MATTER_OPERATIONS.has(operation)) {
      throw new DomoticsError("unsupported", `Operación Matter no permitida: ${operation}.`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
    let child: MatterCliProcess;
    try {
      child = this.spawner(this.command, [...this.baseArgs, operation], { detached: true, shell: false });
    } catch (error: unknown) {
      clearTimeout(timeout);
      throw toDomoticsError(error, "process");
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    if (child.stdin) {
      child.stdin.end(JSON.stringify(payload));
    }

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let settled = false;
        const finish = (code: number | null, signal: string | null): void => {
          if (settled) return;
          settled = true;
          if (controller.signal.aborted) {
            reject(new DomoticsError("timeout", "La operación CLI de Matter excedió el tiempo previsto."));
            return;
          }
          if (code !== 0) {
            reject(new DomoticsError("process", `Matter CLI terminó con código ${code ?? "desconocido"}.`));
            return;
          }
          void signal;
          resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        };
        registerCliListener(child, "close", (value: unknown, signalValue: unknown) => {
          const code = typeof value === "number" ? value : null;
          const signal = typeof signalValue === "string" ? signalValue : null;
          finish(code, signal);
        });
        registerCliListener(child, "error", (value: unknown) => {
          if (settled) return;
          settled = true;
          reject(toDomoticsError(value, "process"));
        });
        controller.signal.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          killProcessGroup(child, "SIGKILL");
          reject(new DomoticsError("timeout", "La operación CLI de Matter excedió el tiempo previsto."));
        }, { once: true });
      });
      const text = result.stdout.trim();
      if (!text) return {};
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch (error: unknown) {
        throw new DomoticsError("invalid_response", "Matter CLI no devolvió JSON válido.", { cause: error });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Cliente Matter de prueba respaldado completamente por memoria.
 *
 * Permite probar las herramientas sin un Border Router y conserva el estado
 * de cada dispositivo durante la vida del objeto.
 */
export class InMemoryMatterClient implements MatterClient {
  private readonly devices = new Map<string, MemoryMatterDevice>();

  /**
   * Empareja un dispositivo en memoria.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @returns Resultado de pairado.
   */
  async pair(deviceId: string): Promise<MatterPairResult> {
    validateDeviceId(deviceId);
    const device = this.devices.get(deviceId) ?? { paired: false, commissioned: false, attributes: new Map() };
    device.paired = true;
    this.devices.set(deviceId, device);
    return { deviceId, paired: true, status: "paired" };
  }

  /**
   * Comisiona un dispositivo en memoria.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param options Opciones de comisión; se aceptan para mantener el contrato.
   * @returns Resultado de comisión.
   */
  async commission(deviceId: string, options: MatterCommissionOptions = {}): Promise<MatterCommissionResult> {
    validateDeviceId(deviceId);
    void options;
    const device = this.devices.get(deviceId);
    if (!device?.paired) {
      throw new DomoticsError("not_found", `El dispositivo Matter ${deviceId} no está emparejado.`);
    }
    device.commissioned = true;
    return { deviceId, commissioned: true, status: "commissioned" };
  }

  /**
   * Escribe un atributo en memoria.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @param value Valor JSON que se debe escribir.
   * @returns Resultado de la escritura.
   */
  async set(deviceId: string, cluster: string, attribute: string, value: unknown): Promise<MatterSetResult> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    const device = this.devices.get(deviceId);
    if (!device?.commissioned) {
      throw new DomoticsError("not_found", `El dispositivo Matter ${deviceId} no está comisionado.`);
    }
    device.attributes.set(attributeKey(cluster, attribute), value);
    return { deviceId, cluster, attribute, value };
  }

  /**
   * Lee un atributo en memoria.
   *
   * @param deviceId Identificador Matter del dispositivo.
   * @param cluster Cluster Matter.
   * @param attribute Atributo Matter.
   * @returns Valor almacenado o `undefined`.
   */
  async read(deviceId: string, cluster: string, attribute: string): Promise<unknown> {
    validateDeviceId(deviceId);
    validateClusterAttribute(cluster, attribute);
    return this.devices.get(deviceId)?.attributes.get(attributeKey(cluster, attribute));
  }

  /**
   * Consulta el estado en memoria.
   *
   * @param deviceId Dispositivo opcional que se quiere consultar.
   * @returns Estado del dispositivo o `false` en todos los indicadores si no existe.
   */
  async status(deviceId?: string): Promise<MatterStatus> {
    if (!deviceId) {
      return { paired: false, commissioned: false, connected: false };
    }
    const device = this.devices.get(deviceId);
    return {
      deviceId,
      paired: device?.paired ?? false,
      commissioned: device?.commissioned ?? false,
      connected: Boolean(device?.commissioned),
    };
  }
}

/** Alias del cliente HTTP con el nombre corto habitual. */
export type MatterHttpClient = HttpMatterClient;
export const MatterHttpClient = HttpMatterClient;

/** Alias del cliente CLI con el nombre corto habitual. */
export type MatterCliClient = CliMatterClient;
export const MatterCliClient = CliMatterClient;

interface MemoryMatterDevice {
  paired: boolean;
  commissioned: boolean;
  attributes: Map<string, unknown>;
}

const ALLOWED_MATTER_OPERATIONS = new Set(["pair", "commission", "set", "read", "status"]);

/**
 * Crea el cliente Matter seleccionado por la configuración.
 *
 * @param config Configuración de transporte.
 * @returns Cliente Matter listo para usar.
 */
export function createMatterClient(config: MatterConfig = {}): MatterClient {
  const transport = config.transport ?? (config.endpoint ? "http" : config.cliCommand ? "cli" : "memory");
  if (transport === "http") return new HttpMatterClient(config);
  if (transport === "cli") return new CliMatterClient(config);
  return new InMemoryMatterClient();
}

/**
 * Valida un identificador de dispositivo Matter.
 *
 * @param deviceId Identificador recibido del llamante.
 */
function validateDeviceId(deviceId: string): void {
  if (!deviceId.trim() || deviceId.length > 256 || /[\u0000\r\n]/.test(deviceId)) {
    throw new DomoticsError("configuration", "El identificador de dispositivo Matter no es válido.");
  }
}

/**
 * Valida nombres de cluster y atributo antes de enviarlos al Border Router.
 *
 * @param cluster Cluster Matter.
 * @param attribute Atributo Matter.
 */
function validateClusterAttribute(cluster: string, attribute: string): void {
  if (!cluster.trim() || !attribute.trim() || cluster.length > 128 || attribute.length > 128) {
    throw new DomoticsError("configuration", "El cluster o atributo Matter no es válido.");
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(cluster) || !/^[A-Za-z0-9_.:-]+$/.test(attribute)) {
    throw new DomoticsError("configuration", "El cluster o atributo Matter contiene caracteres no permitidos.");
  }
}

/**
 * Construye la clave interna de un atributo.
 *
 * @param cluster Cluster Matter.
 * @param attribute Atributo Matter.
 * @returns Clave única.
 */
function attributeKey(cluster: string, attribute: string): string {
  return `${cluster}.${attribute}`;
}

/**
 * Comprueba si un valor es un objeto indexable.
 *
 * @param value Valor a comprobar.
 * @returns `true` si es un objeto no nulo.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lee un booleano de una respuesta JSON.
 *
 * @param value Respuesta JSON.
 * @param key Clave que se debe leer.
 * @returns Booleano o `undefined`.
 */
function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

/**
 * Lee un string de una respuesta JSON.
 *
 * @param value Respuesta JSON.
 * @param key Clave que se debe leer.
 * @returns String o `undefined`.
 */
function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Usa el fetch global como transporte HTTP por defecto.
 *
 * @returns Función de fetch compatible con el contrato de Matter.
 */
function defaultMatterFetch(): MatterFetch {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") {
    throw new DomoticsError("configuration", "Este runtime no dispone de fetch global.");
  }
  return async (input, init) => {
    const response = await nativeFetch(input, init);
    return response;
  };
}

/**
 * Lee el cuerpo JSON de una respuesta HTTP de Matter.
 *
 * @param response Respuesta del transporte.
 * @returns Cuerpo JSON o `{}` si está vacío.
 */
async function readResponseBody(response: MatterHttpResponse): Promise<unknown> {
  if (response.text) {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (error: unknown) {
      throw new DomoticsError("invalid_response", "Matter devolvió una respuesta JSON inválida.", { cause: error });
    }
  }
  if (response.json) return response.json();
  return {};
}

/**
 * Registra un listener en transportes CLI que solo implementan `on`.
 *
 * @param child Proceso de la CLI.
 * @param event Evento que se debe observar.
 * @param listener Listener que se debe registrar.
 */
function registerCliListener(
  child: MatterCliProcess,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (child.once) {
    child.once(event, listener);
    return;
  }
  child.on?.(event, listener);
}

/**
 * Crea un adaptador del proceso nativo para la CLI de Matter.
 *
 * @param command Comando a ejecutar.
 * @param args Argumentos sin shell.
 * @param options Opciones de proceso.
 * @returns Proceso compatible con `MatterCliProcess`.
 */
function defaultMatterSpawner(command: string, args: string[], options: { detached: boolean }): MatterCliProcess {
  const child = spawnChildProcess(command, args, {
    detached: options.detached,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    once(event: string, listener: (...args: unknown[]) => void): MatterCliProcess {
      child.once(event, (...args: unknown[]) => listener(...args));
      return this;
    },
    on(event: string, listener: (...args: unknown[]) => void): MatterCliProcess {
      child.on(event, (...args: unknown[]) => listener(...args));
      return this;
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      return child.kill(signal);
    },
  };
}

/**
 * Envía una señal al grupo de procesos cuando es posible.
 *
 * @param child Proceso CLI.
 * @param signal Señal POSIX.
 */
function killProcessGroup(child: MatterCliProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch (error: unknown) {
    void toDomoticsError(error, "process");
  }
}
