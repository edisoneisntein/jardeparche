import { ThrustAllocationError } from "./errors.js";
import { cross, norm, normalize, sub } from "./state-vector.js";
import type { Vec3 } from "./types.js";

/**
 * Descripción de un propulsor individual.
 *
 * La posición y la dirección están expresadas en el marco corporal. La
 * dirección `direction` es la que sigue el flujo de empuje al aumentar el
 * valor del motor. Se aceptan `thrustDirection` y `axis` como alias para
 * facilitar la integración con modelos externos.
 */
export interface ThrustMotor {
  position: Vec3;
  direction?: Vec3;
  thrustDirection?: Vec3;
  axis?: Vec3;
  minThrust?: number;
  maxThrust?: number;
}

/** Límites globales de la distribución de empuje. */
export interface ThrustLimits {
  minThrust?: number;
  maxThrust?: number;
  min?: number;
  max?: number;
  maxForce?: number;
  maxTorque?: number;
}

/** Esfuerzo de seis componentes que se intenta producir con los propulsores. */
export interface DesiredWrench {
  force: Vec3;
  torque: Vec3;
}

/** Estado de saturación de la distribución de empuje. */
export interface ThrustSaturation {
  saturated: boolean;
  saturatedMotors: number[];
  residualForce: Vec3;
  residualTorque: Vec3;
}

/** Resultado completo de una asignación de empuje. */
export interface ThrustAllocationResult {
  /** Empuje individual de cada motor, en el mismo orden que `motors`. */
  thrusts: number[];
  /** Alias del resultado anterior para consumidores que usan esa denominación. */
  motorThrusts: number[];
  /** Fuerza realmente reproducecible en el marco corporal. */
  force: Vec3;
  /** Par realmente reproducecible en el marco corporal. */
  torque: Vec3;
  /** Indica si se ha perdido alguna componente del esfuerzo solicitado. */
  saturated: boolean;
  /** Detalle de los motores limitados y del residuo no asignado. */
  saturation: ThrustSaturation;
  /** Matriz 6×N utilizada durante la asignación. */
  matrix: number[][];
}

function motorDirection(motor: ThrustMotor): Vec3 {
  const candidate = motor.direction ?? motor.thrustDirection ?? motor.axis;
  if (candidate === undefined) {
    throw new ThrustAllocationError(
      "Cada motor debe definir `direction`, `thrustDirection` o `axis`.",
    );
  }
  const unit = normalize(candidate);
  if (norm(unit) <= Number.EPSILON) {
    throw new ThrustAllocationError("La dirección de un motor no puede ser nula.");
  }
  return unit;
}

/**
 * Construye la matriz de asignación 6×N.
 *
 * Las tres primeras filas son fuerza en los ejes corporal x, y y z; las tres
 * siguientes son par alrededor de esos mismos ejes. La columna de un motor es
 * la concatenación de su dirección de fuerza y el momento `posición × fuerza`.
 */
export function buildThrustAllocationMatrix(motors: readonly ThrustMotor[]): number[][] {
  if (motors.length === 0) {
    throw new ThrustAllocationError("Debe existir al menos un motor para asignar empuje.");
  }
  const columns = motors.map((motor) => {
    const direction = motorDirection(motor);
    const torque = cross(motor.position, direction);
    return [
      direction.x,
      direction.y,
      direction.z,
      torque.x,
      torque.y,
      torque.z,
    ];
  });
  return Array.from({ length: 6 }, (_, row) =>
    columns.map((column) => column[row] ?? 0),
  );
}

/** Alias con el nombre habitual de la matriz de asignación de propulsores. */
export const buildThrustMatrix = buildThrustAllocationMatrix;

function transpose(matrix: readonly (readonly number[])[]): number[][] {
  const rows = matrix.length;
  const columns = matrix[0]?.length ?? 0;
  const result: number[][] = Array.from({ length: columns }, () => Array<number>(rows).fill(0));
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const value = matrix[row]?.[column];
      if (value !== undefined) {
        const target = result[column];
        if (target !== undefined) {
          target[row] = value;
        }
      }
    }
  }
  return result;
}

