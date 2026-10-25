import { InvalidStateError } from "./errors.js";
import {
  add,
  quatMultiply,
  quatNormalize,
  scale,
  ZERO_VEC3,
} from "./state-vector.js";
import type { Quat, StateVector, Vec3 } from "./types.js";

/** Paso temporal nominal del simulador: 1 kHz. */
export const DEFAULT_DT = 0.001;

/** Derivada de las variables de estado para un conjunto de entradas. */
export interface StateDerivative {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  angVel: Vec3;
}

function validateState(state: StateVector): void {
  if (!Number.isFinite(state.mass) || state.mass <= 0) {
    throw new InvalidStateError("La masa del estado debe ser un número positivo.");
  }
  const inertia = state.inertia;
  if (
    !Number.isFinite(inertia.x) ||
    !Number.isFinite(inertia.y) ||
    !Number.isFinite(inertia.z) ||
    inertia.x <= 0 ||
    inertia.y <= 0 ||
    inertia.z <= 0
  ) {
    throw new InvalidStateError("La inercia del estado debe tener componentes positivos.");
  }
}

/**
 * Calcula la derivada temporal del estado.
 *
 * La fuerza se considera aplicada en el marco inercial y el par en el marco
 * corporal. La velocidad angular evoluciona con una aceleración angular
 * diagonal y la cuaternión usa la derivada de quaternion corporal.
 */
export function stateDerivative(
  state: StateVector,
  forces: Vec3 = ZERO_VEC3,
  torque: Vec3 = ZERO_VEC3,
): StateDerivative {
  validateState(state);
  const acceleration = scale(forces, 1 / state.mass);
  const angularAcceleration: Vec3 = {
    x: torque.x / state.inertia.x,
    y: torque.y / state.inertia.y,
    z: torque.z / state.inertia.z,
  };
  const omega: Quat = { w: 0, x: state.angVel.x, y: state.angVel.y, z: state.angVel.z };
  const quaternionProduct = quatMultiply(state.quat, omega);
  const quaternionRate: Quat = {
    w: quaternionProduct.w * 0.5,
    x: quaternionProduct.x * 0.5,
    y: quaternionProduct.y * 0.5,
    z: quaternionProduct.z * 0.5,
  };
  return {
    pos: state.vel,
    vel: acceleration,
    quat: quaternionRate,
    angVel: angularAcceleration,
  };
}

function addDerivative(state: StateVector, derivative: StateDerivative, factor: number): StateVector {
  return {
    pos: add(state.pos, scale(derivative.pos, factor)),
    vel: add(state.vel, scale(derivative.vel, factor)),
    quat: {
      w: state.quat.w + derivative.quat.w * factor,
      x: state.quat.x + derivative.quat.x * factor,
      y: state.quat.y + derivative.quat.y * factor,
      z: state.quat.z + derivative.quat.z * factor,
    },
    angVel: add(state.angVel, scale(derivative.angVel, factor)),
    mass: state.mass,
    inertia: { ...state.inertia },
    thrust: { ...state.thrust },
    torque: { ...state.torque },
  };
}

function weightedState(
  state: StateVector,
  first: StateDerivative,
  second: StateDerivative,
  third: StateDerivative,
  fourth: StateDerivative,
  dt: number,
): StateVector {
  const factor = dt / 6;
  const position = add(
    state.pos,
    scale(
      add(
        add(scale(first.pos, 1), scale(second.pos, 2)),
        add(scale(third.pos, 2), scale(fourth.pos, 1)),
      ),
      factor,
    ),
  );
  const velocity = add(
    state.vel,
    scale(
      add(
        add(scale(first.vel, 1), scale(second.vel, 2)),
        add(scale(third.vel, 2), scale(fourth.vel, 1)),
      ),
      factor,
    ),
  );
  const quaternion = quatNormalize({
    w:
      state.quat.w +
      factor *
        (first.quat.w + 2 * second.quat.w + 2 * third.quat.w + fourth.quat.w),
    x:
      state.quat.x +
      factor *
        (first.quat.x + 2 * second.quat.x + 2 * third.quat.x + fourth.quat.x),
    y:
      state.quat.y +
      factor *
        (first.quat.y + 2 * second.quat.y + 2 * third.quat.y + fourth.quat.y),
    z:
      state.quat.z +
      factor *
        (first.quat.z + 2 * second.quat.z + 2 * third.quat.z + fourth.quat.z),
  });
  const angularVelocity = add(
    state.angVel,
    scale(
      add(
        add(scale(first.angVel, 1), scale(second.angVel, 2)),
        add(scale(third.angVel, 2), scale(fourth.angVel, 1)),
      ),
      factor,
    ),
  );
  return {
    pos: position,
    vel: velocity,
    quat: quaternion,
    angVel: angularVelocity,
    mass: state.mass,
    inertia: { ...state.inertia },
    thrust: { ...state.thrust },
    torque: { ...state.torque },
  };
}

/**
 * Avanza el estado un paso fijo mediante Runge-Kutta de cuarto orden.
 *
 * Las entradas se consideran constantes durante el paso. La masa y la
 * inercia se conservan exactamente y la orientación se normaliza al final de
 * la integración para que no se acumule deriva numérica.
 */
export function step(
  state: StateVector,
  dt: number = DEFAULT_DT,
  forces: Vec3 = ZERO_VEC3,
  torque: Vec3 = ZERO_VEC3,
): StateVector {
  if (!Number.isFinite(dt) || dt <= 0) {
    throw new InvalidStateError("El paso temporal debe ser un número positivo y finito.");
  }
  validateState(state);
  const first = stateDerivative(state, forces, torque);
  const secondState = addDerivative(state, first, dt / 2);
  const second = stateDerivative(secondState, forces, torque);
  const thirdState = addDerivative(state, second, dt / 2);
  const third = stateDerivative(thirdState, forces, torque);
  const fourthState = addDerivative(state, third, dt);
  const fourth = stateDerivative(fourthState, forces, torque);
  const integrated = weightedState(state, first, second, third, fourth, dt);
  return {
    ...integrated,
    thrust: { ...forces },
    torque: { ...torque },
  };
}

/** Alias explícito para el integrador RK4 de paso fijo. */
export const rk4Step = step;
