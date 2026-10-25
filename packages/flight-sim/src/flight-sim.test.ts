import { describe, expect, it } from "vitest";
import { createFlightSim, createDefaultState } from "./index.js";

function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

describe("simulador de vuelo", () => {
  it("converge al objetivo en hover en menos de 10 segundos", () => {
    const target = { x: 0, y: 0, z: 8 };
    const simulator = createFlightSim({
      initialState: createDefaultState(),
      target,
      mode: "hover",
      dt: 0.001,
    });
    for (let index = 0; index < 10000; index += 1) {
      simulator.step(0.001);
    }
    const state = simulator.getState();
    expect(distance(state.pos, target)).toBeLessThan(0.5);
    expect(Number.isFinite(state.pos.z)).toBe(true);
  });

  it("expone telemetría y permite reiniciar el estado", () => {
    const simulator = createFlightSim({ target: { x: 0, y: 0, z: 2 } });
    simulator.step(0.001);
    const telemetry = simulator.getTelemetry();
    expect(Number.isFinite(telemetry.speed)).toBe(true);
    expect(Number.isFinite(telemetry.altitude)).toBe(true);
    simulator.reset();
    expect(simulator.getState().pos.z).toBe(0);
  });
});
