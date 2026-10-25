import { describe, expect, it } from "vitest";
import {
  buildThrustAllocationMatrix,
  solveThrustAllocation,
} from "./thrust-vectoring.js";
import type { ThrustMotor } from "./thrust-vectoring.js";

const singleMotor: ThrustMotor = {
  position: { x: 0, y: 0, z: 0 },
  direction: { x: 1, y: 0, z: 0 },
  maxThrust: 20,
};

describe("distribución de empuje", () => {
  it("construye una matriz 6×N con fuerza y momento", () => {
    const matrix = buildThrustAllocationMatrix([
      singleMotor,
      {
        position: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        maxThrust: 20,
      },
    ]);
    expect(matrix).toHaveLength(6);
    expect(matrix[0]).toHaveLength(2);
    expect(matrix[3]?.[1]).toBe(1);
  });

  it("resuelve un esfuerzo alcanzable con pseudo-inversa", () => {
    const result = solveThrustAllocation(
      { force: { x: 12, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 } },
      [singleMotor],
      { minThrust: 0, maxThrust: 20 },
    );
    expect(result.thrusts[0]).toBeCloseTo(12, 5);
    expect(result.force.x).toBeCloseTo(12, 5);
    expect(result.saturated).toBe(false);
  });

  it("respeta el límite de empuje de cada motor", () => {
    const result = solveThrustAllocation(
      { force: { x: 50, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 } },
      [singleMotor],
      { minThrust: 0, maxThrust: 20 },
    );
    expect(result.thrusts[0]).toBe(20);
    expect(result.thrusts.every((thrust) => thrust >= 0 && thrust <= 20)).toBe(true);
    expect(result.saturated).toBe(true);
    expect(result.saturation.saturatedMotors).toContain(0);
  });

  it("redistribuye el esfuerzo entre varios motores equivalentes", () => {
    const motors: ThrustMotor[] = [
      { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 10 },
      { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 10 },
    ];
    const result = solveThrustAllocation(
      { force: { x: 15, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 } },
      motors,
      { minThrust: 0, maxThrust: 10 },
    );
    expect(result.force.x).toBeCloseTo(15, 4);
    expect(result.thrusts[0]).toBeCloseTo(7.5, 4);
    expect(result.thrusts[1]).toBeCloseTo(7.5, 4);
  });
});
