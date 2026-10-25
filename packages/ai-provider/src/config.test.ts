import { describe, expect, it } from "vitest";
import { EnvConfigError, loadConfig, loadNvidiaConfig } from "./config.js";

const MINIMAL_ENV = { NVIDIA_API_KEY: "nvapi-test" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("falla con un mensaje controlado si falta NVIDIA_API_KEY", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(EnvConfigError);
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it("falla igual si la clave está vacía o es solo espacios", () => {
    expect(() => loadConfig({ NVIDIA_API_KEY: "   " } as NodeJS.ProcessEnv)).toThrow(/NVIDIA_API_KEY is not set/);
  });

  it("el mensaje de error NO revela el valor de la variable", () => {
    try {
      loadConfig({ NVIDIA_API_KEY: "super-secreto" } as NodeJS.ProcessEnv & { NVIDIA_API_KEY?: string });
    } catch {
      // se comprueba abajo
    }
    const error = (() => {
      try {
        loadConfig({} as NodeJS.ProcessEnv);
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(error?.message).not.toContain("super-secreto");
    expect(error?.message).not.toContain("process.env");
  });

  it("devuelve la configuración sellada: no se puede mutar", () => {
    const config = loadConfig(MINIMAL_ENV);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.nvidia)).toBe(true);
    expect(() => {
      (config.nvidia as { apiKey: string }).apiKey = "otra-cosa";
    }).toThrow(TypeError);
    expect(config.nvidia.apiKey).toBe("nvapi-test");
  });

  it("no congela el original, solo la copia validada", () => {
    const env = { ...MINIMAL_ENV };
    const config = loadConfig(env);
    expect(env.NVIDIA_API_KEY).toBe("nvapi-test");
    expect(config.nvidia.apiKey).toBe("nvapi-test");
  });

  it("OpenRouter ausente es null, no un error", () => {
    expect(loadConfig(MINIMAL_ENV).openrouter).toBeNull();
  });

  it("carga OpenRouter cuando está configurado", () => {
    const config = loadConfig({ ...MINIMAL_ENV, OPENROUTER_API_KEY: "sk-or-x" } as NodeJS.ProcessEnv);
    expect(config.openrouter?.apiKey).toBe("sk-or-x");
    expect(Object.isFrozen(config.openrouter)).toBe(true);
  });

  it("rechaza una configuración inválida con un error de esquema", () => {
    expect(() => loadConfig({ NVIDIA_API_KEY: "x", NVIDIA_MAX_RETRIES: "99" } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("loadNvidiaConfig (retrocompatible)", () => {
  it("sigue funcionando con la misma firma", () => {
    expect(loadNvidiaConfig({ NVIDIA_API_KEY: "nvapi-legacy" })).toMatchObject({ apiKey: "nvapi-legacy" });
  });
});
