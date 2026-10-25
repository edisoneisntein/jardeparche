import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Política de argumentos para `shell.execute`.
 *
 * La lista blanca de binarios por sí sola NO acota nada: con `cat`, `grep`,
 * `find`, `git`, `node`, `npm`, `pnpm` o `python3` permitidos, el agente
 * puede leer `/etc/passwd`,listar `~/.ssh` o ejecutar código arbitrario con
 * `python3 -c "…"`. La allowlist dice QUÉ programa se ejecuta, no QUÉ puede
 * tocar.
 *
 * Esta política añade el QUÉ, en cuatro reglas explícitas:
 *
 *  1. **Confinamiento de rutas**: todo argumento que sea una ruta (absoluta,
 *     con `~`, o que contenga un separador) debe resolverse dentro del
 *     workspace. Los argumentos sin separador son relativos al directorio de
 *     trabajo, que ya está confinado.
 *  2. **Sin código en línea**: los intérpretes no aceptan `-c`/`-e`/`--eval`;
 *     sólo pueden ejecutar un FICHERO del workspace.
 *  3. **Sin ejecución delegada**: `find -exec` y los lanzadores de paquetes
 *     que descargan y ejecutan (`npm exec`, `pnpm dlx`, `npx`) se rechazan.
 *  4. **Sin inyección de configuración en git**: `-c`, `--exec-path`,
 *     `--upload-pack` y `--receive-pack` permiten ejecutar comandos
 *     arbitrarios.
 *
 * La tool sigue exigiendo aprobación humana (`requiresApproval: true`): la
 * política reduce el radio de impacto, no sustituye el control humano.
 */

export interface ShellPolicyDecision {
  allowed: boolean;
  code?: string;
  reason?: string;
}

/** Intérpretes: pueden ejecutar código arbitrario en línea. */
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "ksh",
]);

/** Banderas que ejecutan código escrito en el propio argumento. */
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "--eval", "--command", "-Command", "--exec"]);

/** `find` puede delegar la ejecución en cualquier binario. */
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Lanzadores de paquetes capable de descargar y ejecutar código arbitrario. */
const PACKAGE_RUNNERS = new Set(["npm", "npx", "pnpm", "yarn", "bunx", "pipx"]);

/** Subcomandos de lanzadores que descargan y ejecutan. */
const PACKAGE_RUNNER_BANNED = new Set(["exec", "exec-script", "dlx", "create"]);

/** Banderas de git que permiten ejecutar otro programa. */
const GIT_BANNED_FLAGS = new Set([
  "-c",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--config-env",
]);

/** ¿La ruta resuelta sigue dentro de la raíz? */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/**
 * Comprueba un argumento que puede ser una ruta.
 *
 * Sólo se examinan los argumentos que tienen forma de ruta: los que empiezan
 * por `/`, por `~`, por `$` (expansión) o que contienen un separador. El
 * resto son patrones o flags y no tocan el sistema de archivos.
 */
function checkPathArgument(root: string, argument: string): ShellPolicyDecision | undefined {
  const value = argument.includes("=") && argument.startsWith("--") ? argument.slice(argument.indexOf("=") + 1) : argument;
  if (!value) return undefined;

  if (value.startsWith("$") || value.startsWith("`")) {
    return {
      allowed: false,
      code: "argument_expansion_rejected",
      reason: `no se admiten expansiones de variables en los argumentos: ${argument}`,
    };
  }

  const looksLikePath = value.startsWith("/") || value.startsWith("~") || value.includes("/");
  if (!looksLikePath) return undefined;

  const expanded = value.startsWith("~") ? value.replace(/^~/, homedir()) : value;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  if (!isInside(root, target)) {
    return {
      allowed: false,
      code: "path_outside_workspace",
      reason: `la ruta sale del workspace: ${argument}`,
    };
  }
  return undefined;
}

/**
 * Evalúa un comando completo contra la política.
 *
 * @param command Binario y argumentos, tal y como los ejecuta la tool.
 * @param root Workspace raíz (el directorio de trabajo está confinado a él).
 */
export function evaluateShellCommand(command: readonly string[], root: string): ShellPolicyDecision {
  const binary = command[0];
  if (!binary) return { allowed: false, code: "empty_command", reason: "comando vacío" };
  const base = binary.replace(/^.*\//, "");

  if (INTERPRETERS.has(base)) {
    for (const argument of command.slice(1)) {
      if (INLINE_CODE_FLAGS.has(argument)) {
        return {
          allowed: false,
          code: "inline_code_rejected",
          reason: `«${base}» no puede ejecutar código en línea (${argument}); debe ejecutar un fichero del workspace`,
        };
      }
    }
  }

  if (base === "find") {
    for (const argument of command.slice(1)) {
      if (FIND_EXEC_FLAGS.has(argument)) {
        return {
          allowed: false,
          code: "delegated_execution_rejected",
          reason: `«find» no puede delegar la ejecución (${argument})`,
        };
      }
    }
  }

  if (PACKAGE_RUNNERS.has(base)) {
    for (const argument of command.slice(1)) {
      if (PACKAGE_RUNNER_BANNED.has(argument)) {
        return {
          allowed: false,
          code: "download_and_execute_rejected",
          reason: `«${base}» no puede descargar y ejecutar paquetes (${argument})`,
        };
      }
    }
  }

  if (base === "git") {
    for (const argument of command.slice(1)) {
      if (GIT_BANNED_FLAGS.has(argument)) {
        return {
          allowed: false,
          code: "git_execution_vector_rejected",
          reason: `«git» no admite la bandera ${argument} en este contexto`,
        };
      }
    }
  }

  for (const argument of command.slice(1)) {
    const violation = checkPathArgument(root, argument);
    if (violation) return violation;
  }

  return { allowed: true };
}
