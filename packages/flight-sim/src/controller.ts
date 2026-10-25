import { ControllerError } from "./errors.js";
import {
  add,
  dot,
  normalize,
  quatConjugate,
  quatMultiply,
  quatNormalize,
  quatFromUpAndForward,
  rotateBodyToWorld,
  scale,
  sub,
  ZERO_VEC3,
} from "./state-vector.js";
import type { FlightMode, FlightTarget, Quat, StateVector, Vec3 } from "./types.js";

/** Ganancias de un lazo PID y límites asociados al lazo. */
export interface PidGains {
  kp: number;
  ki: number;
  kd: number;
  integralLimit?: number;
  outputLimit?: number;
}

/** Ganancias de los cuatro lazos de un modo de vuelo. */
export interface ControllerModeGains {
  position: PidGains;
  velocity: PidGains;
  attitude: PidGains;
  angularVelocity: PidGains;
}

/** Forma parcial aceptada para gains de un modo. */
export interface ControllerModeGainsInput {
  position?: Partial<PidGains>;
  velocity?: Partial<PidGains>;
  attitude?: Partial<PidGains>;
  angularVelocity?: Partial<PidGains>;
}

/** Configuración del controlador en cascada. */
export interface ControllerConfig {
  /** Masa usada para convertir la aceleración comandada en fuerza de empuje. */
  mass?: number;
  /** Aceleración gravitatoria física; por defecto apunta hacia abajo. */
  gravity?: Vec3;
  dt?: number;
  modes?: Partial<Record<FlightMode, ControllerModeGainsInput>>;
  /** Alias de `modes` para configuraciones de controladores de terceros. */
  gains?: Partial<Record<FlightMode, ControllerModeGainsInput>>;
  maxForce?: number;
  maxTorque?: number;
  maxVelocity?: number;
  maxAcceleration?: number;
  maxAngularVelocity?: number;
  /** Límite de variación de la fuerza por segundo. */
  maxForceSlew?: number;
  /** Límite de variación del par por segundo. */
  maxTorqueSlew?: number;
  slewRate?: {
    force?: number;
    torque?: number;
  };
}

/** Salida del controlador en un instante de control. */
export interface ControllerOutput {
  desiredForce: Vec3;
  desiredTorque: Vec3;
  desiredVelocity: Vec3;
  desiredAcceleration: Vec3;
  desiredAngularVelocity: Vec3;
  mode: FlightMode;
}

/** Interfaz pública del controlador creado por `createController`. */
export interface FlightController {
  compute(
    state: StateVector,
    target: FlightTarget | Vec3,
    mode?: FlightMode,
    dt?: number,
  ): ControllerOutput;
  reset(): void;
  getGains(mode?: FlightMode): ControllerModeGains;
}

const DEFAULT_POSITION_GAINS: PidGains = {
  kp: 1.1,
  ki: 0.18,
  kd: 0.12,
  integralLimit: 8,
  outputLimit: 3,
};

const DEFAULT_VELOCITY_GAINS: PidGains = {
  kp: 5.5,
  ki: 1.2,
  kd: 0,
  integralLimit: 5,
  outputLimit: 4,
};

const DEFAULT_ATTITUDE_GAINS: PidGains = {
  kp: 4,
  ki: 0,
  kd: 0.2,
  integralLimit: 2,
};

const DEFAULT_ANGULAR_VELOCITY_GAINS: PidGains = {
  kp: 8,
  ki: 0,
  kd: 0.1,
  integralLimit: 3,
};

const DEFAULT_MODE_GAINS: Record<FlightMode, ControllerModeGains> = {
  hover: {
    position: DEFAULT_POSITION_GAINS,
    velocity: DEFAULT_VELOCITY_GAINS,
    attitude: DEFAULT_ATTITUDE_GAINS,
    angularVelocity: DEFAULT_ANGULAR_VELOCITY_GAINS,
  },
  cruise: {
    position: { kp: 0.85, ki: 0.12, kd: 0.08, integralLimit: 10, outputLimit: 18 },
    velocity: { kp: 4.2, ki: 0.8, kd: 1.8, integralLimit: 6, outputLimit: 6 },
    attitude: { kp: 5.5, ki: 0.2, kd: 0.7, integralLimit: 2 },
    angularVelocity: { kp: 9, ki: 0.15, kd: 2.2, integralLimit: 3 },
  },
  intercept: {
    position: { kp: 1.45, ki: 0.22, kd: 0.16, integralLimit: 8, outputLimit: 25 },
    velocity: { kp: 7.5, ki: 1.8, kd: 2.6, integralLimit: 5, outputLimit: 8 },
    attitude: { kp: 8.5, ki: 0.45, kd: 0.9, integralLimit: 2 },
    angularVelocity: { kp: 13, ki: 0.25, kd: 2.8, integralLimit: 3 },
  },
};

