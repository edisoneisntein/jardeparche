import { describe, expect, it } from "vitest";
import { createController } from "./controller.js";
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

describe("controlador en cascada", () => {
  it("genera empuje ascendente para mantener el hover", () => {
    const controller = createController();
    const output = controller.compute(state(), { pos: { x: 0, y: 0, z: 10 } }, "hover");
    expect(output.desiredForce.z).toBeGreaterThan(0);
    expect(output.desiredTorque.x).toBeCloseTo(0, 6);
    expect(output.desiredTorque.y).toBeCloseTo(0, 6);
  });

  it("selecciona ganancias distintas para cada modo", () => {
    const controller = createController();
    const hover = controller.getGains("hover");
    const intercept = controller.getGains("intercept");
    expect(intercept.position.kp).toBeGreaterThan(hover.position.kp);
    expect(intercept.velocity.kp).toBeGreaterThan(hover.velocity.kp);
  });

  it("acepta un objetivo como vector o como estado de vuelo", () => {
    const vectorController = createController();
    const targetController = createController();
    const vectorOutput = vectorController.compute(state(), { x: 1, y: 2, z: 3 }, "hover");
    const targetOutput = targetController.compute(
      state(),
      { pos: { x: 1, y: 2, z: 3 } },
      "hover",
    );
    expect(vectorOutput.desiredVelocity.x).toBeCloseTo(targetOutput.desiredVelocity.x, 8);
  });

  it("limita la variación de la fuerza mediante el límite de slew", () => {
    const controller = createController({
      maxForceSlew: 100,
      dt: 0.1,
    });
    const first = controller.compute(state(), { pos: { x: 0, y: 0, z: 10 } }, "hover");
    const second = controller.compute(state(), { pos: { x: 100, y: 0, z: 10 } }, "hover");
    expect(Math.abs(second.desiredForce.x - first.desiredForce.x)).toBeLessThanOrEqual(10.001);
  });

  it("mantiene la salida dentro del límite de fuerza con saturación", () => {
    const controller = createController({ maxForce: 500 });
    const output = controller.compute(state(), { pos: { x: 1000, y: 0, z: 0 } }, "intercept");
    expect(Math.abs(output.desiredForce.x)).toBeLessThanOrEqual(500);
    expect(Math.abs(output.desiredForce.y)).toBeLessThanOrEqual(500);
    expect(Math.abs(output.desiredForce.z)).toBeLessThanOrEqual(500);
  });
});