function multiplyMatrixVector(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  return matrix.map((row) => {
    let sum = 0;
    for (let column = 0; column < row.length; column += 1) {
      sum += (row[column] ?? 0) * (vector[column] ?? 0);
    }
    return sum;
  });
}

function multiplyMatrices(
  left: readonly (readonly number[])[],
  right: readonly (readonly number[])[],
): number[][] {
  const rightColumns = right[0]?.length ?? 0;
  return left.map((leftRow) => {
    const result: number[] = [];
    for (let column = 0; column < rightColumns; column += 1) {
      let sum = 0;
      for (let index = 0; index < leftRow.length; index += 1) {
        sum += (leftRow[index] ?? 0) * (right[index]?.[column] ?? 0);
      }
      result.push(sum);
    }
    return result;
  });
}

function identityMatrix(size: number): number[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function invertMatrix(matrix: readonly (readonly number[])[]): number[][] {
  const size = matrix.length;
  const identity = identityMatrix(size);
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...(identity[rowIndex] ?? []),
  ]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotMagnitude = Math.abs(augmented[column]?.[column] ?? 0);
    for (let row = column + 1; row < size; row += 1) {
      const magnitude = Math.abs(augmented[row]?.[column] ?? 0);
      if (magnitude > pivotMagnitude) {
        pivotMagnitude = magnitude;
        pivotRow = row;
      }
    }
    if (pivotMagnitude <= 1e-12) {
      throw new ThrustAllocationError("La matriz de asignación de empuje no es invertible.");
    }
    if (pivotRow !== column) {
      const current = augmented[column];
      const replacement = augmented[pivotRow];
      if (current !== undefined && replacement !== undefined) {
        augmented[column] = replacement;
        augmented[pivotRow] = current;
      }
    }

    const pivot = augmented[column];
    if (pivot === undefined) {
      throw new ThrustAllocationError("No se pudo construir la distribución de empuje.");
    }
    const pivotValue = pivot[column] ?? 0;
    for (let item = column; item < size * 2; item += 1) {
      pivot[item] = (pivot[item] ?? 0) / pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = augmented[row]?.[column] ?? 0;
      if (Math.abs(factor) <= 1e-15) {
        continue;
      }
      for (let item = column; item < size * 2; item += 1) {
        const rowValues = augmented[row];
        const pivotValues = augmented[column];
        if (rowValues !== undefined && pivotValues !== undefined) {
          rowValues[item] = (rowValues[item] ?? 0) - factor * (pivotValues[item] ?? 0);
        }
      }
    }
  }

  return augmented.map((row) => row.slice(size));
}

/**
 * Calcula una pseudo-inversa regularizada mediante `B(BᵀB + λI)⁻¹Bᵀ`.
 *
 * La regularización mantiene estable el cálculo cuando hay más motores que
 * grados de libertad o cuando dos propulsores son colineales. Para una
 * matriz bien condicionada, el resultado coincide con la pseudo-inversa de
 * Moore-Penrose dentro de la precisión numérica de la simulación.
 */
function pseudoInverse(matrix: readonly (readonly number[])[]): number[][] {
  const rows = matrix.length;
  const columns = matrix[0]?.length ?? 0;
  if (rows === 0 || columns === 0) {
    return [];
  }
  const transposed = transpose(matrix);
  const gram = multiplyMatrices(matrix, transposed);
  let scale = 0;
  for (let index = 0; index < gram.length; index += 1) {
    scale = Math.max(scale, Math.abs(gram[index]?.[index] ?? 0));
  }
  const regularization = Math.max(scale * 1e-8, 1e-10);
  const regularized = gram.map((row, rowIndex) =>
    row.map((value, columnIndex) => value + (rowIndex === columnIndex ? regularization : 0)),
  );
  const inverse = invertMatrix(regularized);
  const projected = multiplyMatrices(inverse, matrix);
  return multiplyMatrices(transposed, projected);
}

interface CachedAllocationSystem {
  signature: string;
  matrix: number[][];
  inverse: number[][];
}