class ScalarPid {
  private integral = 0;
  private previousError: number | undefined;
  private gains: PidGains;

  public constructor(gains: PidGains) {
    this.gains = gains;
  }

  public setGains(gains: PidGains): void {
    this.gains = gains;
  }

  public update(error: number, dt: number, outputLimit: number): number {
    const safeDt = Math.max(dt, 1e-6);
    const integralLimit = Math.max(this.gains.integralLimit ?? 10, 0);
    const candidateIntegral = clamp(this.integral + error * safeDt, -integralLimit, integralLimit);
    const derivative = this.previousError === undefined ? 0 : (error - this.previousError) / safeDt;
    const unclamped =
      this.gains.kp * error + this.gains.ki * candidateIntegral + this.gains.kd * derivative;
    const output = clamp(unclamped, -outputLimit, outputLimit);
    const saturatedHigh = unclamped > outputLimit && error > 0;
    const saturatedLow = unclamped < -outputLimit && error < 0;
    if (saturatedHigh || saturatedLow) {
      this.integral = clamp(this.integral, -integralLimit, integralLimit);
    } else {
      this.integral = candidateIntegral;
    }
    this.previousError = error;
    return output;
  }

  public reset(): void {
    this.integral = 0;
    this.previousError = undefined;
  }
}

class VectorPid {
  private readonly x: ScalarPid;
  private readonly y: ScalarPid;
  private readonly z: ScalarPid;

  public constructor(gains: PidGains) {
    this.x = new ScalarPid(gains);
    this.y = new ScalarPid(gains);
    this.z = new ScalarPid(gains);
  }

  public update(error: Vec3, dt: number, outputLimit: number): Vec3 {
    return {
      x: this.x.update(error.x, dt, outputLimit),
      y: this.y.update(error.y, dt, outputLimit),
      z: this.z.update(error.z, dt, outputLimit),
    };
  }

  public setGains(gains: PidGains): void {
    this.x.setGains(gains);
    this.y.setGains(gains);
    this.z.setGains(gains);
  }

  public reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function clampMagnitude(vector: Vec3, maximum: number): Vec3 {
  const magnitude = Math.sqrt(dot(vector, vector));
  if (magnitude <= maximum || magnitude <= 1e-12) {
    return vector;
  }
  return scale(vector, maximum / magnitude);
}

function mergeGains(
  defaults: ControllerModeGains,
  overrides: ControllerModeGainsInput | undefined,
): ControllerModeGains {
  return {
    position: { ...defaults.position, ...(overrides?.position ?? {}) },
    velocity: { ...defaults.velocity, ...(overrides?.velocity ?? {}) },
    attitude: { ...defaults.attitude, ...(overrides?.attitude ?? {}) },
    angularVelocity: {
      ...defaults.angularVelocity,
      ...(overrides?.angularVelocity ?? {}),
    },
  };
}

function validatePidGains(name: string, gains: PidGains): void {
  const values = [gains.kp, gains.ki, gains.kd];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new ControllerError(`Las ganancias del lazo ${name} deben ser finitas.`);
  }
  if (
    gains.integralLimit !== undefined &&
    (!Number.isFinite(gains.integralLimit) || gains.integralLimit < 0)
  ) {
    throw new ControllerError(`El límite integral del lazo ${name} no es válido.`);
  }
  if (
    gains.outputLimit !== undefined &&
    (!Number.isFinite(gains.outputLimit) || gains.outputLimit < 0)
  ) {
    throw new ControllerError(`El límite de salida del lazo ${name} no es válido.`);
  }
}

function isFlightTarget(target: FlightTarget | Vec3): target is FlightTarget {
  return "pos" in target;
}

function normalizeTarget(target: FlightTarget | Vec3): FlightTarget {
  if (isFlightTarget(target)) {
    return target;
  }
  return { pos: target };
}

