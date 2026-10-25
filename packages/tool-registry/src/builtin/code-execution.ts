import { z } from "zod";
import type { ToolDefinition } from "@jarvis/shared";
import { containerImageStatus, newSandboxVolumeName, removeSandboxVolume, runInSandbox, sandboxEnv, warmupContainerImages, type SandboxAttestation, type SandboxResult } from "../sandbox.js";
import type { ToolConfig } from "../types.js";

/**
 * Herramientas de ejecución de código.
 *
 * Contrato de la directiva EJ-01:
 *  · Los techos de tiempo y memoria los impone el runtime, no el modelo.
 *  · El sandbox NO hereda el entorno del host: solo un allowlist mínimo.
 *  · El retorno distingue fase de fallo, y expone banderas de integridad
 *    (truncated / timed_out / oom_killed) para que el agente NO complete por
 *    inferencia lo que no llegó a imprimirse.
 *  · La red del sandbox es `none`: el agente no puede exfiltrar ni descargar.
 *
 * Cuando el sandbox de contenedor no está disponible, la tool NO se anuncia al
 * modelo (regla del registro: una capacidad no configurada se reporta como no
 * disponible, nunca se simula).
 */

const CEILING_TIMEOUT_MS = 120_000;
const CEILING_MEMORY_MB = 2048;
const CEILING_COMPILE_TIMEOUT_MS = 300_000;
const CEILING_COMPILE_MEMORY_MB = 4096;
const MAX_OUTPUT_BYTES = 256 * 1024;
const PIDS_LIMIT = 128;
const CPUS = 1;

const InterpreterSchema = z.object({
  language: z.enum(["python", "nodejs"]),
  code_string: z.string().min(1).max(100_000),
  stdin: z.string().max(10_000).optional(),
  timeout_seconds: z.number().int().min(1).max(120).default(30),
  memory_limit_mb: z.number().int().min(64).max(2048).default(256),
});

const BuildSchema = z.object({
  language: z.enum(["cpp", "rust", "go"]),
  code_string: z.string().min(1).max(200_000),
  files: z.record(z.string().max(200_000)).optional().default({}),
  timeout_seconds: z.number().int().min(1).max(300).default(60),
  memory_limit_mb: z.number().int().min(64).max(4096).default(512),
});

type InterpreterInput = z.infer<typeof InterpreterSchema>;
type BuildInput = z.infer<typeof BuildSchema>;

interface InterpreterProfile {
  image: string;
  binary: string;
  args: (file: string) => string[];
  entryFile: string;
  toolchain: string;
}

const INTERPRETERS: Record<"python" | "nodejs", InterpreterProfile> = {
  python: {
    image: "python:3.12-slim",
    binary: "python3",
    args: (file) => [file],
    entryFile: "main.py",
    toolchain: "python:3.12",
  },
  nodejs: {
    image: "node:22-slim",
    binary: "node",
    args: (file) => [file],
    entryFile: "main.js",
    toolchain: "nodejs:22",
  },
};

interface BuildProfile {
  image: string;
  /** Ruta del archivo de entrada dentro del proyecto. */
  entryFile: string;
  /** Manifiesto que debe existir para compilar (Rust). */
  manifest?: { path: string; template: string };
  /** Fase de compilación (plantilla fija del servidor). */
  build: (files: Record<string, string>) => { binary: string; args: string[] };
  /** Fase de ejecución: la ruta del binario ya compilado, dentro del volumen. */
  runBinary: string;
  /** Si el proyecto trae `vendor/`, la compilación usa el modo vendorizado. */
  vendorAware: boolean;
  toolchain: string;
  env: Record<string, string>;
}

const RUST_MANIFEST = `[package]
name = "jarvis"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "jarvis"
path = "src/main.rs"

[dependencies]
`;

const BUILDERS: Record<"cpp" | "rust" | "go", BuildProfile> = {
  cpp: {
    image: "jarvis-sandbox:latest",
    entryFile: "main.cpp",
    build: () => ({
      binary: "sh",
      args: ["-c", "mkdir -p /w/bin && g++ -std=c++20 -O2 -o /w/bin/prog /w/main.cpp"],
    }),
    runBinary: "/w/bin/prog",
    vendorAware: false,
    toolchain: "cpp:g++20",
    env: {},
  },
  rust: {
    image: "jarvis-sandbox:latest",
    entryFile: "src/main.rs",
    manifest: { path: "Cargo.toml", template: RUST_MANIFEST },
    build: () => ({
      binary: "cargo",
      args: ["build", "--offline", "--release", "--manifest-path", "/w/Cargo.toml"],
    }),
    runBinary: "/w/target/release/jarvis",
    vendorAware: false,
    toolchain: "rust:cargo",
    env: { CARGO_TARGET_DIR: "/w/target", CARGO_HOME: "/tmp/cargo", RUSTFLAGS: "-C debuginfo=0" },
  },
  go: {
    image: "jarvis-sandbox:latest",
    entryFile: "main.go",
    build: (files) => ({
      binary: "sh",
      args: [
        "-c",
        `mkdir -p /w/bin && go build ${hasVendor(files) ? "-mod=vendor " : ""}-o /w/bin/prog /w/main.go`,
      ],
    }),
    runBinary: "/w/bin/prog",
    vendorAware: true,
    toolchain: "go:1.22",
    env: { GOCACHE: "/w/.gocache", GOMODCACHE: "/w/.gomodcache", GOPATH: "/w/.gopath", HOME: "/w" },
  },
};

