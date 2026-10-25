import { AerodynamicsError } from "./errors.js";
import {
  add,
  dot,
  rotateBodyToWorld,
  rotateWorldToBody,
  scale,
  sub,
  ZERO_VEC3,
} from "./state-vector.js";
import type { AeroCoeffs, StateVector, Vec3, Wind } from "./types.js";

/**
 * Tabla bidimensional usada para interpolar un coeficiente en función de un
 * ángulo y del número de Mach.
 *
 * `values[ángulo][Mach]` contiene los valores medidos. Las filas y columnas
 * deben tener la misma longitud y todos los valores deben ser finitos.
 */
export interface LookupTable {
  alpha: readonly number[];
  mach: readonly number[];
  values: readonly (readonly number[])[];
}

/**
 * Perfil aerodinómico configurable del traje.
 *
 * Las magnitudes lineales están en metros, la densidad en kg/m³ y la
 * velocidad del sonido en m/s. Los coeficientes base se suman a las tablas
 * para permitir ajustar el perfil sin perder la forma de su respuesta.
 */
export interface AeroProfile {
  mass?: number;
  wingArea?: number;
  wingSpan?: number;
  chord?: number;
  density?: number;
  speedOfSound?: number;
  baseCoefficients?: AeroCoeffs;
  liftTable?: LookupTable;
  dragTable?: LookupTable;
  sideForceTable?: LookupTable;
  pitchMomentTable?: LookupTable;
  yawMomentTable?: LookupTable;
  rollMomentTable?: LookupTable;
}

/** Perfil resuelto con todos los valores obligatorios presentes. */
export interface ResolvedAeroProfile {
  mass: number;
  wingArea: number;
  wingSpan: number;
  chord: number;
  density: number;
  speedOfSound: number;
  baseCoefficients: AeroCoeffs;
  liftTable: LookupTable;
  dragTable: LookupTable;
  sideForceTable: LookupTable;
  pitchMomentTable: LookupTable;
  yawMomentTable: LookupTable;
  rollMomentTable: LookupTable;
}

/** Resultado de la evaluación aerodinámica en los marcos definidos por el modelo. */
export interface AeroForces {
  /** Fuerza total expresada en el marco inercial. */
  force: Vec3;
  /** Par total expresado en el marco corporal. */
  torque: Vec3;
}

const ALPHA_AXIS: readonly number[] = [
  -Math.PI / 6,
  -Math.PI / 12,
  -Math.PI / 36,
  0,
  Math.PI / 36,
  Math.PI / 12,
  Math.PI / 6,
];
const MACH_AXIS: readonly number[] = [0, 0.5, 1, 2];

/**
 * Tabla de sustentación del perfil por defecto.
 *
 * Los valores crecen con el ángulo de ataque hasta el régimen de máxima
 * eficiencia y luego disminuyen, como ocurre en un perfil con pérdida de
 * sustentación.
 */
export const DEFAULT_LIFT_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [0.02, 0.03, 0.05, 0.08],
    [0.18, 0.2, 0.24, 0.3],
    [0.55, 0.6, 0.68, 0.78],
    [0.95, 1, 1.08, 1.15],
    [1.2, 1.25, 1.3, 1.35],
    [0.9, 0.95, 1, 1.05],
    [0.12, 0.16, 0.2, 0.25],
  ],
};

/** Tabla de arrastre perfil/inducido del perfil por defecto. */
export const DEFAULT_DRAG_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [0.08, 0.08, 0.09, 0.12],
    [0.1, 0.11, 0.13, 0.18],
    [0.18, 0.2, 0.24, 0.31],
    [0.28, 0.31, 0.36, 0.45],
    [0.42, 0.46, 0.52, 0.63],
    [0.72, 0.78, 0.88, 1.02],
    [1.12, 1.2, 1.34, 1.5],
  ],
};

/** Tabla de fuerza lateral en función de la deriva. */
export const DEFAULT_SIDE_FORCE_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [-0.48, -0.5, -0.52, -0.55],
    [-0.32, -0.34, -0.36, -0.4],
    [-0.12, -0.13, -0.14, -0.16],
    [0, 0, 0, 0],
    [0.12, 0.13, 0.14, 0.16],
    [0.32, 0.34, 0.36, 0.4],
    [0.48, 0.5, 0.52, 0.55],
  ],
};

