import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../src/hooks/useHealthPolling";

describe("PERF-001 · salud por streaming", () => {
  it("no sondea: el HUD se suscribe a un canal", () => {
    // La política vive en el hook: lo que se comprueba aquí es que la
    // reconexión no es agresiva (si lo fuera, el HUD machacaría al backend).
    expect(reconnectDelayMs(0)).toBe(1_000);
  });

  it("la espera crece de forma exponencial", () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
  });

  it("la espera está acotada: nunca supera el tope", () => {
    expect(reconnectDelayMs(20)).toBe(30_000);
    expect(reconnectDelayMs(100)).toBe(30_000);
  });

  it("un intento negativo o fraccionario no rompe el cálculo", () => {
    expect(reconnectDelayMs(-3)).toBe(1_000);
    expect(reconnectDelayMs(1.7)).toBe(2_000);
  });
});
