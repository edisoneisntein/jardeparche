import { spawn as spawnChildProcess } from "node:child_process";
import { DomoticsError, toDomoticsError } from "./errors.js";
import type {
  CameraConfig,
  CameraCollection,
  CameraDefinition,
  CameraProcess,
  CameraSnapshot,
  CameraSpawner,
  CameraVisionAnalysis,
  CameraVisionCallback,
} from "./types.js";

/** Instantánea con el análisis opcional de visión. */
export interface CameraSnapshotResult extends CameraSnapshot {
  /** Análisis producido por el callback de visión, si se solicitó. */
  analysis?: CameraVisionAnalysis;
}

/** Política aplicada a las URLs de una cámara. */
export interface CameraUrlPolicy {
  /** Permite `rtsp://` y `rtsps://` además de HTTP(S). */
  allowRtsp?: boolean;
  /** Permite destinos privados; debe permanecer desactivado en producción. */
  allowPrivateHosts?: boolean;
}

/** Argumentos literales permitidos en la invocación de ffmpeg. */
export const FFMPEG_ARGUMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-rtsp_transport",
  "tcp",
  "-i",
  "-frames:v",
  "1",
  "-f",
  "image2pipe",
  "-vcodec",
  "mjpeg",
  "pipe:1",
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Servicio de captura de cámaras perimetrales mediante ffmpeg.
 *
 * El servicio no abre una shell: ffmpeg se invoca con una lista fija de
 * argumentos y la URL se valida antes de entregarla al proceso. Los procesos
 * se crean en su propio grupo para que un timeout pueda terminar también a
 * los hijos que ffmpeg pueda haber creado.
 */
export class CameraService {
  private readonly cameras = new Map<string, CameraDefinition>();
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly allowRtsp: boolean;
  private readonly allowPrivateHosts: boolean;
  private readonly vision?: CameraVisionCallback;
  private readonly spawner: CameraSpawner;
  private readonly snapshotListeners = new Set<(snapshot: CameraSnapshot) => void>();