/** Tabla de momento de cabeceo. */
export const DEFAULT_PITCH_MOMENT_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [-0.18, -0.2, -0.23, -0.27],
    [-0.1, -0.11, -0.13, -0.16],
    [-0.035, -0.04, -0.05, -0.06],
    [0, 0, 0, 0],
    [0.035, 0.04, 0.05, 0.06],
    [0.1, 0.11, 0.13, 0.16],
    [0.18, 0.2, 0.23, 0.27],
  ],
};

/** Tabla de momento de guiñada. */
export const DEFAULT_YAW_MOMENT_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [-0.24, -0.25, -0.28, -0.32],
    [-0.15, -0.16, -0.18, -0.21],
    [-0.05, -0.055, -0.06, -0.07],
    [0, 0, 0, 0],
    [0.05, 0.055, 0.06, 0.07],
    [0.15, 0.16, 0.18, 0.21],
    [0.24, 0.25, 0.28, 0.32],
  ],
};

/** Tabla de momento de alabeo. */
export const DEFAULT_ROLL_MOMENT_TABLE: LookupTable = {
  alpha: ALPHA_AXIS,
  mach: MACH_AXIS,
  values: [
    [-0.32, -0.34, -0.36, -0.4],
    [-0.2, -0.21, -0.23, -0.26],
    [-0.06, -0.065, -0.07, -0.08],
    [0, 0, 0, 0],
    [0.06, 0.065, 0.07, 0.08],
    [0.2, 0.21, 0.23, 0.26],
    [0.32, 0.34, 0.36, 0.4],
  ],
};

/**
 * Perfil por defecto de un traje de vuelo tipo Iron Man.
 *
 * Sus dimensiones y masas son representativas de un vehículo de 120 kg con
 * una superficie alar de 1,2 m², y sus tablas cubren el rango subsónico y
 * transónico habitual de este tipo de pruebas.
 */
export const DEFAULT_AERO_PROFILE: AeroProfile = {
  mass: 120,
  wingArea: 1.2,
  wingSpan: 1.5,
  chord: 0.8,
  density: 1.225,
  speedOfSound: 343,
  baseCoefficients: {
    CL: 0,
    CD: 0.08,
    CY: 0,
    Cl: 0,
    Cm: 0,
    Cn: 0,
  },
  liftTable: DEFAULT_LIFT_TABLE,
  dragTable: DEFAULT_DRAG_TABLE,
  sideForceTable: DEFAULT_SIDE_FORCE_TABLE,
  pitchMomentTable: DEFAULT_PITCH_MOMENT_TABLE,
  yawMomentTable: DEFAULT_YAW_MOMENT_TABLE,
  rollMomentTable: DEFAULT_ROLL_MOMENT_TABLE,
};

/**
 * Crea un perfil a partir de los valores por defecto y de sus sustituciones.
 */
export function createAeroProfile(overrides: AeroProfile = {}): AeroProfile {
  const defaults = DEFAULT_AERO_PROFILE.baseCoefficients;
  const configured = overrides.baseCoefficients;
  return {
    ...DEFAULT_AERO_PROFILE,
    ...overrides,
    baseCoefficients: {
      CL: configured?.CL ?? defaults?.CL ?? 0,
      CD: configured?.CD ?? defaults?.CD ?? 0,
      CY: configured?.CY ?? defaults?.CY ?? 0,
      Cl: configured?.Cl ?? defaults?.Cl ?? 0,
      Cm: configured?.Cm ?? defaults?.Cm ?? 0,
      Cn: configured?.Cn ?? defaults?.Cn ?? 0,
    },
  };
}

