import { describe, expect, it } from "vitest";
import {
  coefAlphaToDrag,
  coefAlphaToLift,
  coefAlphaToPitchMoment,
  coefBetaToSideForce,
  coefBetaToYawMoment,
  coefRollToRollMoment,
  computeAeroForces,
  createAeroProfile,
} from "./aerodynamics.js";
import type { StateVector } from "./types.js";

function stateWithVelocity(velocity: { x: number; y: number; z: number }): StateVector {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: velocity,
    quat: { w: 1, x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    mass: 120,
    inertia: { x: 12, y: 15, z: 8 },
    thrust: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
  };
}

describe("modelo aerodinámico", () => {
  it("interpola el coeficiente de sustentación con el ángulo de ataque", () => {
    const low = coefAlphaToLift(0);
    const high = coefAlphaToLift(0.12);
    expect(high).toBeGreaterThan(low);
    expect(Number.isFinite(coefAlphaToLift(0.12, 0.8))).toBe(true);
  });

  it("aumenta el arrastre con un ángulo de ataque alto", () => {
    expect(coefAlphaToDrag(0.4)).toBeGreaterThan(coefAlphaToDrag(0));
  });

  it("devuelve coeficientes laterales y de momento con signo coherente", () => {
    expect(coefBetaToSideForce(0.1)).toBeGreaterThan(0);
    expect(coefBetaToSideForce(-0.1)).toBeLessThan(0);
    expect(coefAlphaToPitchMoment(0.1)).toBeGreaterThan(0);
    expect(coefBetaToYawMoment(0.1)).toBeGreaterThan(0);
    expect(coefRollToRollMoment(0.1)).toBeGreaterThan(0);
  });

  it("aplica los coeficientes base de un perfil configurable", () => {
    const profile = createAeroProfile({
      baseCoefficients: {
        CL: 0.5,
        CD: 0.2,
        CY: 0,
        Cl: 0,
        Cm: 0,
        Cn: 0,
      },
    });
    expect(coefAlphaToLift(0, profile)).toBeCloseTo(
      coefAlphaToLift(0) + 0.5,
      8,
    );
    expect(coefAlphaToDrag(0, profile)).toBeCloseTo(
      coefAlphaToDrag(0) - 0.08 + 0.2,
      8,
    );
  });

  it("no genera fuerza en reposo y genera sustentación con velocidad", () => {
    const resting = computeAeroForces(stateWithVelocity({ x: 0, y: 0, z: 0 }));
    expect(resting.force).toEqual({ x: 0, y: 0, z: 0 });
    const moving = computeAeroForces(stateWithVelocity({ x: 30, y: 0, z: 0 }));
    expect(moving.force.z).toBeGreaterThan(0);
    expect(Number.isFinite(moving.force.x)).toBe(true);
  });
});