  /**
   * Crea el servicio de cámaras.
   *
   * @param config Definiciones y límites de captura.
   * @param vision Callback de visión alternativo al incluido en la configuración.
   */
  constructor(config: CameraConfig | CameraCollection = { cameras: [] }, vision?: CameraVisionCallback) {
    const normalized = normalizeCameraConfig(config);
    for (const camera of normalized.cameras) this.cameras.set(camera.id, camera);
    this.ffmpegPath = normalized.ffmpegPath ?? "ffmpeg";
    this.timeoutMs = Math.max(1, normalized.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxBytes = Math.max(1, normalized.maxBytes ?? DEFAULT_MAX_BYTES);
    this.allowRtsp = normalized.allowRtsp ?? false;
    this.allowPrivateHosts = false;
    this.vision = vision ?? normalized.vision;
    this.spawner = normalized.spawner ?? defaultCameraSpawner;
  }

  /**
   * Lista las cámaras configuradas.
   *
   * @returns Copia de las definiciones de cámara.
   */
  list(): CameraDefinition[] {
    return [...this.cameras.values()];
  }

  /**
   * Obtiene una cámara por identificador.
   *
   * @param cameraId Identificador de la cámara.
   * @returns Definición o `undefined`.
   */
  get(cameraId: string): CameraDefinition | undefined {
    return this.cameras.get(cameraId);
  }

  /**
   * Registra un listener de instantáneas capturadas.
   *
   * @param listener Función que recibirá la instantánea.
   * @returns Función para retirar el listener.
   */
  onSnapshot(listener: (snapshot: CameraSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  /**
   * Captura una imagen de una cámara.
   *
   * @param cameraId Identificador de la cámara.
   * @param options Signal de cancelación y control del análisis de visión.
   * @returns Instantánea con dimensiones reales y análisis opcional.
   */
  async snapshot(cameraId: string, options: { signal?: AbortSignal; analyze?: boolean } = {}): Promise<CameraSnapshotResult> {
    const camera = this.cameras.get(cameraId);
    if (!camera) {
      throw new DomoticsError("not_found", `No existe la cámara ${cameraId}.`);
    }
    const source = camera.rtspUrl ?? camera.url;
    const rtspAllowed = this.allowRtsp || Boolean(camera.rtspUrl);
    const url = validateCameraUrl(source, {
      allowRtsp: rtspAllowed,
      allowPrivateHosts: this.allowPrivateHosts,
    });
    if (camera.username && !url.username) url.username = camera.username;
    if (camera.password && !url.password) url.password = camera.password;
    const args = buildFfmpegArguments(url.toString(), url.protocol === "rtsp:" || url.protocol === "rtsps:");
    assertFfmpegArguments(args);
    const image = await this.runFfmpeg(args, options.signal);
    if (image.length === 0) {
      throw new DomoticsError("process", "ffmpeg no devolvió ninguna imagen.");
    }
    const dimensions = readImageDimensions(image);
    const snapshot: CameraSnapshot = {
      imageBase64: image.toString("base64"),
      width: dimensions.width,
      height: dimensions.height,
      timestamp: new Date().toISOString(),
      cameraId,
    };
    for (const listener of this.snapshotListeners) {
      try {
        listener(snapshot);
      } catch (error: unknown) {
        void toDomoticsError(error, "unknown");
      }
    }

    const result: CameraSnapshotResult = { ...snapshot };
    if (this.vision && options.analyze !== false) {
      try {
        result.analysis = await this.vision(snapshot, options.signal);
      } catch (error: unknown) {
        throw toDomoticsError(error, "vision");
      }
    }
    return result;
  }

  /**
   * Captura una imagen y ejecuta el análisis de visión por separado.
   *
   * @param cameraId Identificador de la cámara.
   * @param signal Señal opcional de cancelación.
   * @returns Instantánea con análisis.
   */
  async snapshotWithAnalysis(cameraId: string, signal?: AbortSignal): Promise<CameraSnapshotResult> {
    return this.snapshot(cameraId, { signal, analyze: true });
  }

  /**
   * Ejecuta ffmpeg y devuelve los bytes de la imagen.
   *
   * @param args Argumentos ya validados.
   * @param signal Señal opcional de cancelación.
   * @returns Bytes de la imagen.
   */
  private async runFfmpeg(args: string[], signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) {
      throw new DomoticsError("aborted", "La captura de la cámara fue cancelada.");
    }
    let child: CameraProcess;
    try {
      child = this.spawner(this.ffmpegPath, args, { detached: true, shell: false });
    } catch (error: unknown) {
      throw toDomoticsError(error, "process");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    return new Promise<Buffer>((resolve, reject) => {
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      };
      const succeed = (value: Buffer): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > this.maxBytes) {
          killCameraProcessGroup(child, "SIGKILL");
          fail(new DomoticsError("process", "La imagen de la cámara supera el límite de bytes permitido."));
          return;
        }
        chunks.push(buffer);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (totalBytes > this.maxBytes) return;
        void chunk;
      });
      registerProcessListener(child, "error", (value: unknown) => {
        fail(toDomoticsError(value, "process"));
      });
      registerProcessListener(child, "close", (value: unknown) => {
        const code = typeof value === "number" ? value : null;
        if (code !== 0) {
          fail(new DomoticsError("process", `ffmpeg terminó con código ${code ?? "desconocido"}.`));
          return;
        }
        succeed(Buffer.concat(chunks));
      });

      timeout = setTimeout(() => {
        killCameraProcessGroup(child, "SIGKILL");
        fail(new DomoticsError("timeout", "La captura de la cámara excedió el tiempo previsto."));
      }, this.timeoutMs);
      if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
      abortHandler = () => {
        killCameraProcessGroup(child, "SIGKILL");
        fail(new DomoticsError("aborted", "La captura de la cámara fue cancelada."));
      };
      if (signal) signal.addEventListener("abort", abortHandler, { once: true });
    });
  }
}

/** Alias de `CameraService` para consumidores que lo llaman manager. */
export type CameraManager = CameraService;
export const CameraManager = CameraService;

/**
 * Valida una URL de cámara y bloquea destinos internos conocidos.
 *
 * La política por defecto solo admite HTTP y HTTPS. Los servicios de
 * cámaras pueden habilitar RTSP de forma explícita; los hosts loopback,
 * privados, link-local y los nombres locales habituales se rechazan siempre
 * salvo que se indique lo contrario.
 *
 * @param candidate URL candidata.
 * @param policy Política de protocolos y destinos privados.
 * @returns URL normalizada.
 */
export function validateCameraUrl(candidate: string, policy: CameraUrlPolicy = {}): URL {
  if (/[\u0000\r\n]/.test(candidate)) {
    throw new DomoticsError("security", "La URL de la cámara contiene caracteres de control no permitidos.");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error: unknown) {
    throw new DomoticsError("configuration", "La URL de la cámara no es válida.", { cause: error });
  }
  const allowRtsp = policy.allowRtsp ?? false;
  const allowed = allowRtsp ? ["http:", "https:", "rtsp:", "rtsps:"] : ["http:", "https:"];
  if (!allowed.includes(parsed.protocol)) {
    throw new DomoticsError("security", "La URL de la cámara debe usar HTTP(S) o RTSP explícitamente permitido.");
  }
  if (!policy.allowPrivateHosts && isInternalCameraHost(parsed.hostname)) {
    throw new DomoticsError("security", "La URL de la cámara apunta a un destino interno.");
  }
  return parsed;
}

/**
 * Indica si un host es un destino interno conocido.
 *
 * @param hostname Host de la URL, sin esquema.
 * @returns `true` si el host debe bloquearse.
 */
export function isInternalCameraHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (host === "metadata.google.internal") return true;
  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * Comprueba si un argumento literal está permitido en ffmpeg.
 *
 * @param argument Argumento sin incluir la URL de origen.
 * @returns `true` si forma parte de la allowlist.
 */