function resolveProfile(profile?: AeroProfile): ResolvedAeroProfile {
  const resolved: ResolvedAeroProfile = {
    mass: profile?.mass ?? DEFAULT_AERO_PROFILE.mass ?? 120,
    wingArea: profile?.wingArea ?? DEFAULT_AERO_PROFILE.wingArea ?? 1.2,
    wingSpan: profile?.wingSpan ?? DEFAULT_AERO_PROFILE.wingSpan ?? 1.5,
    chord: profile?.chord ?? DEFAULT_AERO_PROFILE.chord ?? 0.8,
    density: profile?.density ?? DEFAULT_AERO_PROFILE.density ?? 1.225,
    speedOfSound:
      profile?.speedOfSound ?? DEFAULT_AERO_PROFILE.speedOfSound ?? 343,
    baseCoefficients: {
      CL: profile?.baseCoefficients?.CL ?? DEFAULT_AERO_PROFILE.baseCoefficients?.CL ?? 0,
      CD: profile?.baseCoefficients?.CD ?? DEFAULT_AERO_PROFILE.baseCoefficients?.CD ?? 0,
      CY: profile?.baseCoefficients?.CY ?? DEFAULT_AERO_PROFILE.baseCoefficients?.CY ?? 0,
      Cl: profile?.baseCoefficients?.Cl ?? DEFAULT_AERO_PROFILE.baseCoefficients?.Cl ?? 0,
      Cm: profile?.baseCoefficients?.Cm ?? DEFAULT_AERO_PROFILE.baseCoefficients?.Cm ?? 0,
      Cn: profile?.baseCoefficients?.Cn ?? DEFAULT_AERO_PROFILE.baseCoefficients?.Cn ?? 0,
    },
    liftTable: profile?.liftTable ?? DEFAULT_LIFT_TABLE,
    dragTable: profile?.dragTable ?? DEFAULT_DRAG_TABLE,
    sideForceTable: profile?.sideForceTable ?? DEFAULT_SIDE_FORCE_TABLE,
    pitchMomentTable: profile?.pitchMomentTable ?? DEFAULT_PITCH_MOMENT_TABLE,
    yawMomentTable: profile?.yawMomentTable ?? DEFAULT_YAW_MOMENT_TABLE,
    rollMomentTable: profile?.rollMomentTable ?? DEFAULT_ROLL_MOMENT_TABLE,
  };

  if (resolved.mass <= 0 || resolved.wingArea <= 0 || resolved.density <= 0) {
    throw new AerodynamicsError(
      "La masa, el área alar y la densidad del perfil deben ser positivas.",
    );
  }
  if (resolved.speedOfSound <= 0) {
    throw new AerodynamicsError("La velocidad del sonido debe ser positiva.");
  }
  return resolved;
}

function interpolateAxis(values: readonly number[], position: number): number {
  if (values.length === 0) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  const first = values[0];
  if (first === undefined) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  if (position <= first) {
    return first;
  }
  const last = values[values.length - 1];
  if (last === undefined) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  if (position >= last) {
    return last;
  }
  for (let index = 1; index < values.length; index += 1) {
    const right = values[index];
    const left = values[index - 1];
    if (right === undefined || left === undefined) {
      continue;
    }
    if (position <= right) {
      const interval = right - left;
      if (Math.abs(interval) <= Number.EPSILON) {
        return right;
      }
      const ratio = (position - left) / interval;
      return left + ratio * (right - left);
    }
  }
  return last;
}

interface AxisBracket {
  lower: number;
  upper: number;
  ratio: number;
}

function bracketAxis(values: readonly number[], position: number): AxisBracket {
  if (values.length === 0) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  if (position <= first) {
    return { lower: first, upper: first, ratio: 0 };
  }
  if (position >= last) {
    return { lower: last, upper: last, ratio: 0 };
  }
  for (let index = 1; index < values.length; index += 1) {
    const right = values[index];
    const left = values[index - 1];
    if (right === undefined || left === undefined) {
      continue;
    }
    if (position <= right) {
      const interval = right - left;
      const ratio = Math.abs(interval) <= Number.EPSILON ? 0 : (position - left) / interval;
      return { lower: left, upper: right, ratio };
    }
  }
  return { lower: last, upper: last, ratio: 0 };
}

