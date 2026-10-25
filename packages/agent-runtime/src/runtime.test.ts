import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@jarvis/shared";
import { FakeProvider } from "@jarvis/ai-provider";
import { MemoryService, MemoryStore } from "@jarvis/memory";
import { createToolRegistry } from "@jarvis/tool-registry";
import { AgentRuntime } from "../src/runtime.js";

const ACTOR = { userId: "alice", sessionId: "11111111-1111-1111-1111-111111111111" };

async function harness(
  steps: ConstructorParameters<typeof FakeProvider>[0],
  opciones: { fullCatalog?: boolean; autoApprove?: boolean } = {},
) {
  const store = new MemoryStore();
  await store.init();
  const memory = new MemoryService({ store });
  const registry = createToolRegistry({
    memory,
    // `federated` no exige credencial: deja web.search y web.fetch en el
    // catálogo, que es lo que el agente necesita para poder investigar.
    config: { documentsRoots: [], webSearch: { provider: "federated" }, maxResultBytes: 1024 },
  });
  const provider = new FakeProvider(steps);
  const events: ServerEvent[] = [];
  const runtime = new AgentRuntime({
    provider,
    registry,
    memory,
    emit: (event) => events.push(event),
    approvalTimeoutMs: 2000,
    fullCatalog: opciones.fullCatalog ?? true,
    autoApprove: opciones.autoApprove ?? true,
  });
  return { runtime, provider, memory, store, events };
}

function eventsOfType<T extends ServerEvent["type"]>(events: ServerEvent[], type: T) {
  return events.filter((event) => event.type === type) as Extract<ServerEvent, { type: T }>[];
}

