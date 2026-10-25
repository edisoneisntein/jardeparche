import { describe, expect, it, vi } from "vitest";
import { FailoverProvider } from "./failover-provider.js";
import { ProviderError } from "./errors.js";
import type { AiProvider, ChatRequest, ChatResponse, EmbedResult, StreamChunk } from "./types.js";

function response(content: string): ChatResponse {
  return { model: "m", content, toolCalls: [], finishReason: "stop", totalLatencyMs: 1, streamed: false };
}

/** Provider de prueba: falla o responde según su guion. */
function scripted(name: string, behaviour: "ok" | "fail" | "fail-after-content", content = "ok"): AiProvider {
  return {
    name,
    async chat(): Promise<ChatResponse> {
      if (behaviour === "fail") throw new ProviderError("unavailable", `${name} caído`, { retryable: true });
      return response(content);
    },
    async stream(_request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> {
      if (behaviour === "fail") throw new ProviderError("unavailable", `${name} caído`, { retryable: true });
      if (behaviour === "fail-after-content") {
        onChunk({ type: "delta", text: "parcial" });
        throw new ProviderError("unavailable", `${name} cayó a mitad`, { retryable: true });
      }
      onChunk({ type: "delta", text: content });
      return response(content);
    },
    async embed(): Promise<EmbedResult> {
      if (behaviour === "fail") throw new ProviderError("unavailable", `${name} sin embeddings`, { retryable: false });
      return { vectors: [[0.1]], model: name, dimensions: 1 };
    },
    async health() {
      return behaviour === "fail" ? { ok: false, detail: `${name} caído`, latencyMs: 1 } : { ok: true, detail: `${name} ok`, latencyMs: 1 };
    },
    async capabilities() {
      return { model: name, chat: true, streaming: true, tools: true, vision: false, embeddings: true, source: "config", checkedAt: new Date().toISOString() };
    },
  };
}

const REQUEST: ChatRequest = { messages: [{ role: "user", content: "hola" }] };

describe("FailoverProvider", () => {
  it("usa el primario cuando funciona", async () => {
    const failover = new FailoverProvider([scripted("primario", "ok"), scripted("respaldo", "ok", "respaldo")]);
    const result = await failover.chat(REQUEST);
    expect(result.content).toBe("ok");
    expect(failover.active.name).toBe("primario");
  });

  it("conmuta al respaldo cuando el primario falla por red", async () => {
    const events: string[] = [];
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok", "del respaldo")], {
      onFailover: (event) => events.push(`${event.from}->${event.to}:${event.kind}`),
    });
    const result = await failover.chat(REQUEST);
    expect(result.content).toBe("del respaldo");
    expect(events).toEqual(["primario->respaldo:unavailable"]);
    // Sticky: el respaldo pasa a ser el preferido.
    expect(failover.active.name).toBe("respaldo");
  });

  it("NO conmuta ante un error de petición (400): fallaría igual en todos", async () => {
    const invalido: AiProvider = {
      ...scripted("primario", "ok"),
      async chat(): Promise<ChatResponse> {
        throw new ProviderError("invalid_request", "petición rechazada", { retryable: false });
      },
    };
    const failover = new FailoverProvider([invalido, scripted("respaldo", "ok", "del respaldo")]);
    await expect(failover.chat(REQUEST)).rejects.toThrow(/petición rechazada/);
  });

  it("NO conmuta ante un aborto del usuario", async () => {
    const abortado: AiProvider = {
      ...scripted("primario", "ok"),
      async chat(): Promise<ChatResponse> {
        throw new ProviderError("aborted", "cancelado por el usuario", { retryable: false });
      },
    };
    const failover = new FailoverProvider([abortado, scripted("respaldo", "ok", "del respaldo")]);
    await expect(failover.chat(REQUEST)).rejects.toThrow(/cancelado/);
  });

  it("propaga el error si ya salió contenido a mitad del stream", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail-after-content"), scripted("respaldo", "ok", "del respaldo")]);
    const chunks: string[] = [];
    await expect(failover.stream(REQUEST, (chunk) => { if (chunk.type === "delta") chunks.push(chunk.text); })).rejects.toThrow(/mitad/);
    // No se duplica la respuesta con el contenido del respaldo.
    expect(chunks).toEqual(["parcial"]);
  });

  it("conmuta en streaming si el fallo ocurre antes de emitir contenido", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok", "del respaldo")]);
    const chunks: string[] = [];
    const result = await failover.stream(REQUEST, (chunk) => { if (chunk.type === "delta") chunks.push(chunk.text); });
    expect(result.content).toBe("del respaldo");
    expect(chunks).toEqual(["del respaldo"]);
  });

  it("falla con el detalle de todos los proveedores intentados", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "fail")]);
    await expect(failover.chat(REQUEST)).rejects.toThrow(/primario, respaldo/);
  });

  it("el health informa del proveedor sano y de que hay cadena", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok")]);
    const health = await failover.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain("respaldo");
    expect(health.detail).toContain("cadena de 2 proveedores");
  });

  it("el health NO cambia el proveedor preferido (sondear no es conmutar)", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok")]);
    await failover.health();
    // El primario es el preferido inicial: la sonda no debe reordenar la cadena.
    expect(failover.activeName).toBe("primario");
  });

  it("probePrimary sondea el primario sin alterar el estado", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok")]);
    const probe = await failover.probePrimary();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("primario");
    expect(failover.activeName).toBe("primario");
  });

  it("restorePrimary vuelve a promover el primario una vez se recupera", async () => {
    let primaryHealthy = false;
    const primary: AiProvider = {
      ...scripted("primario", "ok"),
      async chat(): Promise<ChatResponse> {
        if (!primaryHealthy) throw new ProviderError("unavailable", "primario caído", { retryable: true });
        return response("del primario");
      },
      async health() {
        return primaryHealthy ? { ok: true, detail: "primario ok", latencyMs: 1 } : { ok: false, detail: "primario caído", latencyMs: 1 };
      },
    };
    const failover = new FailoverProvider([primary, scripted("respaldo", "ok", "del respaldo")]);
    await failover.chat(REQUEST);
    expect(failover.activeName).toBe("respaldo");
    primaryHealthy = true;
    const probe = await failover.probePrimary();
    expect(probe.ok).toBe(true);
    failover.restorePrimary();
    expect(failover.activeName).toBe("primario");
  });

  it("el health es down si TODOS los proveedores fallan", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "fail")]);
    const health = await failover.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("primario");
    expect(health.detail).toContain("respaldo");
  });

  it("restorePrimary devuelve el preferencia al primero de la lista", async () => {
    const failover = new FailoverProvider([scripted("primario", "fail"), scripted("respaldo", "ok")]);
    await failover.chat(REQUEST);
    expect(failover.active.name).toBe("respaldo");
    failover.restorePrimary();
    expect(failover.active.name).toBe("primario");
  });

  it("exige al menos un proveedor", () => {
    expect(() => new FailoverProvider([])).toThrow();
  });
});

describe("FailoverProvider con fetch real (mockeado)", () => {
  it("no reintenta un stream con contenido ya emitido", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const failover = new FailoverProvider([scripted("primario", "fail-after-content"), scripted("respaldo", "ok", "x")]);
    await expect(failover.stream(REQUEST, () => undefined)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
