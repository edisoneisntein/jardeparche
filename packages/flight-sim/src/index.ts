import { computeAeroForces, DEFAULT_AERO_PROFILE } from "./aerodynamics.js";
import type { AeroProfile } from "./aerodynamics.js";
import { createController } from "./controller.js";
import type { ControllerConfig, ControllerOutput, FlightController } from "./controller.js";
import { InvalidStateError } from "./errors.js";
import { step as integrateStep } from "./integrator.js";
import {
  rotateBodyToWorld,
  rotateWorldToBody,
  scale,
  sub,
  ZERO_VEC3,
} from "./state-vector.js";
import { solveThrustAllocation } from "./thrust-vectoring.js";
import type {
  DesiredWrench,
  ThrustAllocationResult,
  ThrustLimits,
  ThrustMotor,
} from "./thrust-vectoring.js";
import type {
  FlightMode,
  FlightTarget,
  StateVector,
  Telemetry,
  Vec3,
  Wind,
} from "./types.js";

export * from "./aerodynamics.js";
export * from "./controller.js";
export * from "./errors.js";
export * from "./guidance.js";
export * from "./integrator.js";
export * from "./state-vector.js";
export * from "./thrust-vectoring.js";
export * from "./types.js";

/** Configuración de una instancia del simulador de vuelo. */
export interface FlightSimConfig {
  initialState?: StateVector;
  target?: FlightTarget | Vec3;
  mode?: FlightMode;
  controller?: ControllerConfig;
  aeroProfile?: AeroProfile;
  motors?: readonly ThrustMotor[];
  thrustLimits?: ThrustLimits;
  wind?: Wind;
  /** Aceleración gravitatoria física; por defecto apunta hacia abajo. */
  gravity?: Vec3;
  dt?: number;
}

/** Interfaz de control de una instancia del simulador. */
export interface FlightSim {
  reset(state?: StateVector): void;
  step(dt?: number): StateVector;
  setTarget(target: FlightTarget | Vec3): void;
  getState(): StateVector;
  getTelemetry(): Telemetry;
  setMode(mode: FlightMode): void;
  getLastThrustAllocation(): ThrustAllocationResult | undefined;
  getLastCommand(): ControllerOutput | undefined;
}

/**
 * Estado inicial de un traje de 120 kg.
 *
 * La orientación es la identidad, por lo que el eje corporal `z` coincide con
 * la vertical ascendente del mundo.
 */