describe("AgentRuntime", () => {
  it("answers a direct question without tools and drives real state changes", async () => {
    const { runtime, events } = await harness([{ content: "Hola, soy JARVIS." }]);
    const result = await runtime.runTurn(ACTOR, "hola");
    expect(result.text).toBe("Hola, soy JARVIS.");
    // Las tools de investigación están SIEMPRE disponibles: el modelo las ve
    // pero puede no llamarlas. En una respuesta directa no se emite ningún
    // delta (el buffer conversacional se descarta).
    const planning = eventsOfType(events, "assistant.state_changed").find((event) => event.state === "PLANNING");
    expect(planning?.detail).toBe("decidiendo si uso herramientas");
    // Con tools disponibles la ruta conversacional ya transmite deltas: el
    // texto se ve progresivamente (y la voz puede empezar con la primera
    // frase). La protección frente al markup de tool-call la aporta ahora la
    // detección de llamadas en crudo, no el buffer.
    expect(eventsOfType(events, "assistant.delta").length).toBeGreaterThan(0);
    const states = eventsOfType(events, "assistant.state_changed").map((event) => event.state);
    expect(states).toContain("UNDERSTANDING");
    expect(states).toContain("PLANNING");
    expect(states).toContain("SPEAKING");
    expect(states.at(-1)).toBe("IDLE");
    expect(eventsOfType(events, "assistant.message_completed")).toHaveLength(1);
  });

  it("retries with the full catalog when a direct answer reveals it needed data", async () => {
    // Modo poda: es el único escenario donde el reintento tiene sentido.
    const { runtime, events } = await harness(
      [
        { content: "Lo siento, no puedo verificar eso sin una herramienta." },
        { toolCalls: [{ id: "c1", name: "time.now", arguments: "{}" }] },
        { content: "Son las 12:00." },
      ],
      { fullCatalog: false },
    );
    const result = await runtime.runTurn(ACTOR, "cuéntame algo interesante");
    expect(result.text).toBe("Son las 12:00.");
    expect(eventsOfType(events, "tool.started")).toHaveLength(1);
    const completed = eventsOfType(events, "assistant.message_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.text).toBe("Son las 12:00.");
  });

  it("reintenta con aviso explícito ante «no tengo disponible la herramienta» (caso real del usuario)", async () => {
    const { runtime, provider, events } = await harness(
      [
        {
          content:
            "(*) no tengo disponible la herramienta `web_search`. Solo puedo usar las herramientas que el sistema me ha otorgado (hora, datos del sistema, cálculos, memoria, archivos, etc.).",
        },
        { toolCalls: [{ id: "c1", name: "time.now", arguments: "{}" }] },
        { content: "Ya lo he consultado." },
      ],
      { fullCatalog: false },
    );
    const result = await runtime.runTurn(ACTOR, "busca en la web el resultado de hoy");
    // Hubo un reintento: el modelo se negó y el runtime volvió a preguntarle.
    // 1) la negativa, 2) el reintento con el catálogo completo, 3) la
    // continuación tras el resultado de la herramienta.
    expect(provider.streams.length).toBe(3);
    // El reintento lleva la instrucción que le ordena usar las herramientas.
    const retrySystem = provider.streams[1]?.messages.find((message) => message.role === "system");
    expect(retrySystem?.content).toContain("están habilitadas y funcionan");
    expect(retrySystem?.content).toContain("web.search");
    // Y la web está en el catálogo del reintento, no solo en el texto.
    const retryTools = provider.streams[1]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(retryTools).toContain("web_search");
    expect(retryTools).toContain("web_fetch");
    // El resultado final es el del turno bueno, no la negativa.
    expect(result.text).toBe("Ya lo he consultado.");
    expect(result.text).not.toContain("no tengo disponible");
    expect(eventsOfType(events, "tool.started")).toHaveLength(1);
  });

  it("executes a tool and folds the real result back into the answer", async () => {
    const { runtime, events, memory } = await harness([
      { toolCalls: [{ id: "c1", name: "math.calculate", arguments: '{"expression":"2+2"}' }] },
      { content: "El resultado es 4." },
    ]);
    const result = await runtime.runTurn(ACTOR, "cuánto es 2+2");
    expect(result.text).toBe("El resultado es 4.");
    expect(eventsOfType(events, "tool.started")).toHaveLength(1);
    const completed = eventsOfType(events, "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toEqual({ expression: "2+2", value: 4 });
    const calls = await memory.raw.listToolCalls(result.taskId);
    expect(calls[0]?.status).toBe("completed");
    const audit = await memory.raw.listAudit("alice");
    expect(audit.some((entry) => entry.action === "tool.completed")).toBe(true);
  });

  it("PERF-002 · dos turnos idénticos solo llaman al proveedor UNA vez", async () => {
    const { runtime, provider } = await harness([{ content: "La respuesta es 4." }]);
    const first = await runtime.runTurn(ACTOR, "cuánto es 2+2");
    expect(first.text).toBe("La respuesta es 4.");
    const callsAfterFirst = provider.streams.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // El guardado en la caché es asíncrono: se le da un turno de bucle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await runtime.runTurn(ACTOR, "cuánto es 2+2");
    expect(second.text).toBe("La respuesta es 4.");
    // El segundo turno se resolvió desde la caché: el proveedor NO se llamó.
    expect(provider.streams.length).toBe(callsAfterFirst);
  });

  it("PERF-002 · un turno que usó herramientas NO se cachea", async () => {
    const { runtime, provider } = await harness([
      { toolCalls: [{ id: "c1", name: "math.calculate", arguments: '{"expression":"2+2"}' }] },
      { content: "El resultado es 4." },
    ]);
    await runtime.runTurn(ACTOR, "cuánto es 2+2");
    const callsAfterFirst = provider.streams.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.runTurn(ACTOR, "cuánto es 2+2");
    // Repetir la respuesta sin repetir la herramienta cambiaría el
    // comportamiento: por eso no se cachea.
    expect(provider.streams.length).toBeGreaterThan(callsAfterFirst);
  });

  it("rejects invalid tool arguments without executing anything", async () => {
    const { runtime, events } = await harness([
      { toolCalls: [{ id: "c1", name: "math.calculate", arguments: '{"expression":42}' }] },
      { content: "No pude calcularlo." },
    ]);
    await runtime.runTurn(ACTOR, "calcula 42");
    const failed = eventsOfType(events, "tool.failed");
    expect(failed[0]?.error).toMatch(/argumentos inválidos/);
    expect(eventsOfType(events, "tool.completed")).toHaveLength(0);
  });

  it("ejecuta sin preguntar cuando la aprobación automática está activa", async () => {
    const steps: ConstructorParameters<typeof FakeProvider>[0] = [];
    const { runtime, events, memory } = await harness(steps, { autoApprove: true });
    const created = await memory.raw.createTask({ userId: "alice", title: "temporal", status: "open" });
    steps.push({ toolCalls: [{ id: "c1", name: "task.delete", arguments: JSON.stringify({ id: created.id }) }] });
    steps.push({ content: "Tarea eliminada." });

    await runtime.runTurn(ACTOR, "borra la tarea temporal");
    // No se pide confirmación...
    expect(eventsOfType(events, "tool.awaiting_approval")).toHaveLength(0);
    // ...pero la acción queda auditada.
    const audit = await memory.raw.listAudit("alice");
    expect(audit.some((entry) => entry.action === "tool.auto_approved")).toBe(true);
  });

  it("ofrece el catálogo completo de herramientas en cada turno", async () => {
    const { runtime, provider } = await harness([{ content: "Listo." }], { fullCatalog: true });
    await runtime.runTurn(ACTOR, "hola");
    const herramientas = provider.streams[0]?.tools ?? [];
    // Con la poda por intención, este turno no tendría nada: con el catálogo
    // completo, el modelo ve todas las herramientas y no puede excusarse.
    expect(herramientas.length).toBeGreaterThan(5);
  });

  it("NUNCA muestra ni deja oír la excusa: la retiene y reintenta con todo", async () => {
    // El modelo se niega. El usuario NO debe ver ni oír esa frase: se
    // reintenta con el catálogo completo y lo que se entrega es la respuesta
    // buena.
    const { runtime, events } = await harness(
      [
        { content: "No dispongo de una herramienta que me permita buscar eso ahora mismo." },
        { toolCalls: [{ id: "c1", name: "time.now", arguments: "{}" }] },
        { content: "Ya lo he comprobado." },
      ],
      { fullCatalog: false },
    );
    const result = await runtime.runTurn(ACTOR, "busca en la web el resultado de hoy");
    const deltas = eventsOfType(events, "assistant.delta").map((event) => event.text).join("");
    // La excusa no se emitió NUNCA como delta (ni se oyó).
    expect(deltas).not.toMatch(/No dispongo de una herramienta/i);
    expect(deltas).not.toMatch(/no puedo/i);
    // Y el resultado final es el del turno bueno.
    expect(result.text).toBe("Ya lo he comprobado.");
    expect(eventsOfType(events, "tool.started")).toHaveLength(1);
  });

  it("suelta el texto en cuanto ve que NO es una excusa (la voz no espera)", async () => {
    const { runtime, events } = await harness(
      [
        { content: "Un índice vectorial guarda Embeddings y permite buscar por significado. " },
        { content: "Sigue así." },
      ],
      { fullCatalog: false },
    );
    await runtime.runTurn(ACTOR, "explícame qué es un índice vectorial");
    const deltas = eventsOfType(events, "assistant.delta");
    // El texto se emite por trozos (no de golpe al final): el TTS puede
    // empezar a hablar con la primera frase.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((event) => event.text).join("")).toMatch(/índice vectorial/i);
  });

  it("blocks destructive tools until the user approves", async () => {
    const { runtime, events } = await harness(
      [
        { toolCalls: [{ id: "c1", name: "task.delete", arguments: '{"id":"missing"}' }] },
        { content: "No eliminé nada." },
      ],
      { autoApprove: false },
    );
    const turn = runtime.runTurn(ACTOR, "borra la tarea missing");
    const approvalId = await new Promise<string>((resolve) => {
      const check = setInterval(() => {
        const event = eventsOfType(events, "tool.awaiting_approval")[0];
        if (event) {
          clearInterval(check);
          resolve(event.approvalId);
        }
      }, 10);
    });
    expect(eventsOfType(events, "assistant.state_changed").some((event) => event.state === "WAITING_FOR_APPROVAL")).toBe(true);
    await runtime.approvals.resolve(approvalId, false);
    await turn;
    const failed = eventsOfType(events, "tool.failed");
    expect(failed.at(-1)?.error).toMatch(/rechazada|expirada/);
    expect(eventsOfType(events, "tool.started")).toHaveLength(0);
  });

  it("executes destructive tools once approved", async () => {
    const steps: ConstructorParameters<typeof FakeProvider>[0] = [];
    const { runtime, events, memory } = await harness(steps, { autoApprove: false });
    const created = await memory.raw.createTask({ userId: "alice", title: "temporal", status: "open" });
    steps.push({ toolCalls: [{ id: "c1", name: "task.delete", arguments: JSON.stringify({ id: created.id }) }] });
    steps.push({ content: "Tarea eliminada." });

    const turn = runtime.runTurn(ACTOR, "borra la tarea temporal");
    const approvalId = await new Promise<string>((resolve) => {
      const check = setInterval(() => {
        const event = eventsOfType(events, "tool.awaiting_approval")[0];
        if (event) {
          clearInterval(check);
          resolve(event.approvalId);
        }
      }, 10);
    });
    await runtime.approvals.resolve(approvalId, true);
    await turn;

    expect(eventsOfType(events, "tool.started").some((event) => event.name === "task.delete")).toBe(true);
    expect(eventsOfType(events, "tool.completed").some((event) => event.name === "task.delete")).toBe(true);
    const remaining = await memory.raw.listTasks("alice", "open");
    expect(remaining.some((task) => task.id === created.id)).toBe(false);
  });

  it("guards against repeated identical tool calls", async () => {
    const { runtime, events } = await harness([
      { toolCalls: [{ id: "c1", name: "time.now", arguments: "{}" }] },
      { toolCalls: [{ id: "c2", name: "time.now", arguments: "{}" }] },
      { content: "Hora consultada." },
    ]);
    await runtime.runTurn(ACTOR, "qué hora es y otra vez");
    const failed = eventsOfType(events, "tool.failed");
    expect(failed.some((event) => event.error.includes("repetida"))).toBe(true);
    expect(eventsOfType(events, "tool.completed")).toHaveLength(1);
  });

  it("reports unknown tools as failures", async () => {
    const { runtime, events } = await harness([
      { toolCalls: [{ id: "c1", name: "does.not.exist", arguments: "{}" }] },
      { content: "Esa herramienta no existe." },
    ]);
    await runtime.runTurn(ACTOR, "usa la herramienta inexistente");
    expect(eventsOfType(events, "tool.failed")[0]?.error).toBe("unknown_tool");
  });

  it("cancels a running turn on request", async () => {
    const { runtime, events } = await harness([{ content: "respuesta lenta", delayMs: 5000 }]);
    const turn = runtime.runTurn(ACTOR, "responde despacio");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const taskId = runtime.activeTaskCount() === 1 ? [...findTaskId(runtime)] : [];
    expect(taskId.length).toBe(1);
    expect(runtime.cancel(taskId[0] as string)).toBe(true);
    const result = await turn;
    expect(result.text).toBe("");
    expect(eventsOfType(events, "task.cancelled")).toHaveLength(1);
    expect(eventsOfType(events, "assistant.state_changed").some((event) => event.state === "INTERRUPTED")).toBe(true);
  });

  it("persists an episodic memory for completed tasks", async () => {
    const { runtime, memory } = await harness([{ content: "Listo." }]);
    const result = await runtime.runTurn(ACTOR, "haz algo");
    const episodes = await memory.listEpisodes("alice");
    expect(episodes[0]?.outcome).toBe("completed");
    expect(result.taskId).toBeTruthy();
  });
});

function* findTaskId(runtime: AgentRuntime): Generator<string> {
  const internals = runtime as unknown as { tasks: Map<string, unknown> };
  for (const id of internals.tasks.keys()) yield id;
}

describe("razonamiento visible", () => {
  it("el runtime publica el razonamiento del modelo", async () => {
    const { runtime, events } = await harness([{ content: "Hola", reasoning: "El usuario saluda; respondo con un saludo." }]);
    await runtime.runTurn(ACTOR, "hola");
    const reasoning = eventsOfType(events, "assistant.reasoning");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning[0]?.text).toContain("respondo con un saludo");
  });

  it("no publica razonamiento vacío", async () => {
    const { runtime, events } = await harness([{ content: "Hola" }]);
    await runtime.runTurn(ACTOR, "hola");
    expect(eventsOfType(events, "assistant.reasoning")).toHaveLength(0);
  });
});