const allocationSystemCache = new WeakMap<object, CachedAllocationSystem>();

function motorSignature(motors: readonly ThrustMotor[]): string {
  return motors
    .map((motor) => {
      const direction = motorDirection(motor);
      return [
        motor.position.x,
        motor.position.y,
        motor.position.z,
        direction.x,
        direction.y,
        direction.z,
      ].join(",");
    })
    .join(";");
}

function cachedAllocationSystem(
  motors: readonly ThrustMotor[],
): CachedAllocationSystem {
  const signature = motorSignature(motors);
  const cached = allocationSystemCache.get(motors);
  if (cached !== undefined && cached.signature === signature) {
    return cached;
  }
  const matrix = buildThrustAllocationMatrix(motors);
  const system: CachedAllocationSystem = {
    signature,
    matrix,
    inverse: pseudoInverse(matrix),
  };
  allocationSystemCache.set(motors, system);
  return system;
}

function wrenchToArray(wrench: DesiredWrench): number[] {
  return [
    wrench.force.x,
    wrench.force.y,
    wrench.force.z,
    wrench.torque.x,
    wrench.torque.y,
    wrench.torque.z,
  ];
}

function arrayToForce(values: readonly number[]): Vec3 {
  return { x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0 };
}

function arrayToTorque(values: readonly number[]): Vec3 {
  return { x: values[3] ?? 0, y: values[4] ?? 0, z: values[5] ?? 0 };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function vectorNorm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function columnAt(matrix: readonly (readonly number[])[], column: number): number[] {
  return matrix.map((row) => row[column] ?? 0);
}

function columnDotVector(column: readonly number[], vector: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < column.length; index += 1) {
    sum += (column[index] ?? 0) * (vector[index] ?? 0);
  }
  return sum;
}

/**
 * Distribuye un esfuerzo arbitrario entre varios propulsores.
 *
 * El algoritmo sigue tres etapas: obtiene una primera solución con una
 * pseudo-inversa, satura cada motor dentro de sus límites y redistribuye el
 * residuo entre los motores que todavía tienen margen. La redistribución se
 * itera con una pseudo-inversa de las columnas activas y, como refinamiento,
 * con pasos coordenados que reducen el error sin permitir valores fuera de
 * rango.
 */
