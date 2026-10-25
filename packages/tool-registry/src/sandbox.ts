import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Aislamiento de ejecución de código.
 *
 * El límite de seguridad NO es el prompt ni el auto-análisis del modelo: es el
 * runtime. Este módulo aplica las restricciones y devuelve una ATESTACIÓN de
 * lo realmente impuesto, para que el agente pueda verificarlo en lugar de
 * suponerlo.
 *
 * Dos backends con capacidades declaradas y distintas:
 *   - `container`: docker run --network none --read-only --tmpfs /tmp, usuario
 *     no privilegiado, límites de memoria y de PIDs. Es el único que cumple
 *     el requisito "network: none" de la directiva EJ-01.
 *   - `process`: grupo de procesos aislado con entorno mínimo. NO aísla la
 *     red ni el sistema de archivos; se declara como tal y por eso las tools
 *     que lo usan son de riesgo `destructive` y requieren aprobación.
 */

export type SandboxIsolation = "container" | "process";

export interface SandboxLimits {
  /** Tope duro de reloj. Lo impone el runtime, nunca el modelo. */
  timeoutMs: number;
  /** Tope duro de memoria. */
  memoryLimitMb: number;
  /** Tope de procesos simultáneos (defensa real contra fork bomb). */
  pidsLimit: number;
  /** CPUs asignadas. */
  cpus: number;
  /** Tope de bytes capturados por canal. */
  maxOutputBytes: number;
}

export interface SandboxAttestation {
  isolation: SandboxIsolation;
  network: "none" | "host";
  filesystem: string;
  uid: string;
  pids_max: number;
  memory_max_mb: number;
  /** Texto de la plantilla de aislamiento realmente aplicada. */
  controls: string[];
}

export interface SandboxRequest {
  /** Imagen (container) o binario a ejecutar (process). */
  image?: string;
  binary: string;
  args: string[];
  /** Archivos a materializar en el workspace. */
  files: Record<string, string>;
  /** Contenido enviado por stdin. */
  stdin?: string;
  env: Record<string, string>;
  limits: SandboxLimits;
  cwd?: string;
  /** Modo de montaje del workspace: `ro` por defecto, `rw` durante la compilación. */
  volumeMode?: "ro" | "rw";
  /**
   * Volumen compartido entre fases (build -> run). Sin este campo, cada llamada
   * crea y destruye su propio volumen: el binario compilado no sobreviviría
   * a la fase de ejecución.
   */
  sharedVolume?: { name: string; populate: boolean };
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  executionTimeMs: number;
  timedOut: boolean;
  oomKilled: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  runId: string;
  attestation: SandboxAttestation;
}

export class SandboxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Variables de entorno permitidas dentro del sandbox. Nada de credenciales. */
const ENV_ALLOWLIST: Record<string, string> = {
  TZ: "UTC",
  LC_ALL: "C.UTF-8",
  LANG: "C.UTF-8",
  PYTHONHASHSEED: "0",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONUNBUFFERED: "1",
  HOME: "/tmp",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  NO_COLOR: "1",
};

export function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...ENV_ALLOWLIST };
  for (const [key, value] of Object.entries(extra)) {
    // Cualquier clave fuera del allowlist se ignora: el sandbox no hereda el
    // entorno del host, así que no hay filtrado de secretos que dependa de esto.
    if (key in ENV_ALLOWLIST) env[key] = value;
  }
  return env;
}

