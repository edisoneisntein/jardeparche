import { describe, expect, it } from "vitest";
import { ALWAYS_AVAILABLE_TOOLS, isRawToolCall, summariseToolOutput } from "./runtime.js";

describe("detección de llamadas a tool escritas en crudo", () => {
  it("reconoce el patrón que emite el modelo", () => {
    expect(isRawToolCall('web.search(query="próximo partido selección Colombia fecha")')).toBe(true);
    expect(isRawToolCall("time.now()")).toBe(true);
    expect(isRawToolCall('math.calculate(expression="17*23")')).toBe(true);
  });

  it("no confunde una respuesta normal con una llamada", () => {
    expect(isRawToolCall("Sí, te escucho perfectamente. ¿En qué puedo ayudarte?")).toBe(false);
    expect(isRawToolCall("**Hora actual (según el sistema):** martes, 20 de octubre de 2026")).toBe(false);
    expect(isRawToolCall("La capital de Francia es París.")).toBe(false);
    expect(isRawToolCall("código()")).toBe(false);
  });

  it("ignora textos largos o sin forma de llamada", () => {
    expect(isRawToolCall("x".repeat(500) + "()")).toBe(false);
    expect(isRawToolCall("")).toBe(false);
  });
});

describe("tools siempre disponibles", () => {
  it("la búsqueda web nunca se poda", () => {
    // Sin esto, una pregunta que solo activa la señal de la hora dejaba al
    // modelo sin herramienta de búsqueda y respondía con la hora.
    expect(ALWAYS_AVAILABLE_TOOLS).toContain("web.search");
    expect(ALWAYS_AVAILABLE_TOOLS).toContain("web.fetch");
  });
});

describe("resumen de salida de tool", () => {
  it("usa el summary cuando existe", () => {
    const raw = JSON.stringify({ ok: true, summary: "5 resultado(s)", data: { results: [1, 2] } });
    expect(summariseToolOutput(raw)).toBe("5 resultado(s)");
  });

  it("informa del error cuando la tool falló", () => {
    expect(summariseToolOutput(JSON.stringify({ ok: false, error: "invalid_timezone" }))).toBe("La herramienta falló: invalid_timezone");
  });

  it("degrada con elegancia ante una salida no-JSON", () => {
    expect(summariseToolOutput("texto plano")).toBe("texto plano");
  });
});