function interpolateTable(table: LookupTable, angle: number, mach: number): number {
  if (!Number.isFinite(angle) || !Number.isFinite(mach)) {
    throw new AerodynamicsError("El ángulo y el Mach de una tabla deben ser finitos.");
  }
  if (table.alpha.length === 0 || table.mach.length === 0) {
    throw new AerodynamicsError("Una tabla aerodinámica no puede tener un eje vacío.");
  }
  const angleBracket = bracketAxis(table.alpha, angle);
  const machBracket = bracketAxis(table.mach, mach);
  let lowerRow: readonly number[] | undefined;
  let upperRow: readonly number[] | undefined;
  for (let index = 0; index < table.values.length; index += 1) {
    const row = table.values[index];
    if (row === undefined) {
      continue;
    }
    if (table.alpha[index] === angleBracket.lower) {
      lowerRow = row;
    }
    if (table.alpha[index] === angleBracket.upper) {
      upperRow = row;
    }
  }
  if (lowerRow === undefined || upperRow === undefined) {
    throw new AerodynamicsError("Las filas de una tabla aerodinámica no son consistentes.");
  }
  const lowerAtLowerMach = interpolateAxis(lowerRow, machBracket.lower);
  const lowerAtUpperMach = interpolateAxis(lowerRow, machBracket.upper);
  const upperAtLowerMach = interpolateAxis(upperRow, machBracket.lower);
  const upperAtUpperMach = interpolateAxis(upperRow, machBracket.upper);
  const lowerValue = lowerAtLowerMach + (lowerAtUpperMach - lowerAtLowerMach) * machBracket.ratio;
  const upperValue = upperAtLowerMach + (upperAtUpperMach - upperAtLowerMach) * machBracket.ratio;
  return lowerValue + (upperValue - lowerValue) * angleBracket.ratio;
}

function profileArgument(
  machOrProfile: number | AeroProfile | undefined,
  profile: AeroProfile | undefined,
): { mach: number; profile: AeroProfile | undefined } {
  if (typeof machOrProfile === "number") {
    return { mach: machOrProfile, profile };
  }
  return { mach: 0, profile: machOrProfile ?? profile };
}

/**
 * Coeficiente de sustentación interpolado a partir del ángulo de ataque y
 * del número de Mach.
 */
export function coefAlphaToLift(
  alpha: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.liftTable, alpha, argumentsValue.mach) + resolved.baseCoefficients.CL;
}

/**
 * Coeficiente de arrastre interpolado a partir del ángulo de ataque y del
 * número de Mach.
 */
export function coefAlphaToDrag(
  alpha: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.dragTable, alpha, argumentsValue.mach) + resolved.baseCoefficients.CD;
}

/**
 * Coeficiente de fuerza lateral interpolado a partir de la deriva.
 */
export function coefBetaToSideForce(
  beta: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.sideForceTable, beta, argumentsValue.mach) + resolved.baseCoefficients.CY;
}

/**
 * Coeficiente de momento de cabeceo interpolado a partir del ángulo de
 * ataque.
 */
export function coefAlphaToPitchMoment(
  alpha: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.pitchMomentTable, alpha, argumentsValue.mach) + resolved.baseCoefficients.Cm;
}

/**
 * Coeficiente de momento de guiñada interpolado a partir de la deriva.
 */
export function coefBetaToYawMoment(
  beta: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.yawMomentTable, beta, argumentsValue.mach) + resolved.baseCoefficients.Cn;
}

/**
 * Coeficiente de momento de alabeo interpolado a partir del ángulo de
 * alabeo.
 */
export function coefRollToRollMoment(
  roll: number,
  machOrProfile?: number | AeroProfile,
  profile?: AeroProfile,
): number {
  const argumentsValue = profileArgument(machOrProfile, profile);
  const resolved = resolveProfile(argumentsValue.profile);
  return interpolateTable(resolved.rollMomentTable, roll, argumentsValue.mach) + resolved.baseCoefficients.Cl;
}

/**
 * Calcula los coeficientes aerodinámicos instantáneos del estado.
 */