/** Materializa los archivos del workspace y devuelve la raíz temporal. */
export function materialiseWorkspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sandbox-"));
  for (const [relative, content] of Object.entries(files)) {
    const safe = normaliseRelativePath(relative);
    const target = join(root, safe);
    const parent = target.slice(0, target.lastIndexOf("/") + 1);
    if (parent) mkdirp(parent);
    writeFileSync(target, content, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function normaliseRelativePath(relative: string): string {
  if (relative.startsWith("/") || relative.includes("..")) {
    throw new SandboxError("invalid_path", `Ruta de archivo no permitida: ${relative}`);
  }
  return relative;
}

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Caché del sondeo de imágenes de sandbox.
 *
 * El sondeo real se hace con un proceso ASÍNCRONO: antes se hacía con
 * `spawnSync`, que congela el event loop del servidor durante toda la vida
 * del proceso `docker image inspect` (cientos de milisegundos, o indefinido
 * si el daemon está colgado). Como `availability()` es síncrono por
 * contrato, la función devuelve el último resultado conocido y programa el
 * sondeo real para el siguienteuso.
 */
const imageProbeCache = new Map<string, { available: boolean; checkedAt: number }>();
/** Vigencia del resultado cacheado de un sondeo. */
const IMAGE_PROBE_TTL_MS = 30_000;
/** Sondeos en vuelo, para no duplicar el proceso docker. */
const pendingImageProbes = new Map<string, Promise<boolean>>();

/**
 * Sondeo de imágenes de sandbox.
 *
 * Es una dependencia INYECTABLE: el sandbox depende del daemon de docker, y
 * una dependencia que no se puede sustituir es una dependencia que no se
 * puede probar (ni desplegar en un entorno sin docker).
 */
export type ContainerImageProbe = (image: string) => Promise<boolean>;

/**
 * Sondeo real: `docker image inspect` sin bloquear el event loop.
 *
 * Returns:
 *   `true` si el daemon responde con código 0 (la imagen existe localmente).
 */
const dockerImageProbe: ContainerImageProbe = (image) =>
  new Promise((resolve) => {
    const child = spawn("docker", ["image", "inspect", image], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

/** Sondeo vigente. */
let activeImageProbe: ContainerImageProbe = dockerImageProbe;

/**
 * Sustituye el sondeo de imágenes (pruebas, o despliegues sin docker).
 *
 * Args:
 *   probe: Sondeo a usar; `null` restaura el sondeo real con docker.
 */
export function setContainerImageProbe(probe: ContainerImageProbe | null): void {
  activeImageProbe = probe ?? dockerImageProbe;
  // El cache anterior corresponde al sondeo viejo: no vale.
  imageProbeCache.clear();
  pendingImageProbes.clear();
}

/** Programa (o reutiliza) el sondeo asíncrono de una imagen. */
function scheduleImageProbe(image: string): Promise<boolean> {
  const inFlight = pendingImageProbes.get(image);
  if (inFlight) return inFlight;
  const probe = activeImageProbe(image)
    .then((available) => {
      imageProbeCache.set(image, { available, checkedAt: Date.now() });
      return available;
    })
    .finally(() => pendingImageProbes.delete(image));
  pendingImageProbes.set(image, probe);
  return probe;
}

/**
 * Estado del sondeo de una imagen de sandbox.
 *
 * `unknown` distingue "no se ha comprobado todavía" de "comprobado y ausente":
 * sin esa distinción, el catálogo anunciaría tools que no se pueden ejecutar
 * (o escondería las que sí).
 */
export type ContainerImageStatus = "available" | "missing" | "unknown";

/**
 * Estado del sondeo de una imagen, sin bloquear el event loop.
 *
 * Nunca ejecuta un proceso de forma sincrónica: el sondeo real es asíncrono
 * y su resultado se cachea. Si todavía no hay resultado, el estado es
 * `unknown` y se programa el sondeo.
 *
 * Args:
 *   image: Nombre de la imagen (por ejemplo `jarvis-sandbox:latest`).
 *
 * Returns:
 *   El estado conocido de la imagen.
 */
export function containerImageStatus(image: string): ContainerImageStatus {
  const cached = imageProbeCache.get(image);
  if (!cached) {
    void scheduleImageProbe(image);
    return "unknown";
  }
  if (Date.now() - cached.checkedAt >= IMAGE_PROBE_TTL_MS) void scheduleImageProbe(image);
  return cached.available ? "available" : "missing";
}

/**
 * ¿Existe la imagen de contenedor localmente?
 *
 * Nunca bloquea: devuelve el último resultado conocido (fail-closed mientras
 * no se sabe nada) y programa el sondeo real. La ejecución comprueba la
 * imagen de forma asíncrona y autoritativa con
 * `assertContainerImageAvailable` antes de correr nada.
 *
 * Args:
 *   image: Nombre de la imagen.
 *
 * Returns:
 *   `true` solo si la imagen está disponible y comprobada.
 */
export function containerImageAvailable(image: string): boolean {
  return containerImageStatus(image) === "available";
}

/**
 * Precalienta el sondeo de las imágenes de sandbox.
 *
 * Se llama al arrancar el servidor: así, desde el PRIMER turno, el catálogo
 * que se ofrece al modelo refleja la realidad (sin esperas ni anuncios de
 * tools que luego fallan).
 *
 * Args:
 *   images: Nombres de imagen a comprobar.
 */
export async function warmupContainerImages(images: readonly string[]): Promise<void> {
  await Promise.all(images.map((image) => scheduleImageProbe(image)));
}

/**
 * Comprobación autoritativa y asíncrona de la imagen, previa a ejecutar.
 *
 * Args:
 *   image: Nombre de la imagen.
 *
 * Raises:
 *   SandboxError: Con código `image_missing` si la imagen no está disponible.
 */
export async function assertContainerImageAvailable(image: string): Promise<void> {
  const available = await scheduleImageProbe(image);
  if (!available) {
    throw new SandboxError("image_missing", `La imagen de sandbox no está disponible localmente: ${image}`);
  }
}

/**
 * Ejecuta en un contenedor docker efímero.
 * Red: namespace sin salida. FS: solo lectura salvo /tmp (tmpfs acotado).
 * Usuario: no privilegiado. Límites: memoria, PIDs y CPU.
 */
async function runInContainer(request: SandboxRequest): Promise<SandboxResult> {
  const image = request.image;
  if (!image) throw new SandboxError("no_image", "El backend de contenedor exige una imagen.");
  // Comprobación autoritativa y NO bloqueante: si la imagen no está, se dice
  // antes de tocar nada.
  await assertContainerImageAvailable(image);

  const { root, cleanup } = materialiseWorkspace(request.files);
  const runId = `sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const volume = request.sharedVolume?.name ?? `jarvis-${runId}`;
  const ownsVolume = !request.sharedVolume;

  // El workspace viaja en un VOLUMEN NOMBRADO poblado por un contenedor
  // auxiliar: ni bind mounts (que en macOS/Colima no comparten /var/folders)
  // ni `docker cp` (rechazado cuando el rootfs es de solo lectura).
  try {
    const volumeCreated = await runDockerCommand(["volume", "create", volume]);
    if (volumeCreated.exitCode !== 0) {
      throw new SandboxError("volume_failed", `No se pudo crear el volumen del sandbox: ${volumeCreated.stderr.trim()}`);
    }
    if (request.sharedVolume?.populate ?? true) {
      await populateVolume(volume, root, image);
    }

    const containerName = `jarvis-${runId}`;
    const createArgs = [
      "create",
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      `/tmp:rw,size=${request.limits.memoryLimitMb}m,exec,nosuid,nodev`,
      "--user",
      "65534:65534",
      "--memory",
      `${request.limits.memoryLimitMb}m`,
      "--memory-swap",
      `${request.limits.memoryLimitMb}m`,
      "--pids-limit",
      String(request.limits.pidsLimit),
      "--cpus",
      String(request.limits.cpus),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--workdir",
      "/w",
      "--volume",
      `${volume}:/w:${request.volumeMode ?? "ro"}`,
    ];
    for (const [key, value] of Object.entries(request.env)) {
      createArgs.push("--env", `${key}=${value}`);
    }
    createArgs.push(image, request.binary, ...request.args);

    const created = await runDockerCommand(createArgs);
    if (created.exitCode !== 0) {
      throw new SandboxError("create_failed", `No se pudo crear el contenedor: ${created.stderr.trim() || created.stdout.trim()}`);
    }

    const outcome = await spawnAndCapture(
      request,
      ["docker", "start", "--attach", containerName],
      () => {
        // Al vencer el tiempo se mata el CONTENEDOR, no solo el cliente de docker.
        spawnDetached("docker", ["rm", "-f", containerName]);
      },
      undefined,
      // El CLI de docker corre en el host: necesita HOME (contexto de docker),
      // DOCKER_HOST y PATH. El entorno del sandbox viaja dentro, vía --env.
      { ...process.env },
    );

    // `docker inspect` da el veredicto autoritativo del OOM killer y el código
    // de salida real del contenedor (no el del CLI).
    const state = await inspectContainerState(containerName);

    return {
      ...outcome,
      // Un proceso terminado por timeout NO tiene código de salida: se reporta
      // -1 para que el agente no lo lea como "terminó bien".
      exitCode: outcome.timedOut ? -1 : (state.exitCode ?? outcome.exitCode),
      oomKilled: state.oomKilled || (outcome.exitCode === 137 && !outcome.timedOut),
      runId: `sandbox:${runId}`,
      attestation: {
        isolation: "container",
        network: "none",
        filesystem: "read-only:/ writable:/tmp",
        uid: "65534:65534",
        pids_max: request.limits.pidsLimit,
        memory_max_mb: request.limits.memoryLimitMb,
        controls: [
          "network=none",
          "read-only filesystem",
          "tmpfs /tmp acotado",
          "usuario no privilegiado (65534)",
          "memory + memory-swap",
          "pids-limit",
          "cap-drop ALL",
          "no-new-privileges",
        ],
      },
    };
  } finally {
    // El contenedor se elimina de forma SINCRONA: si siguiera vivo, el
    // `docker volume rm` fallaría por "volume in use" y dejaría recursos
    // huérfanos en el host.
    await runDockerCommand(["rm", "-f", `jarvis-${runId}`]);
    // El volumen lo destruye su propietario cuando lo comparten varias fases.
    if (ownsVolume) await runDockerCommand(["volume", "rm", "-f", volume]);
    cleanup();
  }
}

/**
 * Elimina un volumen de sandbox compartido. Reintenta: el volumen puede
 * seguir "in use" un instante después de eliminar su contenedor.
 */
export async function removeSandboxVolume(name: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await runDockerCommand(["volume", "rm", "-f", name]);
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Nombre de volumen único para un ciclo de vida de tool. */
export function newSandboxVolumeName(): string {
  return `jarvis-sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Estado real del contenedor: lo que el OOM killer decidió. */
async function inspectContainerState(name: string): Promise<{ oomKilled: boolean; exitCode: number | null }> {
  const result = await runDockerCommand([
    "inspect",
    "--format",
    "{{.State.OOMKilled}} {{.State.ExitCode}}",
    name,
  ]);
  if (result.exitCode !== 0) return { oomKilled: false, exitCode: null };
  const [oom, exit] = result.stdout.trim().split(/\s+/);
  return { oomKilled: oom === "true", exitCode: exit === undefined ? null : Number(exit) };
}

/**
 * Puebla un volumen nombrado con el workspace, usando un contenedor auxiliar
 * que extrae un tar por stdin. Evita tanto el bind mount como `docker cp`.
 *
 * El tar se genera con un proceso ASÍNCRONO y se canaliza por tubería: antes
 * se usaba `spawnSync` con un búfer de 64 MB, es decir, el event loop
 * expectante durante toda la compresión del workspace.
 */
async function populateVolume(volume: string, root: string, image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tar = spawn("tar", ["-cf", "-", "-C", root, "."], { stdio: ["ignore", "pipe", "pipe"] });
    const child = spawn(
      "docker",
      [
        "run", "--rm", "-i", "--network", "none", "--user", "0", "--volume", `${volume}:/w`, image,
        // El tar conserva los permisos del host (0700 en el temporal): se relajan
        // para que el usuario no privilegiado del sandbox pueda leer el código.
        "sh", "-c", "tar -xf - -C /w && chmod -R a+rwX /w",
      ],
      { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env } },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // Si el contenedor muere, la tubería se cierra con EPIPE: no es un fallo
    // del tar, y no debe tumbar el proceso.
    child.stdin.on("error", () => undefined);
    tar.stdout.on("error", () => undefined);
    tar.stdout.pipe(child.stdin);
    tar.on("error", (error) => reject(new SandboxError("populate_failed", error.message)));
    child.on("error", (error) => reject(new SandboxError("populate_failed", error.message)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new SandboxError("populate_failed", `No se pudo poblar el volumen del sandbox: ${stderr.trim()}`));
    });
  });
}

/** Ejecuta un comando del CLI de docker y captura su salida. */
async function runDockerCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * Ejecuta en el host dentro de un grupo de procesos propio, con entorno
 * mínimo y directorio de trabajo temporal. NO aísla red ni FS.
 */
async function runInProcess(request: SandboxRequest): Promise<SandboxResult> {
  const { root, cleanup } = materialiseWorkspace(request.files);
  const started = Date.now();
  try {
    const outcome = await spawnAndCapture(request, [request.binary, ...request.args], undefined, root);
    return {
      ...outcome,
      runId: `proc:${outcome.runId}`,
      attestation: {
        isolation: "process",
        network: "host",
        filesystem: `writable:${root} (temporal, se borra al terminar)`,
        uid: String(process.getuid?.() ?? "unknown"),
        pids_max: 0,
        memory_max_mb: 0,
        controls: [
          "grupo de procesos propio (SIGTERM -> SIGKILL)",
          "entorno mínimo (allowlist)",
          "cwd temporal efímero",
          "tope de bytes de salida",
        ],
      },
    };
  } finally {
    cleanup();
  }
}

function spawnDetached(binary: string, args: string[]): void {
  const child = spawn(binary, args, { stdio: "ignore", detached: true });
  // Sin este manejador, un 'error' de spawn (binario ausente) se convierte
  // en una excepción no capturada: tumba el proceso entero.
  child.on("error", () => undefined);
  child.unref();
}

interface CaptureOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  executionTimeMs: number;
  timedOut: boolean;
  oomKilled: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  runId: string;
}

/**
 * Captura la salida con tope de bytes y termina el PROCESO COMPLETO al
 * vencer el tiempo (grupo de procesos, no solo el hijo directo).
 */
function spawnAndCapture(
  request: SandboxRequest,
  argv: string[],
  onTimeout?: () => void,
  cwd?: string,
  env: NodeJS.ProcessEnv = request.env,
): Promise<CaptureOutcome> {
  const limits = request.limits;
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // detached: el hijo pasa a ser líder de su propio grupo de procesos.
      detached: true,
    });

    const finish = (exitCode: number, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: signal ?? null,
        executionTimeMs: Date.now() - started,
        timedOut,
        oomKilled: signal === "SIGKILL" && !timedOut,
        truncated,
        stdoutBytes,
        stderrBytes,
        runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 600);
    }, limits.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= limits.maxOutputBytes) {
        stdout += chunk.toString("utf8");
      } else {
        if (!truncated) {
          truncated = true;
          stdout += "\n[salida truncada por el límite de bytes]\n";
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= limits.maxOutputBytes) {
        stderr += chunk.toString("utf8");
      } else {
        if (!truncated) {
          truncated = true;
          stderr += "\n[stderr truncado por el límite de bytes]\n";
        }
      }
    });

    child.on("error", (error) => {
      stderr += `\n[error del runtime: ${error.message}]`;
      finish(-1, null);
    });

    child.on("close", (code, signal) => finish(code ?? -1, signal));

    if (request.stdin !== undefined) {
      child.stdin?.end(request.stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // Señal al grupo negativo: alcanza a los hijos huérfanos.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* el proceso ya terminó */
    }
  }
}

export interface SandboxOptions {
  /** Fuerza el backend. Si no se indica, se elige el que esté disponible. */
  backend?: "container" | "process";
  /** Imagen por lenguaje. */
  images?: Record<string, string>;
}

/** Ejecuta en el sandbox devolviendo siempre una atestación verificable. */
export async function runInSandbox(request: SandboxRequest, options: SandboxOptions = {}): Promise<SandboxResult> {
  const backend = options.backend ?? (request.image ? "container" : "process");
  if (backend === "container") return runInContainer(request);
  return runInProcess(request);
}
