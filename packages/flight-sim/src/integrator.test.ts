import { describe, expect, it } from "vitest";
import { DEFAULT_DT, step } from "./integrator.js";
import type { StateVector } from "./types.js";

function state(): StateVector {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { w: 1, x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    mass: 120,
    inertia: { x: 12, y: 15, z: 8 },
    thrust: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
  };
}

function quaternionNorm(quat: StateVector["quat"]): number {
  return Math.sqrt(quat.w * quat.w + quat.x * quat.x + quat.y * quat.y + quat.z * quat.z);
}

describe("integrador RK4", () => {
  it("usa 1 kHz como paso temporal por defecto", () => {
    expect(DEFAULT_DT).toBe(0.001);
  });

  it("integra una fuerza constante con alta precisión", () => {
    const initial = state();
    const next = step(initial, 0.01, { x: 120, y: 0, z: 0 });
    expect(next.vel.x).toBeCloseTo(0.01, 10);
    expect(next.pos.x).toBeCloseTo(0.00005, 10);
    expect(next.mass).toBe(initial.mass);
    expect(next.inertia).toEqual(initial.inertia);
  });

  it("conserva la masa y normaliza la cuaternión durante 1000 pasos", () => {
    let current = state();
    for (let index = 0; index < 1000; index += 1) {
      current = step(current, DEFAULT_DT, { x: 0, y: 0, z: 0 }, { x: 0.1, y: 0.2, z: 0.3 });
      expect(quaternionNorm(current.quat)).toBeCloseTo(1, 8);
      expect(current.mass).toBe(120);
    }
  });

  it("no modifica el estado de entrada", () => {
    const initial = state();
    const copy = structuredClone(initial);
    step(initial, 0.01, { x: 1, y: 2, z: 3 });
    expect(initial).toEqual(copy);
  });
});