/** ¿El proyecto incluye un directorio vendor/ (dependencias offline)? */
function hasVendor(files: Record<string, string>): boolean {
  return Object.keys(files).some((key) => key === "vendor" || key.startsWith("vendor/"));
}

function interpreterImage(config: ToolConfig, language: "python" | "nodejs"): string {
  return config.sandboxImages?.[language] ?? INTERPRETERS[language].image;
}

/**
 * Precalienta el sondeo de las imágenes de sandbox de este despliegue.
 *
 * Se invoca al arrancar el servidor: el catálogo que ve el modelo refleja la
 * realidad desde el primer turno, sin esperas y sin anunciar tools que no
 * pueden ejecutarse.
 *
 * Args:
 *   config: Configuración de tools (incluye las imágenes configuradas).
 */
export async function warmupSandboxImages(config: ToolConfig): Promise<void> {
  const images = [
    interpreterImage(config, "python"),
    interpreterImage(config, "nodejs"),
    buildImage(config, "cpp"),
    buildImage(config, "rust"),
    buildImage(config, "go"),
  ];
  await warmupContainerImages(images);
}

function buildImage(config: ToolConfig, language: "cpp" | "rust" | "go"): string {
  return config.sandboxImages?.[language] ?? BUILDERS[language].image;
}

function attestationOf(result: SandboxResult): SandboxAttestation {
  return result.attestation;
}

/** Payload que el modelo recibe: la forma canónica de la directiva EJ-01. */
function voicePayload(input: {
  result: SandboxResult;
  toolchain: string;
  limitsClamped: boolean;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { result } = input;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    execution_time_ms: result.executionTimeMs,
    timed_out: result.timedOut,
    oom_killed: result.oomKilled,
    truncated: result.truncated,
    stdout_bytes: result.stdoutBytes,
    stderr_bytes: result.stderrBytes,
    exit_signal: result.signal,
    run_id: result.runId,
    limits_clamped: input.limitsClamped,
    toolchain: input.toolchain,
    sandbox: {
      isolation: result.attestation.isolation,
      network: result.attestation.network,
      filesystem: result.attestation.filesystem,
      uid: result.attestation.uid,
      pids_max: result.attestation.pids_max,
      memory_max_mb: result.attestation.memory_max_mb,
      controls: result.attestation.controls,
    },
    ...(input.extra ?? {}),
  };
}

