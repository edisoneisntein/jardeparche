import { describe, expect, it } from "vitest";
import { containerImageAvailable, materialiseWorkspace, runInSandbox, sandboxEnv } from "./sandbox.js";

describe("sandboxEnv", () => {
  it("solo expone el allowlist mínimo", () => {
    const env = sandboxEnv();
    expect(env.TZ).toBe("UTC");
    expect(env.PYTHONHASHSEED).toBe("0");
    expect(env.HOME).toBe("/tmp");
    expect(Object.keys(env)).not.toContain("NVIDIA_API_KEY");
  });

  it("ignora las claves fuera del allowlist", () => {
    const env = sandboxEnv({ NVIDIA_API_KEY: "nvapi-secreto", TZ: "Europe/Madrid" });
    expect(env.NVIDIA_API_KEY).toBeUndefined();
    expect(env.TZ).toBe("Europe/Madrid");
  });
});

describe("materialiseWorkspace", () => {
  it("rechaza rutas absolutas o con ..", () => {
    expect(() => materialiseWorkspace({ "/etc/passwd": "x" })).toThrow();
    expect(() => materialiseWorkspace({ "../escape.txt": "x" })).toThrow();
  });
});

describe("runInSandbox (backend de proceso)", () => {
  it("captura stdout, exit_code y tiempo", async () => {
    const result = await runInSandbox(
      {
        binary: "/bin/sh",
        args: ["-c", "printf 'hola\\n'; printf 'error\\n' 1>&2; exit 3"],
        files: {},
        env: sandboxEnv(),
        limits: { timeoutMs: 10_000, memoryLimitMb: 128, pidsLimit: 32, cpus: 1, maxOutputBytes: 1024 },
      },
      { backend: "process" },
    );
    expect(result.stdout).toContain("hola");
    expect(result.stderr).toContain("error");
    expect(result.exitCode).toBe(3);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
    expect(result.attestation.isolation).toBe("process");
    expect(result.attestation.network).toBe("host");
  });

  it("termina el proceso al vencer el timeout y marca timed_out", async () => {
    const result = await runInSandbox(
      {
        binary: "/bin/sh",
        args: ["-c", "sleep 30"],
        files: {},
        env: sandboxEnv(),
        limits: { timeoutMs: 700, memoryLimitMb: 128, pidsLimit: 32, cpus: 1, maxOutputBytes: 1024 },
      },
      { backend: "process" },
    );
    expect(result.timedOut).toBe(true);
    expect(result.executionTimeMs).toBeLessThan(10_000);
  });

  it("mata el grupo de procesos: los nietos no sobreviven al timeout", async () => {
    const marker = `/tmp/jarvis-orphan-${Date.now()}`;
    const result = await runInSandbox(
      {
        binary: "/bin/sh",
        args: ["-c", `(sleep 3; touch ${marker}) & sleep 30`],
        files: {},
        env: sandboxEnv(),
        limits: { timeoutMs: 700, memoryLimitMb: 128, pidsLimit: 32, cpus: 1, maxOutputBytes: 1024 },
      },
      { backend: "process" },
    );
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  });

  it("marca truncated cuando la salida supera el tope de bytes", async () => {
    const result = await runInSandbox(
      {
        binary: "/bin/sh",
        args: ["-c", "head -c 50000 /dev/zero | tr '\\0' 'x'"],
        files: {},
        env: sandboxEnv(),
        limits: { timeoutMs: 10_000, memoryLimitMb: 128, pidsLimit: 32, cpus: 1, maxOutputBytes: 1024 },
      },
      { backend: "process" },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdoutBytes).toBeGreaterThan(1024);
    expect(result.stdout.length).toBeLessThanOrEqual(1200);
  });
});

describe("containerImageAvailable", () => {
  it("detecta una imagen ausente sin lanzar", () => {
    expect(containerImageAvailable("jarvis-imagen-inexistente:latest")).toBe(false);
  });
});
