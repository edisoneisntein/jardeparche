import { InvalidStateError } from "./errors.js";
import type { Mat3, Quat, Vec3 } from "./types.js";

/**
 * Devuelve un vector nulo reutilizable para los cálculos que no modifican sus
 * entradas. Las funciones de este módulo no mutan los objetos recibidos.
 */
export const ZERO_VEC3: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Suma dos vectores componente a componente.
 */
export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Resta `b` a `a` componente a componente.
 */
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Multiplica todos los componentes de un vector por un escalar.
 */
export function scale(vector: Vec3, factor: number): Vec3 {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

/**
 * Calcula el producto escalar entre dos vectores.
 */
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Calcula el producto vectorial de dos vectores mediante la regla de la mano
 * derecha.
 */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Calcula la norma euclídea de un vector.
 */
export function norm(vector: Vec3): number {
  return Math.sqrt(dot(vector, vector));
}

/**
 * Devuelve un vector con la misma dirección y norma uno.
 *
 * El vector nulo se conserva como nulo en lugar de producir `NaN`, porque se
 * usa como una posición algebraicamente válida en los casos en que una
 * dirección todavía no está definida.
 */
export function normalize(vector: Vec3): Vec3 {
  const length = norm(vector);
  if (length <= Number.EPSILON) {
    return { x: 0, y: 0, z: 0 };
  }
  return scale(vector, 1 / length);
}

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Add = add;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Sub = sub;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Scale = scale;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Dot = dot;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Cross = cross;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Norm = norm;

/** Alias explícito para facilitar la lectura de código que usa el prefijo `vec3`. */
export const vec3Normalize = normalize;

/**
 * Devuelve la conjugada de una cuaternión.
 */
export function quatConjugate(quat: Quat): Quat {
  return { w: quat.w, x: -quat.x, y: -quat.y, z: -quat.z };
}

/**
 * Multiplica dos cuaterniones usando la convención Hamilton.
 *
 * El orden es `quatMultiply(a, b)` y representa la composición `a` seguida de
 * `b` cuando ambas describen rotaciones activas.
 */
export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * Normaliza una cuaternión y devuelve la identidad cuando su norma es cero.
 *
 * La identidad es una representación segura para un estado mal inicializado y
 * evita que una sola magnitud inválida contamine todos los cálculos posteriores.
 */
export function quatNormalize(quat: Quat): Quat {
  const length = Math.sqrt(
    quat.w * quat.w + quat.x * quat.x + quat.y * quat.y + quat.z * quat.z,
  );
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    return { w: 1, x: 0, y: 0, z: 0 };
  }
  return {
    w: quat.w / length,
    x: quat.x / length,
    y: quat.y / length,
    z: quat.z / length,
  };
}

/**
 * Crea una cuaternión a partir de un eje y un ángulo en radianes.
 */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  if (!Number.isFinite(angle)) {
    throw new InvalidStateError("El ángulo de rotación debe ser un número finito.");
  }
  const unitAxis = normalize(axis);
  if (norm(unitAxis) <= Number.EPSILON) {
    return { w: 1, x: 0, y: 0, z: 0 };
  }
  const halfAngle = angle / 2;
  const sine = Math.sin(halfAngle);
  return {
    w: Math.cos(halfAngle),
    x: unitAxis.x * sine,
    y: unitAxis.y * sine,
    z: unitAxis.z * sine,
  };
}

/**
 * Convierte una cuaternión en una matriz de rotación 3×3.
 *
 * La matriz transforma componentes del marco corporal al marco inercial.
 */
export function quatToRotationMatrix(quat: Quat): Mat3 {
  const normalized = quatNormalize(quat);
  const { w, x, y, z } = normalized;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}

/**
 * Integra la velocidad angular corporal durante un intervalo de tiempo.
 *
 * La derivada de una cuaternión de orientación es `0,5 * q * omega`, donde
 * `omega` representa la velocidad angular en el marco corporal. La cuaternión
 * resultante se normaliza para conservar una orientación válida durante miles
 * de pasos de integración.
 */
export function integrateAngularVelocity(quat: Quat, angVel: Vec3, dt: number): Quat {
  if (!Number.isFinite(dt)) {
    throw new InvalidStateError("El paso temporal de integración debe ser finito.");
  }
  const normalized = quatNormalize(quat);
  const omega: Quat = { w: 0, x: angVel.x, y: angVel.y, z: angVel.z };
  const derivative = quatMultiply(normalized, omega);
  return quatNormalize({
    w: normalized.w + 0.5 * derivative.w * dt,
    x: normalized.x + 0.5 * derivative.x * dt,
    y: normalized.y + 0.5 * derivative.y * dt,
    z: normalized.z + 0.5 * derivative.z * dt,
  });
}

