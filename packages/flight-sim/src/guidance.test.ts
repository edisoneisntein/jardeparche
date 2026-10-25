import { describe, expect, it } from "vitest";
import {
  findNearestNeighbors,
  isSegmentCollisionFree,
  proportionalNavigation,
  purePursuit,
  rrtStar,
} from "./guidance.js";
import type { StateVector } from "./types.js";

function state(pos = { x: 0, y: 0, z: 0 }): StateVector {
  return {
    pos,
    vel: { x: 0, y: 0, z: 0 },
    quat: { w: 1, x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    mass: 120,
    inertia: { x: 12, y: 15, z: 8 },
    thrust: { x: 0, y: 0, z: 0 },
    torque: { x: 0, y: 0, z: 0 },
  };
}

describe("Pure Pursuit", () => {
  it("apunta al objetivo y converge en un lazo cinemático", () => {
    const target = { x: 10, y: 0, z: 0 };
    let current = state();
    for (let index = 0; index < 100; index += 1) {
      const command = purePursuit(current, target, { maxSpeed: 8 });
      current = {
        ...current,
        pos: {
          x: current.pos.x + command.desiredVelocity.x * 0.1,
          y: current.pos.y + command.desiredVelocity.y * 0.1,
          z: current.pos.z + command.desiredVelocity.z * 0.1,
        },
      };
    }
    expect(Math.hypot(current.pos.x - target.x, current.pos.y - target.y, current.pos.z - target.z)).toBeLessThan(0.5);
  });

  it("adapta el lookahead a la distancia y a la velocidad", () => {
    const near = purePursuit(state(), { x: 3, y: 0, z: 0 }, { lookahead: 4 });
    const far = purePursuit(state(), { x: 30, y: 0, z: 0 }, { lookahead: 4 });
    expect(near.lookaheadDistance).toBeLessThanOrEqual(far.lookaheadDistance);
    expect(far.desiredVelocity.x).toBeGreaterThan(0);
  });
});

describe("navegación proporcional", () => {
  it("calcula una aceleración lateral finita para un objetivo móvil", () => {
    const pursuer = state();
    const target: StateVector = {
      ...state({ x: 20, y: 5, z: 0 }),
      vel: { x: -5, y: 0, z: 0 },
    };
    const result = proportionalNavigation(pursuer, target, { navigationConstant: 4 });
    expect(Number.isFinite(result.desiredAcceleration.x)).toBe(true);
    expect(Number.isFinite(result.desiredAcceleration.y)).toBe(true);
    expect(result.missDistance).toBeGreaterThan(0);
    expect(result.closingSpeed).toBeGreaterThan(0);
  });
});

describe("RRT*", () => {
  it("encuentra un camino válido alrededor de un obstáculo", () => {
    const path = rrtStar(
      { x: -6, y: 0, z: 0 },
      { x: 6, y: 0, z: 0 },
      [{ type: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1.5 }],
      { seed: 7, maxIterations: 1800, stepSize: 0.8, goalTolerance: 0.5 },
    );
    expect(path).not.toBeNull();
    expect(path?.length).toBeGreaterThan(2);
    const repeatedPath = rrtStar(
      { x: -6, y: 0, z: 0 },
      { x: 6, y: 0, z: 0 },
      [{ type: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1.5 }],
      { seed: 7, maxIterations: 1800, stepSize: 0.8, goalTolerance: 0.5 },
    );
    expect(repeatedPath).toEqual(path);
    if (path !== null) {
      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1];
        const to = path[index];
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        if (from !== undefined && to !== undefined) {
          expect(
            isSegmentCollisionFree(from, to, [
              { type: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1.5 },
            ]),
          ).toBe(true);
        }
      }
    }
  });

  it("encuentra vecinos más cercanos y rechaza segmentos bloqueados", () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
    ];
    expect(findNearestNeighbors(nodes, { x: 0.5, y: 0, z: 0 }, 2)).toEqual([0, 1]);
    expect(
      isSegmentCollisionFree(
        { x: -3, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        [{ type: "sphere", center: { x: 0, y: 0, z: 0 }, radius: 1 }],
      ),
    ).toBe(false);
  });
});