export function createExecuteCodeInterpreterTool(config: ToolConfig): ToolDefinition<InterpreterInput> {
  return {
    name: "code.execute_interpreter",
    title: "Intérprete de código aislado",
    description:
      "Ejecuta código Python o Node.js en un contenedor efímero y aislado (sin red, sistema de archivos de solo lectura salvo /tmp, usuario no privilegiado, límites de memoria y procesos) y devuelve stdout, stderr, exit_code y las banderas de integridad de la ejecución. Un contenedor nuevo por llamada: no hay estado entre llamadas.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: CEILING_TIMEOUT_MS + 5_000,
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "nodejs"], description: "Intérprete: python o nodejs." },
        code_string: { type: "string", description: "Código fuente completo de un único archivo, autocontenido." },
        stdin: { type: "string", description: "Entrada estándar opcional." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 120,
          default: 30,
          description: "Límite de tiempo solicitado. El servidor impone el techo real (120 s) y avisa con limits_clamped.",
        },
        memory_limit_mb: {
          type: "integer",
          minimum: 64,
          maximum: 2048,
          default: 256,
          description: "Memoria solicitada. El servidor impone el techo real (2048 MB) y avisa con limits_clamped.",
        },
      },
      required: ["language", "code_string"],
      additionalProperties: false,
    },
    parse: (raw) => InterpreterSchema.parse(raw),
    availability: () => {
      const image = interpreterImage(config, "python");
      const status = containerImageStatus(image);
      if (status === "missing") {
        return {
          available: false,
          reason: `Sandbox de contenedor no disponible: falta la imagen ${image}. Ejecuta \`pnpm sandbox:build\`.`,
        };
      }
      if (status === "unknown") {
        return {
          available: false,
          reason: `Comprobando la disponibilidad del sandbox (${image})…`,
        };
      }
      return { available: true };
    },
    execute: async (input) => {
      const profile = INTERPRETERS[input.language];
      const image = interpreterImage(config, input.language);
      const timeoutMs = Math.min(input.timeout_seconds * 1000, CEILING_TIMEOUT_MS);
      const memoryLimitMb = Math.min(input.memory_limit_mb, CEILING_MEMORY_MB);
      const limitsClamped =
        input.timeout_seconds * 1000 > CEILING_TIMEOUT_MS || input.memory_limit_mb > CEILING_MEMORY_MB;

      const files: Record<string, string> = { [profile.entryFile]: input.code_string };

      try {
        const result = await runInSandbox(
          {
            image,
            binary: profile.binary,
            args: profile.args(`/w/${profile.entryFile}`),
            files,
            stdin: input.stdin,
            env: sandboxEnv(),
            limits: { timeoutMs, memoryLimitMb, pidsLimit: PIDS_LIMIT, cpus: CPUS, maxOutputBytes: MAX_OUTPUT_BYTES },
          },
          { backend: "container" },
        );

        return {
          ok: result.exitCode === 0 && !result.timedOut && !result.oomKilled,
          summary:
            result.exitCode === 0
              ? `Ejecución correcta (${result.executionTimeMs} ms, run_id ${result.runId}).`
              : `Ejecución fallida: exit_code=${result.exitCode}${result.timedOut ? " (timeout)" : ""}${result.oomKilled ? " (OOM)" : ""}${result.truncated ? " (salida truncada)" : ""}.`,
          unavailable: false,
          data: voicePayload({ result, toolchain: profile.toolchain, limitsClamped }),
        };
      } catch (error) {
        return {
          ok: false,
          summary: `El sandbox no pudo ejecutar el código: ${(error as Error).message}`,
          unavailable: false,
          error: (error as Error).name === "SandboxError" ? (error as Error).message : "sandbox_error",
        };
      }
    },
  };
}

