import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "./errors.js";
import { ResilientAIRouter } from "./resilient-router.js";
import type { AiProvider, ChatRequest, ChatResponse, ModelCapabilities } from "./types.js";
import type { ModelCapabilities as Capabilities } from "@jarvis/shared";

const REQUEST = { messages: [{ role: "user", content: "hola" }] } as unknown as ChatRequest;

function response(text: string): ChatResponse {
  return {
    model: "m",
    content: text,
    finishReason: "stop",
    totalLatencyMs: 1,
    streamed: false,
  };
}

/** Proveedor sano de mentira. */
function healthy(name: string): AiProvider {
  return {
    name,
    chat: async () => response(`${name}:ok`),
    stream: async () => response(`${name}:ok`),
    embed: async () => ({ vectors: [[0.1]], model: "m", dimensions: 1 }),
    health: async () => ({ ok: true, detail: "up", latencyMs: 1 }),
    capabilities: async () => ({ models: [], streaming: true, tools: true } as unknown as Capabilities),
  };
}

/** Proveedor que falla siempre y cuyo healthcheck también falla. */
function broken(name: string, kind: "network" | "unavailable" = "network"): AiProvider {
  return {
    name,
    chat: async () => {
      throw new ProviderError(kind, `${name} caído`);
    },
    stream: async () => {
      throw new ProviderError(kind, `${name} caído`);
    },
    embed: async () => {
      throw new ProviderError(kind, `${name} caído`);
    },
    health: async () => ({ ok: false, detail: `${name} caído`, latencyMs: 1 }),
    capabilities: async () => ({ models: [], streaming: true, tools: true } as unknown as Capabilities),
  };
}

describe("ARCH-001 · ResilientAIRouter", () => {
  it("exige al menos un proveedor", () => {
    expect(() => new ResilientAIRouter([])).toThrow(/at least one provider/);
  });

  it("delega en el proveedor sano", async () => {
    const router = new ResilientAIRouter([healthy("a")]);
    const result = await router.chat(REQUEST);
    expect(result.content).toBe("a:ok");
  });

  it("si el primario falla, redirige al respaldo SIN lanzar excepción al runtime", async () => {
    const router = new ResilientAIRouter([broken("primario"), healthy("respaldo")]);
    const result = await router.chat(REQUEST);
    expect(result.content).toBe("respaldo:ok");
    expect(router.activeName).toBe("respaldo");
  });

  it("el healthcheck reporta el respaldo cuando el primario está caído", async () => {
    const router = new ResilientAIRouter([broken("primario"), healthy("respaldo")]);
    const health = await router.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("respaldo");
  });

  it("si TODOS los proveedores fallan, propaga un error de proveedor (no una excepción de enrutado)", async () => {
    const router = new ResilientAIRouter([broken("a"), broken("b")]);
    await expect(router.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
  });

  it("abre el circuito de un proveedor que falla de forma sostenida", async () => {
    const clock = { value: 1_000 };
    const router = new ResilientAIRouter([broken("unico")], {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: () => clock.value,
    });
    await expect(router.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    expect(router.circuitState("unico")).toBe("closed");
    await expect(router.chat(REQUEST)).rejects.toBeInstanceOf(ProviderError);
    expect(router.circuitState("unico")).toBe("open");
  });

  it("abre el circuito del primario que se cae aunque el respaldo responda", async () => {
    const clock = { value: 1_000 };
    const router = new ResilientAIRouter([broken("primario"), healthy("respaldo")], {
      failureThreshold: 1,
      cooldownMs: 5_000,
      now: () => clock.value,
    });
    await router.chat(REQUEST);
    expect(router.circuitState("primario")).toBe("open");
    expect(router.activeName).toBe("respaldo");
  });

  it("el circuito se cierra solo cuando pasa el enfriamiento y el primario vuelve", async () => {
    const clock = { value: 1_000 };
    const recovering = broken("primario");
    recovering.health = async () => ({ ok: true, detail: "vuelve", latencyMs: 1 });
    const router = new ResilientAIRouter([recovering, healthy("respaldo")], {
      failureThreshold: 1,
      cooldownMs: 5_000,
      now: () => clock.value,
    });
    await router.chat(REQUEST);
    expect(router.circuitState("primario")).toBe("open");
    clock.value += 6_000;
    await router.health();
    expect(router.circuitState("primario")).toBe("closed");
    expect(router.activeName).toBe("primario");
  });

  it("notifica las conmutaciones", async () => {
    const onFailover = vi.fn();
    const router = new ResilientAIRouter([broken("primario"), healthy("respaldo")], { onFailover });
    await router.chat(REQUEST);
    expect(onFailover).toHaveBeenCalledWith(expect.objectContaining({ from: "primario", to: "respaldo" }));
  });
});