export function createDefaultState(): StateVector {
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

/**
 * Configuración de propulsores del traje por defecto.
 *
 * Cuatro propulsores verticales producen sustentación y los cuatro auxiliares
 * Los cuatro propulsores auxiliares aportan los grados de libertad necesarios
 * para generar fuerzas laterales y momentos de control. Todos los propulsores
 * tienen un empuje escalar no negativo y saturable de forma independiente.
 */
export const DEFAULT_MOTORS: readonly ThrustMotor[] = [
  { position: { x: 0.45, y: 0.45, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 500 },
  { position: { x: 0.45, y: -0.45, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 500 },
  { position: { x: -0.45, y: 0.45, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 500 },
  { position: { x: -0.45, y: -0.45, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxThrust: 500 },
  { position: { x: 0, y: 0.35, z: -0.25 }, direction: { x: 1, y: 0, z: 0 }, maxThrust: 250 },
  { position: { x: 0, y: -0.35, z: -0.25 }, direction: { x: -1, y: 0, z: 0 }, maxThrust: 250 },
  { position: { x: 0.35, y: 0, z: 0.25 }, direction: { x: 0, y: 1, z: 0 }, maxThrust: 250 },
  { position: { x: -0.35, y: 0, z: 0.25 }, direction: { x: 0, y: -1, z: 0 }, maxThrust: 250 },
];

function cloneState(state: StateVector): StateVector {
  return {
    pos: { ...state.pos },
    vel: { ...state.vel },
    quat: { ...state.quat },
    angVel: { ...state.angVel },
    mass: state.mass,
    inertia: { ...state.inertia },
    thrust: { ...state.thrust },
    torque: { ...state.torque },
  };
}

function cloneTarget(target: FlightTarget | Vec3): FlightTarget | Vec3 {
  if ("pos" in target) {
    return {
      pos: { ...target.pos },
      vel: target.vel === undefined ? undefined : { ...target.vel },
      quat: target.quat === undefined ? undefined : { ...target.quat },
    };
  }
  return { ...target };
}

function magnitude(vector: Vec3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

/**
 * Crea un simulador de vuelo completo.
 *
 * Cada paso combina el control en cascada, el modelo aerodinámico y la
 * distribución de empuje. La gravedad se aplica fuera del control como una
 * fuerza inercial; el controlador entrega el empuje necesario para
 * compensarla y sostener la maniobra.
 */
export function createFlightSim(config: FlightSimConfig = {}): FlightSim {
  const initialState = cloneState(config.initialState ?? createDefaultState());
  const motors = config.motors ?? DEFAULT_MOTORS;
  const limits = config.thrustLimits ?? { minThrust: 0, maxThrust: 500 };
  const aeroProfile = config.aeroProfile ?? DEFAULT_AERO_PROFILE;
  const gravity = config.gravity ?? { x: 0, y: 0, z: -9.81 };
  const wind = config.wind ?? ZERO_VEC3;
  const defaultDt = config.dt ?? 0.001;
  if (!Number.isFinite(defaultDt) || defaultDt <= 0) {
    throw new InvalidStateError("El paso temporal del simulador debe ser positivo.");
  }

  const controllerConfig: ControllerConfig = {
    ...(config.controller ?? {}),
    mass: initialState.mass,
    gravity,
    dt: defaultDt,
  };
  const controller: FlightController = createController(controllerConfig);
  let state = cloneState(initialState);
  let target = cloneTarget(config.target ?? { pos: { x: 0, y: 0, z: 0 } });
  let mode: FlightMode = config.mode ?? "hover";
  let lastAero = { force: ZERO_VEC3, torque: ZERO_VEC3 };
  let lastAllocation: ThrustAllocationResult | undefined;
  let lastCommand: ControllerOutput | undefined;
  let lastTotalForce = ZERO_VEC3;

  const reset = (newState?: StateVector): void => {
    state = cloneState(newState ?? initialState);
    controller.reset();
    lastAero = { force: ZERO_VEC3, torque: ZERO_VEC3 };
    lastAllocation = undefined;
    lastCommand = undefined;
    lastTotalForce = ZERO_VEC3;
  };

  const stepSimulation = (dt = defaultDt): StateVector => {
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new InvalidStateError("El paso temporal del simulador debe ser positivo.");
    }
    const command = controller.compute(state, target, mode, dt);
    lastCommand = command;
    lastAero = computeAeroForces(state, wind, aeroProfile);
    const desiredWrench: DesiredWrench = {
      force: rotateWorldToBody(command.desiredForce, state.quat),
      torque: command.desiredTorque,
    };
    lastAllocation = solveThrustAllocation(desiredWrench, motors, limits);
    const allocatedForce = rotateBodyToWorld(lastAllocation.force, state.quat);
    const gravitationalForce = scale(gravity, state.mass);
    const totalForce = {
      x: gravitationalForce.x + lastAero.force.x + allocatedForce.x,
      y: gravitationalForce.y + lastAero.force.y + allocatedForce.y,
      z: gravitationalForce.z + lastAero.force.z + allocatedForce.z,
    };
    const totalTorque = {
      x: lastAero.torque.x + lastAllocation.torque.x,
      y: lastAero.torque.y + lastAllocation.torque.y,
      z: lastAero.torque.z + lastAllocation.torque.z,
    };
    lastTotalForce = totalForce;
    const integrated = integrateStep(state, dt, totalForce, totalTorque);
    state = {
      ...integrated,
      thrust: allocatedForce,
      torque: lastAllocation.torque,
    };
    return cloneState(state);
  };

  const getTelemetry = (): Telemetry => {
    const bodyVelocity = rotateWorldToBody(state.vel, state.quat);
    const speed = magnitude(state.vel);
    const aoa = speed <= 1e-8
      ? 0
      : Math.atan2(-bodyVelocity.z, bodyVelocity.x) * (180 / Math.PI);
    const sideslip = speed <= 1e-8
      ? 0
      : Math.atan2(bodyVelocity.y, bodyVelocity.x) * (180 / Math.PI);
    const specificForce = scale(
      sub(lastTotalForce, scale(gravity, state.mass)),
      1 / state.mass,
    );
    const gLoad = magnitude(specificForce) / 9.81;
    const thrustTotal = lastAllocation?.thrusts.reduce((sum, value) => sum + value, 0) ?? 0;
    const maximumThrustTotal = motors.reduce((sum, motor) => {
      const motorMaximum = motor.maxThrust ?? limits.maxThrust ?? limits.max ?? 500;
      return sum + Math.min(motorMaximum, limits.maxThrust ?? limits.max ?? motorMaximum);
    }, 0);
    const thrustPct = maximumThrustTotal > 0
      ? Math.min(100, (thrustTotal / maximumThrustTotal) * 100)
      : 0;
    const altitude = state.pos.z;
    const tempC = 15 - 0.0065 * altitude;
    return {
      gLoad,
      aoa,
      sideslip,
      thrustPct,
      altitude,
      speed,
      tempC,
    };
  };

  return {
    reset,
    step: stepSimulation,
    setTarget: (newTarget: FlightTarget | Vec3): void => {
      target = cloneTarget(newTarget);
    },
    getState: (): StateVector => cloneState(state),
    getTelemetry,
    setMode: (newMode: FlightMode): void => {
      mode = newMode;
    },
    getLastThrustAllocation: (): ThrustAllocationResult | undefined => lastAllocation,
    getLastCommand: (): ControllerOutput | undefined => lastCommand,
  };
}
