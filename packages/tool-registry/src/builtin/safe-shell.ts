import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@jarvis/shared";
import { effectiveToolConfig, type ToolConfig } from "../types.js";
import { evaluateShellCommand } from "./shell-policy.js";

/**
 * Ejecución de comandos de consola con lista blanca.
 *
 * La versión anterior heredaba `process.env` completo en el hijo: eso
 * filteringaba al proceso las credenciales del servidor (NVIDIA_API_KEY, tokens
 * de base de datos). Aquí el entorno del hijo es un allowlist mínimo, el
 * directorio de trabajo está confinado al workspace y, al vencer el tiempo,
 * se mata el GRUPO DE PROCESOS (no solo el hijo directo).
 *
 * El comando se ejecuta SIN shell: no hay interpretación de metacaracteres.
 */

const InputSchema = z.object({
  command: z.array(z.string().min(1).max(2048)).min(1).max(64),
  working_directory: z.string().min(1).max(1024).optional(),
  timeout_seconds: z.number().int().min(1).max(120).default(30),
});

const MAX_OUTPUT_BYTES = 256 * 1024;

/** Entorno mínimo del hijo: nada de credenciales del servidor. */
const CHILD_ENV: Record<string, string> = {
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

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

export function createSafeShellTool(rawConfig: ToolConfig): ToolDefinition<z.infer<typeof InputSchema>> {
  const config = effectiveToolConfig(rawConfig);
  const root = resolve(config.workspaceRoot);
  const allowlist = new Set(config.shellAllowlist);

  return {
    name: "shell.execute",
    title: "Terminal Segura",
    description: `Ejecuta un comando de la lista blanca (${[...allowlist].join(", ")}) dentro del workspace, sin shell y sin heredar credenciales. Las rutas de los argumentos deben permanecer dentro del workspace y no se admite código en línea. Al vencer el tiempo se mata el grupo de procesos completo.`,
    risk: "external_effect",
    requiresApproval: true,
    timeoutMs: 130_000,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          description: "Comando y argumentos, por ejemplo [\"ls\", \"-la\"].",
        },
        working_directory: { type: "string", description: "Directorio de trabajo (relativo al workspace)." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120, default: 30, description: "Límite de tiempo solicitado." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parse: (raw) => InputSchema.parse(raw),
    availability: () => ({ available: allowlist.size > 0 }),
    execute: async (input) => {
      const [binary, ...args] = input.command;
      if (!binary) {
        return { ok: false, summary: "Comando vacío.", unavailable: false, error: "empty_command" };
      }
      if (!allowlist.has(binary)) {
        return {
          ok: false,
          summary: `El binario «${binary}» no está en la lista blanca.`,
          unavailable: false,
          error: "command_not_allowed",
          data: { allowed: [...allowlist] },
        };
      }

      const cwd = resolve(root, input.working_directory ?? ".");
      if (!isInside(root, cwd)) {
        return { ok: false, summary: "El directorio de trabajo sale del workspace.", unavailable: false, error: "path_outside_workspace" };
      }
      await mkdir(cwd, { recursive: true });

      const policy = evaluateShellCommand(input.command, root);
      if (!policy.allowed) {
        return {
          ok: false,
          summary: policy.reason ?? "El comando no cumple la política de ejecución.",
          unavailable: false,
          error: policy.code ?? "command_policy_rejected",
        };
      }

      return new Promise((resolvePromise) => {
        const started = Date.now();
        let stdout = "";
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;

        const child = spawn(binary, args, {
          cwd,
          env: { ...CHILD_ENV, JARVIS_WORKSPACE: root },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          // El hijo es líder de su propio grupo: al vencer el tiempo se mata
          // el grupo completo, incluidos los nietos que haya creado.
          detached: true,
        });

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise({
            ok: exitCode === 0 && !timedOut,
            summary: timedOut
              ? `El comando excedió el tiempo (${Date.now() - started} ms) y su grupo de procesos fue terminado.`
              : `Comando terminado con código ${exitCode}.`,
            unavailable: false,
            data: {
              command: input.command,
              exit_code: exitCode ?? -1,
              signal: signal ?? null,
              timed_out: timedOut,
              truncated,
              stdout_bytes: stdoutBytes,
              stderr_bytes: stderrBytes,
              stdout,
              stderr,
              execution_time_ms: Date.now() - started,
            },
          });
        };

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-(child.pid as number), "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
          setTimeout(() => {
            try {
              process.kill(-(child.pid as number), "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, 800);
        }, input.timeout_seconds * 1000);

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
          else if (!truncated) {
            truncated = true;
            stdout += "\n[salida truncada por el límite de bytes]\n";
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
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
    },
  };
}