export function isAllowedFfmpegArgument(argument: string): boolean {
  return FFMPEG_ARGUMENT_ALLOWLIST.has(argument);
}

/**
 * Construye la lista de argumentos de ffmpeg.
 *
 * @param source URL de la cámara ya validada.
 * @param rtsp Indica si se usa un transporte RTSP.
 * @returns Argumentos de ffmpeg.
 */
export function buildFfmpegArguments(source: string, rtsp = false): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (rtsp) args.push("-rtsp_transport", "tcp");
  args.push("-i", source, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1");
  return args;
}

/**
 * Valida que una lista de argumentos solo contiene la allowlist.
 *
 * La URL es el único valor dinámico permitido y solo puede ocupar la posición
 * inmediatamente posterior a `-i`.
 *
 * @param args Argumentos que se enviarán a ffmpeg.
 */
export function assertFfmpegArguments(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "-i") {
      const source = args[index + 1];
      if (!source) throw new DomoticsError("security", "Falta la URL de origen de ffmpeg.");
      index += 1;
      continue;
    }
    if (!isAllowedFfmpegArgument(argument)) {
      throw new DomoticsError("security", `Argumento de ffmpeg no permitido: ${argument}.`);
    }
  }
}

/**
 * Lee las dimensiones de una imagen PNG o JPEG.
 *
 * @param data Bytes de la imagen.
 * @returns Dimensiones reales o cero si no se reconocen.
 */
export function readImageDimensions(data: Buffer): { width: number; height: number } {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      const marker = data[offset + 1] ?? 0;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const size = data.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > data.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  return { width: 0, height: 0 };
}

/**
 * Normaliza la configuración en una lista de definiciones.
 *
 * @param config Configuración o lista directa.
 * @returns Configuración normalizada.
 */
function normalizeCameraConfig(config: CameraConfig | CameraCollection): CameraConfig & { cameras: CameraDefinition[] } {
  if (Array.isArray(config)) return { cameras: config };
  if ("cameras" in config) {
    if (Array.isArray(config.cameras)) return { ...config, cameras: config.cameras };
    const cameras: CameraDefinition[] = [];
    for (const [id, value] of Object.entries(config.cameras)) {
      if (typeof value === "string") {
        cameras.push({ id, url: value });
      } else {
        cameras.push(value);
      }
    }
    return { ...config, cameras };
  }
  const cameras: CameraDefinition[] = [];
  for (const [id, value] of Object.entries(config)) {
    if (typeof value === "string") {
      cameras.push({ id, url: value });
    } else {
      cameras.push(value);
    }
  }
  return { cameras };
}

/**
 * Registra un listener en transportes que solo implementan `on`.
 *
 * @param child Proceso de ffmpeg.
 * @param event Evento que se debe observar.
 * @param listener Listener que se debe registrar.
 */
function registerProcessListener(
  child: CameraProcess,
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
 * Crea un adaptador del proceso nativo de ffmpeg.
 *
 * @param command Ruta del ejecutable.
 * @param args Argumentos sin shell.
 * @param options Opciones de proceso.
 * @returns Proceso compatible con `CameraProcess`.
 */
function defaultCameraSpawner(command: string, args: string[], options: { detached: boolean }): CameraProcess {
  const child = spawnChildProcess(command, args, {
    detached: options.detached,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    get pid(): number | undefined {
      return child.pid;
    },
    once(event: string, listener: (...args: unknown[]) => void): CameraProcess {
      child.once(event, (...args: unknown[]) => listener(...args));
      return this;
    },
    on(event: string, listener: (...args: unknown[]) => void): CameraProcess {
      child.on(event, (...args: unknown[]) => listener(...args));
      return this;
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      return child.kill(signal);
    },
  };
}

/**
 * Envía una señal al grupo del proceso y al proceso como fallback.
 *
 * @param child Proceso de ffmpeg.
 * @param signal Señal POSIX.
 */
function killCameraProcessGroup(child: CameraProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      void toDomoticsError(error, "process");
    }
  }
  try {
    child.kill(signal);
  } catch (error: unknown) {
    void toDomoticsError(error, "process");
  }
}

/**
 * Convierte un host IPv4 en sus cuatro octetos.
 *
 * @param host Host candidato.
 * @returns Octetos o `undefined` si no es IPv4.
 */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined;
  return [first, second, third, fourth];
}

/**
 * Indica si una dirección IPv4 pertenece a un rango no público.
 *
 * @param octetos Octetos de la dirección.
 * @returns `true` si es privada o reservada.
 */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    first >= 224
  );
}

/**
 * Indica si una dirección IPv6 pertenece a un rango no público.
 *
 * @param host Host IPv6 sin corchetes.
 * @returns `true` si es privada, reservada o local.
 */
function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    const ipv4 = parseIpv4(mapped);
    return ipv4 ? isPrivateIpv4(ipv4) : true;
  }
  return false;
}
