/**
 * Tipos primitivos y contratos públicos del simulador de vuelo 6-DoF.
 *
 * El simulador usa un sistema cartesiano tridimensional con metros y
 * segundos. La cuaternión representa la orientación del cuerpo respecto al
 * mundo con la convención Hamilton y el orden de componentes `w, x, y, z`.
 */

/** Vector cartesiano de tres componentes. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Quaternion unitaria con la convención Hamilton `w, x, y, z`. */
export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Matriz de transformación de 3×3 almacenada por filas.
 *
 * La matriz producida por `quatToRotationMatrix` transforma vectores del
 * sistema corporal al sistema inercial cuando se multiplica en el orden
 * habitual `R * v`.
 */
export type Mat3 = number[][];

/** Modos de operación con ganancias de control diferenciadas. */
export type FlightMode = "hover" | "cruise" | "intercept";

/**
 * Estado completo de la dinámica de un vehículo.
 *
 * `pos` y `vel` están expresados en el marco inercial. `quat` describe la
 * orientación corporal y `angVel` es la velocidad angular en el marco corporal.
 * `inertia` contiene la diagonal principal de la matriz de inercia. `thrust`
 * y `torque` conservan el último comando de actuación aplicado.
 */
export interface StateVector {
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  angVel: Vec3;
  mass: number;
  inertia: Vec3;
  thrust: Vec3;
  torque: Vec3;
}

/** Coeficientes aerodinámicos con el sentido definido por el modelo. */
export interface AeroCoeffs {
  CL: number;
  CD: number;
  CY: number;
  Cl: number;
  Cm: number;
  Cn: number;
}

/** Telemetría resumida para HUD, registros o comprobaciones de estado. */
export interface Telemetry {
  gLoad: number;
  aoa: number;
  sideslip: number;
  thrustPct: number;
  altitude: number;
  speed: number;
  tempC: number;
}

/**
 * Objetivo de guiado o de control.
 *
 * La velocidad y la cuaternión son opcionales para permitir usar el mismo
 * contrato con puntos de ruta estáticos y con objetivos móviles.
 */
export interface FlightTarget {
  pos: Vec3;
  vel?: Vec3;
  quat?: Quat;
}

/** Dirección y magnitud del viento en el marco inercial. */
export type Wind = Vec3;
