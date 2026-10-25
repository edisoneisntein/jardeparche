import { GuidanceError } from "./errors.js";
import {
  add,
  cross,
  dot,
  norm,
  normalize,
  scale,
  sub,
  ZERO_VEC3,
} from "./state-vector.js";
import type { FlightTarget, StateVector, Vec3 } from "./types.js";

/** Parámetros de la ley Pure Pursuit. */
export interface PurePursuitParams {
  /** Distancia base de anticipación. */
  lookahead?: number;
  minimumLookahead?: number;
  maximumLookahead?: number;
  /** Velocidad deseada fija; si se omite se usa una velocidad proporcional a la distancia. */
  speed?: number;
  maxSpeed?: number;
  minSpeed?: number;
  /** Ganancia que convierte la distancia restante en velocidad. */
  speedGain?: number;
  /** Horizonte temporal usado para adaptar el lookahead a la velocidad actual. */
  lookaheadTime?: number;
  mass?: number;
}

/** Resultado de la evaluación Pure Pursuit. */
export interface PurePursuitResult {
  desiredVelocity: Vec3;
  /** Alias de `desiredVelocity` para integraciones que usan la forma corta. */
  velocity: Vec3;
  desiredAcceleration: Vec3;
  desiredForce: Vec3;
  targetPoint: Vec3;
  lookaheadDistance: number;
  distanceToTarget: number;
  converged: boolean;
}

/** Parámetros de la navegación proporcional. */
export interface ProportionalNavigationParams {
  navigationConstant?: number;
  maxAcceleration?: number;
  maxSpeed?: number;
  mass?: number;
  /** Tiempo usado para convertir la aceleración de guiado en velocidad deseada. */
  velocityHorizon?: number;
}

/** Resultado de la navegación proporcional tridimensional. */
export interface ProportionalNavigationResult {
  desiredAcceleration: Vec3;
  desiredForce: Vec3;
  desiredVelocity: Vec3;
  unitLos: Vec3;
  losRate: Vec3;
  closingSpeed: number;
  missDistance: number;
}

/** Obstáculo esférico. */
export interface SphereObstacle {
  type?: "sphere";
  center: Vec3;
  radius: number;
}

/** Obstáculo rectangular orientado con los ejes del mundo. */
export interface BoxObstacle {
  type: "box";
  center?: Vec3;
  halfExtents?: Vec3;
  size?: Vec3;
  min?: Vec3;
  max?: Vec3;
}

/** Obstáculo cilíndrico vertical. */
export interface CylinderObstacle {
  type: "cylinder";
  center: Vec3;
  radius: number;
  height: number;
}

/**
 * Obstáculo genérico admitido por RRT*.
 *
 * `center` o `position` indican el centro de la figura. Si no se indica
 * `type`, una esfera es la interpretación por defecto cuando existe `radius`.
 */
export interface Obstacle {
  type?: "sphere" | "box" | "cylinder";
  center?: Vec3;
  position?: Vec3;
  radius?: number;
  height?: number;
  halfExtents?: Vec3;
  size?: Vec3;
  min?: Vec3;
  max?: Vec3;
}

/** Opciones de búsqueda RRT*. */
export interface RRTStarOptions {
  maxIterations?: number;
  stepSize?: number;
  goalTolerance?: number;
  nearestRadius?: number;
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
  /** Generador uniforme en `[0, 1]`; si se omite se usa `seed`. */
  random?: () => number;
  seed?: number;
  obstacleClearance?: number;
}

interface RRTNode {
  position: Vec3;
  parent: number;
  cost: number;
}

/** Resultado detallado de RRT*; la función principal devuelve únicamente la ruta. */
export interface RRTStarResult {
  path: Vec3[] | null;
  success: boolean;
  iterations: number;
  nodes: number;
}

/**
 * Generador pseudoaleatorio determinista con una semilla de 32 bits.
 *
 * Se utiliza el generador lineal congruente para que el mismo `seed` produzca
 * siempre la misma ruta y para que el núcleo no dependa de `Math.random`.
 */