function quaternionError(desired: Quat, current: Quat): Vec3 {
  const relative = quatMultiply(quatNormalize(desired), quatConjugate(quatNormalize(current)));
  const sign = relative.w < 0 ? -1 : 1;
  const vector = { x: relative.x * sign, y: relative.y * sign, z: relative.z * sign };
  const sineHalf = Math.sqrt(dot(vector, vector));
  if (sineHalf <= 1e-9) {
    return { x: 0, y: 0, z: 0 };
  }
  const angle = 2 * Math.atan2(sineHalf, relative.w * sign);
  return scale(vector, angle / sineHalf);
}

function applySlew(
  current: Vec3,
  previous: Vec3 | undefined,
  maximumRate: number,
  dt: number,
): Vec3 {
  if (previous === undefined || maximumRate <= 0) {
    return current;
  }
  const difference = sub(current, previous);
  const magnitude = Math.sqrt(dot(difference, difference));
  const maximumChange = maximumRate * Math.max(dt, 0);
  if (magnitude <= maximumChange || magnitude <= 1e-12) {
    return current;
  }
  return add(previous, scale(difference, maximumChange / magnitude));
}

function desiredQuaternionForForce(
  state: StateVector,
  desiredForce: Vec3,
): Quat {
  const forceDirection = normalize(desiredForce);
  if (Math.sqrt(dot(forceDirection, forceDirection)) <= 1e-8) {
    return quatNormalize(state.quat);
  }
  const currentForward = rotateBodyToWorld({ x: 1, y: 0, z: 0 }, state.quat);
  return quatFromUpAndForward(forceDirection, currentForward);
}

/**
 * Crea un controlador PID en cascada.
 *
 * La cascada es posición → velocidad → actitud → velocidad angular → par. La
 * fuerza de salida representa el empuje total necesario, por lo que incluye
 * la compensación de gravedad. El par se expresa en el marco corporal.
 */