/**
 * Rota un vector del marco corporal al marco inercial.
 */
export function rotateBodyToWorld(vector: Vec3, quat: Quat): Vec3 {
  const rotation = quatToRotationMatrix(quat);
  return {
    x: (rotation[0]?.[0] ?? 0) * vector.x + (rotation[0]?.[1] ?? 0) * vector.y + (rotation[0]?.[2] ?? 0) * vector.z,
    y: (rotation[1]?.[0] ?? 0) * vector.x + (rotation[1]?.[1] ?? 0) * vector.y + (rotation[1]?.[2] ?? 0) * vector.z,
    z: (rotation[2]?.[0] ?? 0) * vector.x + (rotation[2]?.[1] ?? 0) * vector.y + (rotation[2]?.[2] ?? 0) * vector.z,
  };
}

/**
 * Rota un vector del marco inercial al marco corporal.
 */
export function rotateWorldToBody(vector: Vec3, quat: Quat): Vec3 {
  const rotation = quatToRotationMatrix(quat);
  return {
    x: (rotation[0]?.[0] ?? 0) * vector.x + (rotation[1]?.[0] ?? 0) * vector.y + (rotation[2]?.[0] ?? 0) * vector.z,
    y: (rotation[0]?.[1] ?? 0) * vector.x + (rotation[1]?.[1] ?? 0) * vector.y + (rotation[2]?.[1] ?? 0) * vector.z,
    z: (rotation[0]?.[2] ?? 0) * vector.x + (rotation[1]?.[2] ?? 0) * vector.y + (rotation[2]?.[2] ?? 0) * vector.z,
  };
}

/**
 * Convierte una matriz de rotación en una cuaternión unitaria.
 *
 * Se usa para construir la orientación deseada por el controlador a partir de
 * sus ejes de avance y vertical.
 */
export function quatFromRotationMatrix(matrix: Mat3): Quat {
  const m00 = matrix[0]?.[0] ?? 0;
  const m01 = matrix[0]?.[1] ?? 0;
  const m02 = matrix[0]?.[2] ?? 0;
  const m10 = matrix[1]?.[0] ?? 0;
  const m11 = matrix[1]?.[1] ?? 0;
  const m12 = matrix[1]?.[2] ?? 0;
  const m20 = matrix[2]?.[0] ?? 0;
  const m21 = matrix[2]?.[1] ?? 0;
  const m22 = matrix[2]?.[2] ?? 0;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const factor = Math.sqrt(trace + 1) * 2;
    return quatNormalize({
      w: factor / 4,
      x: (m21 - m12) / factor,
      y: (m02 - m20) / factor,
      z: (m10 - m01) / factor,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const factor = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize({
      w: (m21 - m12) / factor,
      x: factor / 4,
      y: (m01 + m10) / factor,
      z: (m02 + m20) / factor,
    });
  }
  if (m11 > m22) {
    const factor = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize({
      w: (m02 - m20) / factor,
      x: (m01 + m10) / factor,
      y: factor / 4,
      z: (m12 + m21) / factor,
    });
  }
  const factor = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize({
    w: (m10 - m01) / factor,
    x: (m02 + m20) / factor,
    y: (m12 + m21) / factor,
    z: factor / 4,
  });
}

/**
 * Construye la orientación que alinea el eje corporal `z` con `up` y mantiene
 * el rumbo lo más cercano posible al eje corporal `x` actual.
 */
export function quatFromUpAndForward(up: Vec3, forward: Vec3): Quat {
  const unitUp = normalize(up);
  if (norm(unitUp) <= Number.EPSILON) {
    return { w: 1, x: 0, y: 0, z: 0 };
  }
  let projectedForward = sub(forward, scale(unitUp, dot(forward, unitUp)));
  if (norm(projectedForward) <= 1e-8) {
    const fallback = Math.abs(unitUp.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    projectedForward = sub(fallback, scale(unitUp, dot(fallback, unitUp)));
  }
  const unitForward = normalize(projectedForward);
  const unitLeft = normalize(cross(unitUp, unitForward));
  const matrix: Mat3 = [
    [unitForward.x, unitLeft.x, unitUp.x],
    [unitForward.y, unitLeft.y, unitUp.y],
    [unitForward.z, unitLeft.z, unitUp.z],
  ];
  return quatFromRotationMatrix(matrix);
}