export function createSeededRandom(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function isFlightTarget(target: FlightTarget | Vec3): target is FlightTarget {
  return "pos" in target;
}

function targetPosition(target: FlightTarget | Vec3): Vec3 {
  return isFlightTarget(target) ? target.pos : target;
}

function targetVelocity(target: FlightTarget | Vec3): Vec3 {
  return isFlightTarget(target) ? target.vel ?? ZERO_VEC3 : ZERO_VEC3;
}

/**
 * Genera el comando de velocidad de Pure Pursuit.
 *
 * El punto de mira se desplaza sobre la línea que une el vehículo con el
 * objetivo. La distancia de anticipación se adapta a la velocidad actual y
 * se limita para
 * evitar que un objetivo muy cercano produzca un comando errático.
 */
export function purePursuit(
  state: StateVector,
  target: FlightTarget | Vec3,
  params: PurePursuitParams = {},
): PurePursuitResult {
  const targetPositionValue = targetPosition(target);
  const targetVelocityValue = targetVelocity(target);
  const relative = sub(targetPositionValue, state.pos);
  const distance = norm(relative);
  const speed = norm(state.vel);
  const baseLookahead = params.lookahead ?? 4;
  const minimumLookahead = params.minimumLookahead ?? Math.max(0.5, baseLookahead * 0.25);
  const maximumLookahead = params.maximumLookahead ?? Math.max(minimumLookahead, baseLookahead * 3);
  const lookaheadTime = params.lookaheadTime ?? 0.8;
  const adaptiveLookahead = clamp(
    baseLookahead + speed * lookaheadTime,
    minimumLookahead,
    maximumLookahead,
  );
  const lookaheadDistance = Math.min(adaptiveLookahead, Math.max(distance, minimumLookahead));
  const predictedTarget = add(
    targetPositionValue,
    scale(targetVelocityValue, lookaheadTime),
  );
  const predictedRelative = sub(predictedTarget, state.pos);
  const predictedDistance = norm(predictedRelative);
  const direction = predictedDistance > 1e-8 ? scale(predictedRelative, 1 / predictedDistance) : ZERO_VEC3;
  const pursuitPoint = add(state.pos, scale(direction, lookaheadDistance));
  const pursuitDirection = normalize(sub(pursuitPoint, state.pos));
  const effectiveDirection = norm(pursuitDirection) > 1e-8 ? pursuitDirection : direction;
  const maximumSpeed = params.maxSpeed ?? 20;
  const minimumSpeed = params.minSpeed ?? 0;
  const speedGain = params.speedGain ?? 1.2;
  const desiredSpeed =
    params.speed ??
    clamp(distance * speedGain, minimumSpeed, maximumSpeed);
  const desiredVelocity =
    distance <= 1e-6 ? ZERO_VEC3 : scale(effectiveDirection, desiredSpeed);
  const desiredAcceleration = scale(sub(desiredVelocity, state.vel), 1);
  const mass = params.mass ?? state.mass;
  return {
    desiredVelocity,
    velocity: desiredVelocity,
    desiredAcceleration,
    desiredForce: scale(desiredAcceleration, mass),
    targetPoint: pursuitPoint,
    lookaheadDistance,
    distanceToTarget: distance,
    converged: distance <= 1e-6,
  };
}

/**
 * Calcula una ley de navegación proporcional tridimensional.
 *
 * La velocidad de la línea de visión se obtiene del producto cruzado entre la
 * posición relativa y la velocidad relativa. La aceleración lateral necesaria
 * para interceptar se aplica proporcionalmente a la velocidad de cierre y a
 * la constante de navegación.
 */
export function proportionalNavigation(
  state: StateVector,
  targetState: StateVector,
  params: ProportionalNavigationParams = {},
): ProportionalNavigationResult {
  const relativePosition = sub(targetState.pos, state.pos);
  const relativeVelocity = sub(targetState.vel, state.vel);
  const missDistance = norm(relativePosition);
  if (missDistance <= 1e-9) {
    return {
      desiredAcceleration: ZERO_VEC3,
      desiredForce: ZERO_VEC3,
      desiredVelocity: state.vel,
      unitLos: { x: 0, y: 0, z: 1 },
      losRate: ZERO_VEC3,
      closingSpeed: 0,
      missDistance: 0,
    };
  }
  const unitLos = scale(relativePosition, 1 / missDistance);
  const closingSpeed = Math.max(0, -dot(unitLos, relativeVelocity));
  const losRate = scale(cross(relativePosition, relativeVelocity), 1 / (missDistance * missDistance));
  const navigationConstant = params.navigationConstant ?? 4;
  const lateralAcceleration = scale(
    cross(losRate, unitLos),
    navigationConstant * closingSpeed,
  );
  const maximumAcceleration = params.maxAcceleration ?? 20;
  const accelerationMagnitude = norm(lateralAcceleration);
  const desiredAcceleration =
    accelerationMagnitude <= maximumAcceleration || accelerationMagnitude <= 1e-12
      ? lateralAcceleration
      : scale(lateralAcceleration, maximumAcceleration / accelerationMagnitude);
  const mass = params.mass ?? state.mass;
  const horizon = params.velocityHorizon ?? 1;
  const unconstrainedVelocity = add(state.vel, scale(desiredAcceleration, horizon));
  const maximumSpeed = params.maxSpeed ?? 40;
  const speed = norm(unconstrainedVelocity);
  const desiredVelocity =
    speed <= maximumSpeed || speed <= 1e-12
      ? unconstrainedVelocity
      : scale(unconstrainedVelocity, maximumSpeed / speed);
  return {
    desiredAcceleration,
    desiredForce: scale(desiredAcceleration, mass),
    desiredVelocity,
    unitLos,
    losRate,
    closingSpeed,
    missDistance,
  };
}

function obstacleCenter(obstacle: Obstacle): Vec3 | undefined {
  return obstacle.center ?? obstacle.position;
}

function pointInBox(point: Vec3, obstacle: Obstacle, clearance: number): boolean {
  if (obstacle.min !== undefined && obstacle.max !== undefined) {
    return (
      point.x >= obstacle.min.x - clearance &&
      point.x <= obstacle.max.x + clearance &&
      point.y >= obstacle.min.y - clearance &&
      point.y <= obstacle.max.y + clearance &&
      point.z >= obstacle.min.z - clearance &&
      point.z <= obstacle.max.z + clearance
    );
  }
  const center = obstacleCenter(obstacle);
  if (center === undefined) {
    return false;
  }
  const halfExtents = obstacle.halfExtents ??
    (obstacle.size !== undefined
      ? { x: obstacle.size.x / 2, y: obstacle.size.y / 2, z: obstacle.size.z / 2 }
      : undefined);
  if (halfExtents === undefined) {
    return false;
  }
  return (
    Math.abs(point.x - center.x) <= halfExtents.x + clearance &&
    Math.abs(point.y - center.y) <= halfExtents.y + clearance &&
    Math.abs(point.z - center.z) <= halfExtents.z + clearance
  );
}

function pointInCylinder(point: Vec3, obstacle: Obstacle, clearance: number): boolean {
  const center = obstacleCenter(obstacle);
  const radius = obstacle.radius ?? 0;
  const height = obstacle.height ?? 0;
  if (center === undefined) {
    return false;
  }
  const radialDistance = Math.sqrt(
    (point.x - center.x) * (point.x - center.x) +
      (point.y - center.y) * (point.y - center.y),
  );
  return (
    radialDistance <= radius + clearance &&
    Math.abs(point.z - center.z) <= height / 2 + clearance
  );
}

/**
 * Comprueba si un punto se encuentra dentro de un obstáculo.
 */
export function isPointInObstacle(point: Vec3, obstacle: Obstacle, clearance = 0): boolean {
  const center = obstacleCenter(obstacle);
  if (center === undefined) {
    return false;
  }
  if (obstacle.type === "box") {
    return pointInBox(point, obstacle, clearance);
  }
  if (obstacle.type === "cylinder") {
    return pointInCylinder(point, obstacle, clearance);
  }
  const radius = obstacle.radius ?? 0;
  return (
    Math.sqrt(
      (point.x - center.x) * (point.x - center.x) +
        (point.y - center.y) * (point.y - center.y) +
        (point.z - center.z) * (point.z - center.z),
    ) <= radius + clearance
  );
}

/**
 * Comprueba que todos los puntos de un segmento no atraviesen un obstáculo.
 */
export function isSegmentCollisionFree(
  start: Vec3,
  end: Vec3,
  obstacles: readonly Obstacle[],
  clearance = 0,
): boolean {
  const distance = norm(sub(end, start));
  const samples = Math.max(2, Math.ceil(distance / Math.max(clearance, 0.25)));
  for (let index = 0; index <= samples; index += 1) {
    const ratio = index / samples;
    const point = add(start, scale(sub(end, start), ratio));
    if (obstacles.some((obstacle) => isPointInObstacle(point, obstacle, clearance))) {
      return false;
    }
  }
  return true;
}

function nearestNode(nodes: readonly RRTNode[], position: Vec3): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  nodes.forEach((node, index) => {
    const distance = norm(sub(node.position, position));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

/**
 * Devuelve los índices de los vecinos más cercanos dentro de un radio.
 */
export function findNearestNeighbors(
  nodes: readonly Vec3[],
  position: Vec3,
  radius: number,
): number[] {
  return nodes
    .map((node, index) => ({ index, distance: norm(sub(node, position)) }))
    .filter((entry) => entry.distance <= radius)
    .sort((left, right) => left.distance - right.distance)
    .map((entry) => entry.index);
}

function steer(from: Vec3, to: Vec3, stepSize: number): Vec3 {
  const difference = sub(to, from);
  const distance = norm(difference);
  if (distance <= stepSize || distance <= 1e-12) {
    return { ...to };
  }
  return add(from, scale(difference, stepSize / distance));
}

function defaultBounds(
  start: Vec3,
  goal: Vec3,
  obstacles: readonly Obstacle[],
): { min: Vec3; max: Vec3 } {
  const extent = Math.max(
    2,
    norm(sub(goal, start)) * 0.6,
    ...obstacles.map((obstacle) => {
      const center = obstacleCenter(obstacle);
      const radius = obstacle.radius ?? 0;
      const height = obstacle.height ?? 0;
      return center === undefined ? 0 : Math.sqrt(
        center.x * center.x + center.y * center.y + center.z * center.z + radius * radius + height * height,
      );
    }),
  );
  return {
    min: {
      x: Math.min(start.x, goal.x) - extent,
      y: Math.min(start.y, goal.y) - extent,
      z: Math.min(start.z, goal.z) - extent,
    },
    max: {
      x: Math.max(start.x, goal.x) + extent,
      y: Math.max(start.y, goal.y) + extent,
      z: Math.max(start.z, goal.z) + extent,
    },
  };
}

/**
 * Busca una ruta RRT* en un espacio tridimensional con obstáculos.
 *
 * La implementación usa remuestreo pseudoaleatorio determinista, una
 * conexión por segments con comprobación de colisión y una fase de rewiring
 * que reduce el coste de los vecinos. Devuelve `null` cuando no encuentra una
 * ruta dentro del presupuesto de iteraciones.
 */
export function rrtStar(
  start: Vec3,
  goal: Vec3,
  obstacles: readonly Obstacle[] = [],
  options: RRTStarOptions = {},
): Vec3[] | null {
  const result = rrtStarDetailed(start, goal, obstacles, options);
  return result.path;
}

/**
 * Variante detallada de RRT* que expone el coste de búsqueda y el tamaño del
 * árbol construido.
 */
export function rrtStarDetailed(
  start: Vec3,
  goal: Vec3,
  obstacles: readonly Obstacle[] = [],
  options: RRTStarOptions = {},
): RRTStarResult {
  const maximumIterations = options.maxIterations ?? 2500;
  const stepSize = options.stepSize ?? 1;
  const goalTolerance = options.goalTolerance ?? 0.6;
  const nearestRadius = options.nearestRadius ?? 4;
  const clearance = options.obstacleClearance ?? 0.15;
  if (maximumIterations <= 0 || stepSize <= 0 || goalTolerance <= 0 || nearestRadius <= 0) {
    throw new GuidanceError("Los parámetros de RRT* deben ser positivos.");
  }
  const random = options.random ?? createSeededRandom(options.seed ?? 1);
  const bounds = options.bounds ?? defaultBounds(start, goal, obstacles);
  if (
    bounds.min.x > bounds.max.x ||
    bounds.min.y > bounds.max.y ||
    bounds.min.z > bounds.max.z
  ) {
    throw new GuidanceError("Los límites del espacio de RRT* son inválidos.");
  }
  if (obstacles.some((obstacle) => isPointInObstacle(start, obstacle, clearance))) {
    return { path: null, success: false, iterations: 0, nodes: 1 };
  }
  if (obstacles.some((obstacle) => isPointInObstacle(goal, obstacle, clearance))) {
    return { path: null, success: false, iterations: 0, nodes: 1 };
  }
  if (norm(sub(goal, start)) <= goalTolerance) {
    return { path: [{ ...start }], success: true, iterations: 0, nodes: 1 };
  }

  const nodes: RRTNode[] = [{ position: { ...start }, parent: -1, cost: 0 }];
  let iterations = 0;
  let goalParentIndex = -1;

  for (iterations = 1; iterations <= maximumIterations; iterations += 1) {
    const useGoal = iterations % 10 === 0;
    const sample = useGoal
      ? { ...goal }
      : {
          x: bounds.min.x + random() * (bounds.max.x - bounds.min.x),
          y: bounds.min.y + random() * (bounds.max.y - bounds.min.y),
          z: bounds.min.z + random() * (bounds.max.z - bounds.min.z),
        };
    const nearestIndex = nearestNode(nodes, sample);
    const nearest = nodes[nearestIndex];
    if (nearest === undefined) {
      continue;
    }
    const candidate = steer(nearest.position, sample, stepSize);
    if (norm(sub(candidate, nearest.position)) <= 1e-9) {
      continue;
    }
    if (!isSegmentCollisionFree(nearest.position, candidate, obstacles, clearance)) {
      continue;
    }

    const candidateCost = nearest.cost + norm(sub(candidate, nearest.position));
    const nodePositions = nodes.map((node) => node.position);
    const neighborIndices = findNearestNeighbors(
      [...nodePositions, candidate],
      candidate,
      nearestRadius,
    ).filter((index) => index < nodes.length);
    let parentIndex = nearestIndex;
    let parentCost = candidateCost;
    for (const neighborIndex of neighborIndices) {
      const neighbor = nodes[neighborIndex];
      if (neighbor === undefined) {
        continue;
      }
      const throughCandidate = candidateCost + norm(sub(neighbor.position, candidate));
      if (
        throughCandidate < parentCost &&
        isSegmentCollisionFree(candidate, neighbor.position, obstacles, clearance)
      ) {
        parentIndex = neighborIndex;
        parentCost = throughCandidate;
      }
    }

    const newIndex = nodes.length;
    nodes.push({ position: candidate, parent: parentIndex, cost: parentCost });
    for (const neighborIndex of neighborIndices) {
      const neighbor = nodes[neighborIndex];
      if (neighbor === undefined || neighborIndex === newIndex) {
        continue;
      }
      const newCost = parentCost + norm(sub(neighbor.position, candidate));
      if (
        newCost + 1e-9 < neighbor.cost &&
        isSegmentCollisionFree(candidate, neighbor.position, obstacles, clearance)
      ) {
        neighbor.parent = newIndex;
        neighbor.cost = newCost;
      }
    }

    if (norm(sub(candidate, goal)) <= goalTolerance) {
      if (isSegmentCollisionFree(candidate, goal, obstacles, clearance)) {
        goalParentIndex = newIndex;
        break;
      }
    }
  }

  if (goalParentIndex < 0) {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) {
        continue;
      }
      if (
        norm(sub(node.position, goal)) <= goalTolerance &&
        isSegmentCollisionFree(node.position, goal, obstacles, clearance)
      ) {
        goalParentIndex = index;
        break;
      }
    }
  }
  if (goalParentIndex < 0) {
    return { path: null, success: false, iterations, nodes: nodes.length };
  }

  const path: Vec3[] = [];
  let currentIndex: number | undefined = goalParentIndex;
  while (currentIndex !== undefined && currentIndex >= 0) {
    const node: RRTNode | undefined = nodes[currentIndex];
    if (node === undefined) {
      break;
    }
    path.push({ ...node.position });
    currentIndex = node.parent;
  }
  path.reverse();
  path.push({ ...goal });
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    if (from === undefined || to === undefined || !isSegmentCollisionFree(from, to, obstacles, clearance)) {
      return { path: null, success: false, iterations, nodes: nodes.length };
    }
  }
  return { path, success: true, iterations, nodes: nodes.length };
}