export function createController(config: ControllerConfig = {}): FlightController {
  const mass = config.mass ?? 120;
  const gravity = config.gravity ?? { x: 0, y: 0, z: -9.81 };
  const defaultDt = config.dt ?? 0.01;
  const maxForce = config.maxForce ?? 3000;
  const maxTorque = config.maxTorque ?? 500;
  const maxVelocity = config.maxVelocity ?? 30;
  const maxAcceleration = config.maxAcceleration ?? 8;
  const maxAngularVelocity = config.maxAngularVelocity ?? 4;
  const maximumForceSlew = config.maxForceSlew ?? config.slewRate?.force ?? 12000;
  const maximumTorqueSlew = config.maxTorqueSlew ?? config.slewRate?.torque ?? 6000;

  if (!Number.isFinite(mass) || mass <= 0) {
    throw new ControllerError("La masa configurada del controlador debe ser positiva.");
  }
  if (!Number.isFinite(defaultDt) || defaultDt <= 0) {
    throw new ControllerError("El paso temporal del controlador debe ser positivo.");
  }
  if (
    !Number.isFinite(maxForce) ||
    !Number.isFinite(maxTorque) ||
    !Number.isFinite(maxVelocity) ||
    !Number.isFinite(maxAcceleration) ||
    maxForce <= 0 ||
    maxTorque <= 0 ||
    maxVelocity <= 0 ||
    maxAcceleration <= 0
  ) {
    throw new ControllerError("Los límites del controlador deben ser positivos.");
  }
  if (
    !Number.isFinite(maximumForceSlew) ||
    !Number.isFinite(maximumTorqueSlew) ||
    maximumForceSlew < 0 ||
    maximumTorqueSlew < 0
  ) {
    throw new ControllerError("Los límites de variación del controlador no son válidos.");
  }
  if (
    !Number.isFinite(gravity.x) ||
    !Number.isFinite(gravity.y) ||
    !Number.isFinite(gravity.z)
  ) {
    throw new ControllerError("La gravedad configurada debe ser un vector finito.");
  }

  const gainsForMode = (mode: FlightMode): ControllerModeGains => {
    const defaults = DEFAULT_MODE_GAINS[mode];
    const configured = config.modes?.[mode] ?? config.gains?.[mode];
    const gains = mergeGains(defaults, configured);
    validatePidGains("posición", gains.position);
    validatePidGains("velocidad", gains.velocity);
    validatePidGains("actitud", gains.attitude);
    validatePidGains("velocidad angular", gains.angularVelocity);
    return gains;
  };

  const positionPid = new VectorPid(gainsForMode("hover").position);
  const velocityPid = new VectorPid(gainsForMode("hover").velocity);
  const attitudePid = new VectorPid(gainsForMode("hover").attitude);
  const angularVelocityPid = new VectorPid(gainsForMode("hover").angularVelocity);
  let previousForce: Vec3 | undefined;
  let previousTorque: Vec3 | undefined;
  let activeMode: FlightMode = "hover";

  const reset = (): void => {
    positionPid.reset();
    velocityPid.reset();
    attitudePid.reset();
    angularVelocityPid.reset();
    previousForce = undefined;
    previousTorque = undefined;
    activeMode = "hover";
  };

  const compute = (
    state: StateVector,
    target: FlightTarget | Vec3,
    mode: FlightMode = "hover",
    dt = defaultDt,
  ): ControllerOutput => {
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new ControllerError("El paso temporal de control debe ser positivo.");
    }
    if (activeMode !== mode) {
      positionPid.reset();
      velocityPid.reset();
      attitudePid.reset();
      angularVelocityPid.reset();
      activeMode = mode;
    }
    const gains = gainsForMode(mode);
    positionPid.setGains(gains.position);
    velocityPid.setGains(gains.velocity);
    attitudePid.setGains(gains.attitude);
    angularVelocityPid.setGains(gains.angularVelocity);
    const normalizedTarget = normalizeTarget(target);
    const positionError = sub(normalizedTarget.pos, state.pos);
    const targetVelocity = normalizedTarget.vel ?? ZERO_VEC3;
    const positionCorrection = positionPid.update(
      positionError,
      dt,
      gains.position.outputLimit ?? maxVelocity,
    );
    const desiredVelocity = clampMagnitude(
      add(targetVelocity, positionCorrection),
      maxVelocity,
    );
    const velocityError = sub(desiredVelocity, state.vel);
    const velocityCorrection = velocityPid.update(
      velocityError,
      dt,
      gains.velocity.outputLimit ?? maxAcceleration,
    );
    const desiredAcceleration = velocityCorrection;
    const desiredForceRaw = scale(sub(desiredAcceleration, gravity), mass);
    const desiredForce = clampMagnitude(desiredForceRaw, maxForce);

    const desiredQuaternion =
      normalizedTarget.quat ?? desiredQuaternionForForce(state, desiredForce);
    const attitudeError = quaternionError(desiredQuaternion, state.quat);
    const desiredAngularVelocityRaw = attitudePid.update(
      attitudeError,
      dt,
      gains.attitude.outputLimit ?? maxAngularVelocity,
    );
    const desiredAngularVelocity = {
      x: clamp(desiredAngularVelocityRaw.x, -maxAngularVelocity, maxAngularVelocity),
      y: clamp(desiredAngularVelocityRaw.y, -maxAngularVelocity, maxAngularVelocity),
      z: clamp(desiredAngularVelocityRaw.z, -maxAngularVelocity, maxAngularVelocity),
    };
    const angularError = sub(desiredAngularVelocity, state.angVel);
    const angularAcceleration = angularVelocityPid.update(
      angularError,
      dt,
      gains.angularVelocity.outputLimit ?? maxTorque,
    );
    const desiredTorqueRaw = {
      x: angularAcceleration.x * state.inertia.x,
      y: angularAcceleration.y * state.inertia.y,
      z: angularAcceleration.z * state.inertia.z,
    };
    const desiredTorqueMagnitude = Math.sqrt(dot(desiredTorqueRaw, desiredTorqueRaw));
    const desiredTorque =
      desiredTorqueMagnitude <= maxTorque || desiredTorqueMagnitude <= 1e-12
        ? desiredTorqueRaw
        : scale(desiredTorqueRaw, maxTorque / desiredTorqueMagnitude);

    const limitedForce = applySlew(
      desiredForce,
      previousForce,
      maximumForceSlew,
      dt,
    );
    const limitedTorque = applySlew(
      desiredTorque,
      previousTorque,
      maximumTorqueSlew,
      dt,
    );
    previousForce = limitedForce;
    previousTorque = limitedTorque;

    return {
      desiredForce: limitedForce,
      desiredTorque: limitedTorque,
      desiredVelocity,
      desiredAcceleration,
      desiredAngularVelocity,
      mode,
    };
  };

  return {
    compute,
    reset,
    getGains: (mode = "hover") => gainsForMode(mode),
  };
}
