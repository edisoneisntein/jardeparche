import { describe, expect, it } from "vitest";
import {
  add,
  cross,
  dot,
  integrateAngularVelocity,
  norm,
  normalize,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatToRotationMatrix,
  rotateBodyToWorld,
  scale,
  sub,
} from "./state-vector.js";
import type { Quat, StateVector } from "./types.js";

function quaternionNorm(quat: Quat): number {
  return Math.sqrt(quat.w * quat.w + quat.x * quat.x + quat.y * quat.y + quat.z * quat.z);
}

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

describe("operaciones vectoriales", () => {
  it("suma, resta y escala sin mutar las entradas", () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { x: 4, y: 5, z: 6 };
    expect(add(a, b)).toEqual({ x: 5, y: 7, z: 9 });
    expect(sub(b, a)).toEqual({ x: 3, y: 3, z: 3 });
    expect(scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("calcula productos escalar y vectorial", () => {
    expect(dot({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toBe(32);
    expect(cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
  });

  it("normaliza vectores y conserva el vector nulo", () => {
    expect(norm({ x: 3, y: 4, z: 0 })).toBe(5);
    const unit = normalize({ x: 3, y: 4, z: 0 });
    expect(unit.x).toBeCloseTo(0.6, 12);
    expect(unit.y).toBeCloseTo(0.8, 12);
    expect(unit.z).toBeCloseTo(0, 12);
    expect(normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("cuaterniones", () => {
  it("normaliza y compone rotaciones", () => {
    const first = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
    const second = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    const product = quatMultiply(first, second);
    expect(quaternionNorm(quatNormalize(product))).toBeCloseTo(1, 10);
    expect(quatNormalize({ w: 0, x: 0, y: 0, z: 0 })).toEqual({
      w: 1,
      x: 0,
      y: 0,
      z: 0,
    });
  });

  it("convierte una cuaternión en una matriz de rotación", () => {
    const matrix = quatToRotationMatrix({ w: 1, x: 0, y: 0, z: 0 });
    expect(matrix).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(rotateBodyToWorld({ x: 1, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 })).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
  });

  it("mantiene la cuaternión unitaria durante 1000 pasos", () => {
    let quat: Quat = { w: 1, x: 0, y: 0, z: 0 };
    for (let index = 0; index < 1000; index += 1) {
      quat = integrateAngularVelocity(quat, { x: 0.2, y: -0.1, z: 0.35 }, 0.001);
      expect(quaternionNorm(quat)).toBeCloseTo(1, 8);
    }
    expect(quaternionNorm(quat)).toBeCloseTo(1, 8);
  });
});