export function computeAeroCoefficients(
  state: StateVector,
  wind: Wind = ZERO_VEC3,
  profile?: AeroProfile,
): AeroCoeffs {
  const resolved = resolveProfile(profile);
  const relativeVelocity = sub(state.vel, wind);
  const bodyVelocity = rotateWorldToBody(relativeVelocity, state.quat);
  const speed = Math.sqrt(dot(relativeVelocity, relativeVelocity));
  const alpha =
    speed <= 1e-8 ? 0 : Math.atan2(-bodyVelocity.z, bodyVelocity.x);
  const beta = speed <= 1e-8 ? 0 : Math.atan2(bodyVelocity.y, bodyVelocity.x);
  const mach = speed / resolved.speedOfSound;
  return {
    CL: coefAlphaToLift(alpha, mach, resolved),
    CD: coefAlphaToDrag(alpha, mach, resolved),
    CY: coefBetaToSideForce(beta, mach, resolved),
    Cl: coefRollToRollMoment(0, mach, resolved),
    Cm: coefAlphaToPitchMoment(alpha, mach, resolved),
    Cn: coefBetaToYawMoment(beta, mach, resolved),
  };
}

/**
 * Calcula la fuerza y el par aerodinámico del vehículo.
 *
 * La velocidad del aire se evalúa en el marco corporal, mientras que la
 * fuerza devuelta se expresa en el marco inercial. El par se mantiene en el
 * marco corporal porque es el marco en el que se distribuyen los propulsores.
 */
export function computeAeroForces(
  state: StateVector,
  wind: Wind = ZERO_VEC3,
  profile?: AeroProfile,
): AeroForces {
  const resolved = resolveProfile(profile);
  const relativeVelocity = sub(state.vel, wind);
  const bodyVelocity = rotateWorldToBody(relativeVelocity, state.quat);
  const speed = Math.sqrt(dot(relativeVelocity, relativeVelocity));
  const alpha =
    speed <= 1e-8 ? 0 : Math.atan2(-bodyVelocity.z, bodyVelocity.x);
  const beta = speed <= 1e-8 ? 0 : Math.atan2(bodyVelocity.y, bodyVelocity.x);
  const mach = speed / resolved.speedOfSound;
  const dynamicPressure = 0.5 * resolved.density * speed * speed;

  const liftCoefficient = coefAlphaToLift(alpha, mach, resolved);
  const dragCoefficient = coefAlphaToDrag(alpha, mach, resolved);
  const sideForceCoefficient = coefBetaToSideForce(beta, mach, resolved);
  const pitchMomentCoefficient = coefAlphaToPitchMoment(alpha, mach, resolved);
  const yawMomentCoefficient = coefBetaToYawMoment(beta, mach, resolved);
  const rollMomentCoefficient = coefRollToRollMoment(0, mach, resolved);

  const dragMagnitude = dynamicPressure * resolved.wingArea * dragCoefficient;
  const dragForce = speed > 1e-8 ? scale(bodyVelocity, -dragMagnitude / speed) : { x: 0, y: 0, z: 0 };
  const liftForce = { x: 0, y: 0, z: dynamicPressure * resolved.wingArea * liftCoefficient };
  const forwardFlowRatio =
    speed <= 1e-8 ? 0 : Math.min(1, Math.max(0, bodyVelocity.x / speed));
  const sideForce = {
    x: 0,
    y: dynamicPressure * resolved.wingArea * sideForceCoefficient * forwardFlowRatio,
    z: 0,
  };
  const bodyForce = add(add(dragForce, liftForce), sideForce);
  const force = rotateBodyToWorld(bodyForce, state.quat);

  const torque = {
    x:
      dynamicPressure *
      resolved.wingArea *
      resolved.wingSpan *
      rollMomentCoefficient *
      forwardFlowRatio,
    y:
      dynamicPressure *
      resolved.wingArea *
      resolved.chord *
      pitchMomentCoefficient *
      forwardFlowRatio,
    z:
      dynamicPressure *
      resolved.wingArea *
      resolved.wingSpan *
      yawMomentCoefficient *
      forwardFlowRatio,
  };

  return { force, torque };
}
