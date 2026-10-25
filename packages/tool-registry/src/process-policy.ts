import { spawn } from "node:child_process";

/**
 * Política de ejecución de procesos hijos.
 *
 * Las tools que lanzan binarios externos (`skills`, `computer.use`, el sandbox)
 * heredaban `process.env` completo: el proceso hijo recibía la clave del
 * proveedor de IA, la contraseña de la base de datos y cualquier otra
 * credencial del proceso servidor. Además no tenían presupuesto de tiempo ni
 * tope de salida, de modo que un hijo colgado o parlanchín se comía la
 * memoria y el tiempo del turno.
 *
 * Aquí el entorno del hijo es un allowlist mínimo, el proceso es líder de su
 * propio grupo (para poder matar a los nietos), hay presupuesto de tiempo
 * real y la salida está acotada en bytes.
 */

/** Entorno mínimo heredado por los procesos hijos. */
export const SANITIZED_CHILD_ENV: Record<string, string> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/tmp",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
  CI: "1",
};

/**
 * Claves que no pueden ser redefinidas por quien invoca la tool: aunque el
 * modelo pase `PATH` o `HOME` en sus variables, el hijo no las ve alteradas.
 */
export const PROTECTED_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const;

export interface SanitizedProcessOptions {
  /** Directorio de trabajo del hijo. */
  cwd?: string;
  /** Presupuesto de tiempo en milisegundos. */
  timeoutMs: number;
  /** Tope de bytes por flujo de salida. */
  maxOutputBytes?: number;
  /** Señal de cancelación del turno. */
  signal?: AbortSignal;
  /** Variables adicionales permitidas de forma explícita. */
  extraEnv?: Record<string, string | undefined>;
}

export interface SanitizedProcessOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Construye el entorno del hijo: allowlist mínimo + variables explícitas. */
export function buildChildEnv(extraEnv?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { ...SANITIZED_CHILD_ENV };
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) continue;
    if ((PROTECTED_ENV_KEYS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Ejecuta un proceso hijo con entorno saneado, presupuesto de tiempo y tope
 * de salida. Nunca lanza: los fallos se devuelven en el resultado.
 */
export function runSanitizedProcess(
  command: string,
  args: string[],
  options: SanitizedProcessOptions,
): Promise<SanitizedProcessOutcome> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildChildEnv(options.extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: true,
    });

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 800).unref();
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        aborted,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout += chunk.toString("utf8");
      else if (!truncated) {
        truncated = true;
        stdout += "\n[salida truncada por el límite de bytes]\n";
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr += chunk.toString("utf8");
      else if (!truncated) {
        truncated = true;
        stderr += "\n[stderr truncado por el límite de bytes]\n";
      }
    });
    child.on("error", (error) => {
      stderr += `\n[error al iniciar el proceso: ${error.message}]`;
      finish(-1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