export function solveThrustAllocation(
  desiredWrench: DesiredWrench,
  motors: readonly ThrustMotor[],
  limits: ThrustLimits = {},
): ThrustAllocationResult {
  if (motors.length === 0) {
    throw new ThrustAllocationError("Debe existir al menos un motor para asignar empuje.");
  }
  const system = cachedAllocationSystem(motors);
  const matrix = system.matrix;
  const globalMinimum = limits.minThrust ?? limits.min ?? 0;
  const globalMaximum = limits.maxThrust ?? limits.max ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(globalMinimum) || globalMinimum < 0) {
    throw new ThrustAllocationError("El empuje mínimo global debe ser un número no negativo.");
  }
  if (Number.isNaN(globalMaximum) || globalMaximum < globalMinimum) {
    throw new ThrustAllocationError("El empuje máximo global no puede ser menor que el mínimo.");
  }

  const minimums: number[] = [];
  const maximums: number[] = [];
  motors.forEach((motor, index) => {
    const minimum = Math.max(globalMinimum, motor.minThrust ?? globalMinimum);
    const maximum = Math.min(globalMaximum, motor.maxThrust ?? globalMaximum);
    if (
      !Number.isFinite(minimum) ||
      minimum < 0 ||
      Number.isNaN(maximum) ||
      maximum < minimum
    ) {
      throw new ThrustAllocationError(
        `Los límites del motor ${index} no forman un intervalo válido.`,
      );
    }
    minimums.push(minimum);
    maximums.push(maximum);
  });

  const desired = wrenchToArray(desiredWrench);
  const initial = multiplyMatrixVector(system.inverse, desired);
  const thrusts = initial.map((value, index) =>
    clamp(value, minimums[index] ?? globalMinimum, maximums[index] ?? globalMaximum),
  );

  let residual = subArrays(desired, multiplyMatrixVector(matrix, thrusts));
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const activeIndices: number[] = [];
    for (let index = 0; index < thrusts.length; index += 1) {
      const current = thrusts[index] ?? 0;
      const minimum = minimums[index] ?? globalMinimum;
      const maximum = maximums[index] ?? globalMaximum;
      if (current > minimum + 1e-9 || current < maximum - 1e-9) {
        activeIndices.push(index);
      }
    }
    if (activeIndices.length === 0 || vectorNorm(residual) <= 1e-8) {
      break;
    }
    const activeMatrix = transpose(
      activeIndices.map((index) => columnAt(matrix, index)),
    );
    const activeInverse = pseudoInverse(activeMatrix);
    const correction = multiplyMatrixVector(activeInverse, residual);
    let changed = false;
    activeIndices.forEach((motorIndex, activeIndex) => {
      const oldValue = thrusts[motorIndex] ?? 0;
      const newValue = clamp(
        oldValue + (correction[activeIndex] ?? 0),
        minimums[motorIndex] ?? globalMinimum,
        maximums[motorIndex] ?? globalMaximum,
      );
      const delta = newValue - oldValue;
      if (Math.abs(delta) > 1e-10) {
        thrusts[motorIndex] = newValue;
        changed = true;
      }
    });
    residual = subArrays(desired, multiplyMatrixVector(matrix, thrusts));
    if (!changed) {
      break;
    }
  }

  for (let iteration = 0; iteration < 10; iteration += 1) {
    if (vectorNorm(residual) <= 1e-8) {
      break;
    }
    let changed = false;
    for (let index = 0; index < thrusts.length; index += 1) {
      const column = columnAt(matrix, index);
      const columnNormSquared = column.reduce((sum, value) => sum + value * value, 0);
      if (columnNormSquared <= 1e-14) {
        continue;
      }
      const oldValue = thrusts[index] ?? 0;
      const candidate = oldValue + columnDotVector(column, residual) / columnNormSquared;
      const newValue = clamp(
        candidate,
        minimums[index] ?? globalMinimum,
        maximums[index] ?? globalMaximum,
      );
      const delta = newValue - oldValue;
      if (Math.abs(delta) > 1e-10) {
        thrusts[index] = newValue;
        const columnDelta = scaleArray(column, delta);
        residual = subArrays(residual, columnDelta);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const force = arrayToForce(multiplyMatrixVector(matrix, thrusts));
  const torque = arrayToTorque(multiplyMatrixVector(matrix, thrusts));
  const residualForce = sub(desiredWrench.force, force);
  const residualTorque = sub(desiredWrench.torque, torque);
  const residualMagnitude = Math.sqrt(
    residualForce.x * residualForce.x +
      residualForce.y * residualForce.y +
      residualForce.z * residualForce.z +
      residualTorque.x * residualTorque.x +
      residualTorque.y * residualTorque.y +
      residualTorque.z * residualTorque.z,
  );
  const saturatedMotors: number[] = [];
  thrusts.forEach((value, index) => {
    const minimum = minimums[index] ?? globalMinimum;
    const maximum = maximums[index] ?? globalMaximum;
    if (
      (value <= minimum + 1e-8 && residualMagnitude > 1e-7) ||
      (value >= maximum - 1e-8 && residualMagnitude > 1e-7)
    ) {
      saturatedMotors.push(index);
    }
  });
  const saturated = residualMagnitude > 1e-6 || saturatedMotors.length > 0;

  return {
    thrusts,
    motorThrusts: [...thrusts],
    force,
    torque,
    saturated,
    saturation: {
      saturated,
      saturatedMotors,
      residualForce,
      residualTorque,
    },
    matrix: matrix.map((row) => [...row]),
  };
}

function scaleArray(vector: readonly number[], factor: number): number[] {
  return vector.map((value) => value * factor);
}

function subArrays(left: readonly number[], right: readonly number[]): number[] {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, index) => (left[index] ?? 0) - (right[index] ?? 0));
}

/** Alias de la distribución de empuje con un nombre de uso frecuente. */
export const allocateThrust = solveThrustAllocation;