export function createCompileAndRunTool(config: ToolConfig): ToolDefinition<BuildInput> {
  return {
    name: "code.compile_and_run",
    title: "Compilación y ejecución aislada",
    description:
      "Compila un proyecto pequeño (C++, Rust o Go) con el toolchain pineado del sandbox y ejecuta el binario resultante. Devuelve las fases de compilación y de ejecución por separado (build_exit_code y exit_code), con stdout, stderr y las banderas de integridad. Las dependencias solo se resuelven contra el registry offline del sandbox.",
    risk: "local_reversible",
    requiresApproval: false,
    timeoutMs: CEILING_COMPILE_TIMEOUT_MS + 10_000,
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["cpp", "rust", "go"], description: "Toolchain: cpp, rust o go." },
        code_string: { type: "string", description: "Contenido del archivo de entrada principal." },
        files: {
          type: "object",
          description:
            "Archivos adicionales del proyecto (manifiesto, módulos, cabeceras). La clave es la ruta relativa dentro del proyecto; no se permiten rutas absolutas ni '..'.",
          additionalProperties: { type: "string" },
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          default: 60,
          description: "Límite solicitado para build+run en conjunto. Techo real del servidor: 300 s.",
        },
        memory_limit_mb: {
          type: "integer",
          minimum: 64,
          maximum: 4096,
          default: 512,
          description: "Memoria solicitada. Techo real del servidor: 4096 MB.",
        },
      },
      required: ["language", "code_string"],
      additionalProperties: false,
    },
    parse: (raw) => BuildSchema.parse(raw),
    availability: () => {
      const missing = (["cpp", "rust", "go"] as const).filter((language) => containerImageStatus(buildImage(config, language)) === "missing");
      const unknown = (["cpp", "rust", "go"] as const).filter((language) => containerImageStatus(buildImage(config, language)) === "unknown");
      if (missing.length === 3) {
        return {
          available: false,
          reason: `No hay imágenes de sandbox de compilación (${missing.join(", ")}). Ejecuta \`pnpm sandbox:build\`.`,
        };
      }
      if (missing.length + unknown.length === 3) {
        return {
          available: false,
          reason: `Comprobando las imágenes de sandbox de compilación (${[...missing, ...unknown].join(", ")})…`,
        };
      }
      return { available: true };
    },
    execute: async (input) => {
      const profile = BUILDERS[input.language];
      const image = buildImage(config, input.language);
      const timeoutMs = Math.min(input.timeout_seconds * 1000, CEILING_COMPILE_TIMEOUT_MS);
      const memoryLimitMb = Math.min(input.memory_limit_mb, CEILING_COMPILE_MEMORY_MB);
      const limitsClamped =
        input.timeout_seconds * 1000 > CEILING_COMPILE_TIMEOUT_MS || input.memory_limit_mb > CEILING_COMPILE_MEMORY_MB;

      // El código principal SIEMPRE se materializa en la ruta de entrada del
      // proyecto: es el archivo que la plantilla de compilación espera.
      const sourceFiles: Record<string, string> = {
        ...input.files,
        [profile.entryFile]: input.code_string,
      };
      // Manifiesto por defecto si el modelo no lo aporta (Rust lo exige).
      if (profile.manifest && !sourceFiles[profile.manifest.path]) {
        sourceFiles[profile.manifest.path] = profile.manifest.template;
      }
      const build = profile.build(sourceFiles);
      const files: Record<string, string> = { ...sourceFiles };
      const env = sandboxEnv(profile.env);
      // El volumen sobrevive a las dos fases: es donde queda el binario.
      const volume = newSandboxVolumeName();

      try {
        // ── Fase 1: compilación ────────────────────────────────────────
        let buildResult: SandboxResult;
        try {
          buildResult = await runInSandbox(
            {
              image,
              binary: build.binary,
              args: build.args,
              files,
              env,
              // El binario debe sobrevivir a la fase de compilación: el volumen
              // se monta en escritura durante el build y en solo lectura al ejecutar.
              volumeMode: "rw",
              sharedVolume: { name: volume, populate: true },
              limits: { timeoutMs, memoryLimitMb, pidsLimit: PIDS_LIMIT, cpus: CPUS, maxOutputBytes: MAX_OUTPUT_BYTES },
            },
            { backend: "container" },
          );
        } catch (error) {
          return {
            ok: false,
            summary: `El sandbox no pudo compilar: ${(error as Error).message}`,
            unavailable: false,
            error: (error as Error).name === "SandboxError" ? (error as Error).message : "sandbox_error",
          };
        }

        if (buildResult.exitCode !== 0) {
          return {
            ok: false,
            summary: `La compilación falló: build_exit_code=${buildResult.exitCode}. El binario nunca llegó a ejecutarse.`,
            unavailable: false,
            data: voicePayload({
              result: buildResult,
              toolchain: profile.toolchain,
              limitsClamped,
              extra: {
                build_stdout: buildResult.stdout,
                build_stderr: buildResult.stderr,
                build_exit_code: buildResult.exitCode,
                build_time_ms: buildResult.executionTimeMs,
                phase: "build",
              },
            }),
          };
        }

        // ── Fase 2: ejecución ──────────────────────────────────────────
        const run = { binary: profile.runBinary, args: [] as string[] };
        let runResult: SandboxResult;
        try {
          runResult = await runInSandbox(
            {
              image,
              binary: run.binary,
              args: run.args,
              files,
              env,
              volumeMode: "ro",
              sharedVolume: { name: volume, populate: false },
              limits: { timeoutMs, memoryLimitMb, pidsLimit: PIDS_LIMIT, cpus: CPUS, maxOutputBytes: MAX_OUTPUT_BYTES },
            },
            { backend: "container" },
          );
        } catch (error) {
          return {
            ok: false,
            summary: `El sandbox no pudo ejecutar el binario: ${(error as Error).message}`,
            unavailable: false,
            error: (error as Error).name === "SandboxError" ? (error as Error).message : "sandbox_error",
          };
        }

        return {
          ok: runResult.exitCode === 0 && !runResult.timedOut && !runResult.oomKilled,
          summary:
            runResult.exitCode === 0
              ? `Compilación y ejecución correctas (build ${buildResult.executionTimeMs} ms, run ${runResult.executionTimeMs} ms, run_id ${runResult.runId}).`
              : `La ejecución falló: exit_code=${runResult.exitCode}${runResult.timedOut ? " (timeout)" : ""}${runResult.oomKilled ? " (OOM)" : ""}${runResult.truncated ? " (salida truncada)" : ""}.`,
          unavailable: false,
          data: voicePayload({
            result: runResult,
            toolchain: profile.toolchain,
            limitsClamped,
            extra: {
              build_stdout: buildResult.stdout,
              build_stderr: buildResult.stderr,
              build_exit_code: buildResult.exitCode,
              build_time_ms: buildResult.executionTimeMs,
              phase: "run",
            },
          }),
        };
      } finally {
        // El volumen compartido se destruye siempre: una excepción intermedia
        // no puede dejar recursos de docker huérfanos.
        await removeSandboxVolume(volume);
      }
    },
  };
}

/** Testeable sin sandbox: extrae el payload canónico de un resultado. */
export { voicePayload };
