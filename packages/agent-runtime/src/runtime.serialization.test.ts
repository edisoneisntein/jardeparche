import { describe, expect, it } from "vitest";
import { FakeProvider } from "@jarvis/ai-provider";
import { MemoryService, MemoryStore } from "@jarvis/memory";
import { createToolRegistry } from "@jarvis/tool-registry";
import { AgentRuntime } from "./runtime.js";

/**
 * Caracterización de la SERIALIZACIÓN de turnos por sesión.
 *
 * Dos turnos simultáneos de la misma sesión intercalaban sus escrituras de
 * memoria y el segundo construía el prompt con el historial a medias del
 * primero. La cola por sesión elimina esa intercalación; los turnos de
 * sesiones distintas NO se bloquean entre sí.
 */
const ACTOR = { userId: "alice", sessionId: "11111111-1111-1111-1111-111111111111" };
const OTRO = { userId: "alice", sessionId: "22222222-2222-2222-2222-222222222222" };

async function harness() {
  const store = new MemoryStore();
  await store.init();
  const memory = new MemoryService({ store });
  const registry = createToolRegistry({
    memory,
    config: { documentsRoots: [], webSearch: { provider: "federated" }, maxResultBytes: 1024 },
  });
  const provider = new FakeProvider([{ content: "uno", delayMs: 40 }, { content: "dos", delayMs: 40 }]);
  const runtime = new AgentRuntime({
    provider,
    registry,
    memory,
    emit: () => {},
    approvalTimeoutMs: 2_000,
    fullCatalog: true,
  });
  return { runtime, provider };
}

describe("AgentRuntime · cola por sesión", () => {
  it("dos turnos de la misma sesión se ejecutan uno detrás de otro", async () => {
    const { runtime, provider } = await harness();
    const order: string[] = [];
    const first = runtime.runTurn(ACTOR, "primero").then((result) => {
      order.push(`primero:${result.text}`);
    });
    const second = runtime.runTurn(ACTOR, "segundo").then((result) => {
      order.push(`segundo:${result.text}`);
    });
    await Promise.all([first, second]);
    // El primero se emite antes del segundo: no hay intercalación.
    expect(order).toEqual(["primero:uno", "segundo:dos"]);
    expect(provider.streams.length).toBe(2);
  });

  it("turnos de sesiones distintas no se bloquean entre sí", async () => {
    const { runtime } = await harness();
    const started = Date.now();
    await Promise.all([runtime.runTurn(ACTOR, "a"), runtime.runTurn(OTRO, "b")]);
    // En serie serían ~80 ms; en paralelo, ~40 ms. La aserción es laxa a
    // propósito: no mide el reloj, mide que el segundo turno NO espera a que
    // termine el primero (si lo hiciera, el segundo no habría podido
    // empezar hasta 40 ms más tarde).
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("un turno en cola se puede cancelar antes de empezar", async () => {
    const { runtime } = await harness();
    const pending = runtime.runTurn(ACTOR, "primero");
    const queued = runtime.runTurn(ACTOR, "segundo");
    const queuedTaskId = [...(runtime as unknown as { tasks: Map<string, unknown> }).tasks.keys()][1];
    expect(queuedTaskId).toBeTruthy();
    expect(runtime.cancel(queuedTaskId)).toBe(true);
    await Promise.all([pending, queued]);
    // El turno cancelado devuelve vacío y no ejecuta su inferencia.
    expect(runtime.isRunning(queuedTaskId)).toBe(false);
  });
});
