import { BiometricsError, toBiometricsError } from "./errors.js";
import type {
  Voiceprint,
  VoiceprintConfig,
  VoiceprintEmbedder,
  VoiceprintSample,
  VoiceprintVerification,
} from "./types.js";

const DEFAULT_THRESHOLD = 0.85;
const REFERENCE_FEATURE_SEGMENTS = 16;
const REFERENCE_FEATURE_DIMENSIONS = REFERENCE_FEATURE_SEGMENTS * 4;

/**
 * Embedder determinista de referencia basado en estadísticas de energía,
 * cruces de signo y variación de la señal.
 *
 * No pretende sustituir a un modelo comercial de identificación de voz. Su
 * objetivo es proporcionar un contrato funcional y reproducible para el
 * pipeline, permitir pruebas deterministas y dejar una frontera clara para
 * sustituirlo por ECAPA-TDNN sin modificar el gestor de huellas.
 */
export class ReferenceVoiceprintEmbedder implements VoiceprintEmbedder {
  /**
   * Calcula un embedding determinista de 64 dimensiones.
   *
   * @param sample Segmento PCM mono y su frecuencia de muestreo.
   * @returns Embedding normalizado en norma L2.
   * @throws BiometricsError si el audio está vacío o contiene valores no finitos.
   */
  embed(sample: VoiceprintSample): number[] {
    validateAudioSample(sample);
    const segmentLength = Math.max(1, Math.floor(sample.pcm.length / REFERENCE_FEATURE_SEGMENTS));
    const features: number[] = [];

    for (let segment = 0; segment < REFERENCE_FEATURE_SEGMENTS; segment += 1) {
      const start = segment * segmentLength;
      const end = Math.min(sample.pcm.length, start + segmentLength);
      if (start >= end) {
        features.push(0, 0, 0, 0);
        continue;
      }

      let squareSum = 0;
      let absoluteSum = 0;
      let crossingCount = 0;
      let differenceSum = 0;
      let previous = sample.pcm[start];
      for (let index = start; index < end; index += 1) {
        const value = sample.pcm[index];
        if (value === undefined) continue;
        squareSum += value * value;
        absoluteSum += Math.abs(value);
        if (previous !== undefined && (value >= 0) !== (previous >= 0)) crossingCount += 1;
        if (previous !== undefined) differenceSum += Math.abs(value - previous);
        previous = value;
      }
      const count = end - start;
      const rms = Math.sqrt(squareSum / count);
      const absoluteMean = absoluteSum / count;
      const zeroCrossingRate = count > 1 ? crossingCount / (count - 1) : 0;
      const meanAbsoluteDifference = count > 1 ? differenceSum / (count - 1) : 0;

      features.push(
        Math.tanh(rms * 12),
        Math.tanh(absoluteMean * 18),
        Math.tanh(zeroCrossingRate * 12),
        Math.tanh(meanAbsoluteDifference * 18),
      );
    }

    const normalized = normalizeVector(features);
    if (normalized === undefined) {
      throw new BiometricsError("invalid_input", "El segmento vocal no contiene energía utilizable.");
    }
    return normalized;
  }
}

/**
 * Gestor de enrollment y verificación de huellas vocales.
 */
export class VoiceprintManager {
  private readonly embedder: VoiceprintEmbedder;
  private readonly threshold: number;
  private readonly voiceprints = new Map<string, Voiceprint>();

  /**
   * Crea un gestor de huellas vocales.
   *
   * @param config Embedder, umbral y huellas iniciales opcionales.
   * @throws BiometricsError si el umbral o una huella precargada no son válidos.
   */
  constructor(config: VoiceprintConfig = {}) {
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    if (!Number.isFinite(this.threshold) || this.threshold < -1 || this.threshold > 1) {
      throw new BiometricsError("configuration", "El umbral de huella vocal debe estar entre -1 y 1.");
    }
    this.embedder = config.embedder ?? new ReferenceVoiceprintEmbedder();

    for (const voiceprint of config.voiceprints ?? []) {
      const normalized = normalizeVector(voiceprint.embedding);
      if (normalized === undefined) {
        throw new BiometricsError(
          "invalid_input",
          `La huella vocal precargada de '${voiceprint.userId}' no contiene un vector válido.`,
        );
      }
      this.voiceprints.set(voiceprint.userId, {
        userId: voiceprint.userId,
        embedding: normalized,
        createdAt: voiceprint.createdAt,
      });
    }
  }

  /**
   * Registra una persona mediante varios segmentos de audio.
   *
   * Cada embedding se normaliza antes de calcularse la media y el vector
   * resultante se normaliza de nuevo. Esto evita que un segmento de mayor
   * energía domine la huella final.
   *
   * @param userId Identificador estable de la persona usuaria.
   * @param samples Segmentos de audio de la misma persona.
   * @returns Huella vocal normalizada y persistida en memoria.
   * @throws BiometricsError si no hay muestras o el embedder produce vectores inválidos.
   */
  async enroll(userId: string, samples: readonly VoiceprintSample[]): Promise<Voiceprint> {
    if (userId.trim().length === 0) {
      throw new BiometricsError("invalid_input", "El identificador de usuario vocal no puede estar vacío.");
    }
    if (samples.length === 0) {
      throw new BiometricsError("invalid_input", "El enrollment necesita al menos un segmento vocal.");
    }

    const normalizedEmbeddings: number[][] = [];
    for (const sample of samples) {
      let rawEmbedding: readonly number[];
      try {
        rawEmbedding = await this.embedder.embed(sample);
      } catch (error: unknown) {
        throw toBiometricsError(error, "invalid_input");
      }
      const normalized = normalizeVector(rawEmbedding);
      if (normalized === undefined) {
        throw new BiometricsError("invalid_input", "El embedder produjo un vector vocal vacío o inválido.");
      }
      normalizedEmbeddings.push(normalized);
    }

    const dimension = normalizedEmbeddings[0]?.length;
    if (dimension === undefined || dimension === 0) {
      throw new BiometricsError("invalid_input", "El embedding vocal no tiene dimensiones.");
    }
    for (const embedding of normalizedEmbeddings) {
      if (embedding.length !== dimension) {
        throw new BiometricsError(
          "invalid_input",
          "Todos los embeddings de enrollment deben tener la misma dimensión.",
        );
      }
    }

    const average = new Array<number>(dimension).fill(0);
    for (const embedding of normalizedEmbeddings) {
      for (let index = 0; index < dimension; index += 1) {
        average[index] = (average[index] ?? 0) + (embedding[index] ?? 0);
      }
    }
    for (let index = 0; index < average.length; index += 1) {
      average[index] = (average[index] ?? 0) / normalizedEmbeddings.length;
    }
    const normalizedAverage = normalizeVector(average);
    if (normalizedAverage === undefined) {
      throw new BiometricsError("invalid_input", "La media de los embeddings vocales es inválida.");
    }

    const voiceprint: Voiceprint = {
      userId,
      embedding: normalizedAverage,
      createdAt: new Date().toISOString(),
    };
    this.voiceprints.set(userId, voiceprint);
    return { ...voiceprint, embedding: [...voiceprint.embedding] };
  }

  /**
   * Verifica un segmento vocal contra la huella de una persona.
   *
   * Una persona no registrada produce una puntuación cero y no un error, lo
   * que permite al llamante distinguir "no coincide" de un fallo técnico.
   *
   * @param userId Identificador de la persona registrada.
   * @param sample Segmento vocal que se debe verificar.
   * @returns Resultado con decisión, similitud y umbral utilizados.
   * @throws BiometricsError si el embedder falla o produce un vector inválido.
   */
  async verify(userId: string, sample: VoiceprintSample): Promise<VoiceprintVerification> {
    const registered = this.voiceprints.get(userId);
    if (registered === undefined) {
      return { verified: false, score: 0, threshold: this.threshold };
    }

    let rawEmbedding: readonly number[];
    try {
      rawEmbedding = await this.embedder.embed(sample);
    } catch (error: unknown) {
      throw toBiometricsError(error, "invalid_input");
    }
    const normalized = normalizeVector(rawEmbedding);
    if (normalized === undefined) {
      throw new BiometricsError("invalid_input", "El embedder produjo un vector vocal vacío o inválido.");
    }
    const score = clamp(cosineSimilarity(registered.embedding, normalized), -1, 1);
    return {
      verified: score >= this.threshold,
      score,
      threshold: this.threshold,
    };
  }

  /**
   * Recupera una huella registrada.
   *
   * @param userId Identificador de la persona.
   * @returns Copia de la huella o `undefined` si no está registrada.
   */
  get(userId: string): Voiceprint | undefined {
    const voiceprint = this.voiceprints.get(userId);
    if (voiceprint === undefined) return undefined;
    return { ...voiceprint, embedding: [...voiceprint.embedding] };
  }
}

/**
 * Calcula la similitud coseno entre dos vectores.
 *
 * @param left Primer vector.
 * @param right Segundo vector.
 * @returns Similitud coseno acotada al intervalo `[-1, 1]`.
 * @throws BiometricsError si los vectores tienen dimensiones diferentes o son inválidos.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new BiometricsError("invalid_input", "Los embeddings deben tener la misma dimensión no nula.");
  }
  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) continue;
    dotProduct += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator <= Number.EPSILON ? 0 : dotProduct / denominator;
}

/**
 * Crea un gestor de huellas vocales.
 *
 * Para integrar ECAPA-TDNN con `onnxruntime-node`, implemente
 * `VoiceprintEmbedder.embed`: resample el PCM a 16 kHz mono, aplique la
 * normalización de loudness del modelo, construya log-mel, ejecute la sesión
 * ONNX y devuelva el vector de salida normalizado en L2. El contrato, el
 * enrollment y la verificación coseno permanecen sin cambios y no se añade
 * `onnxruntime-node` al package por defecto.
 *
 * @param config Configuración del gestor vocal.
 * @returns Gestor de huellas vocales listo para usar.
 */
export function createVoiceprint(config: VoiceprintConfig = {}): VoiceprintManager {
  return new VoiceprintManager(config);
}

/**
 * Valida un segmento de audio antes de calcular embeddings.
 *
 * @param sample Segmento que se debe validar.
 */
function validateAudioSample(sample: VoiceprintSample): void {
  if (sample.pcm.length === 0) {
    throw new BiometricsError("invalid_input", "El segmento vocal PCM está vacío.");
  }
  if (!Number.isFinite(sample.sampleRate) || sample.sampleRate <= 0) {
    throw new BiometricsError("invalid_input", "La frecuencia de muestreo vocal no es válida.");
  }
  for (const value of sample.pcm) {
    if (!Number.isFinite(value)) {
      throw new BiometricsError("invalid_input", "El segmento vocal contiene valores no finitos.");
    }
  }
}

/**
 * Normaliza un vector a norma L2.
 *
 * @param vector Vector de entrada.
 * @returns Vector normalizado o `undefined` si contiene valores inválidos o tiene norma cero.
 */
function normalizeVector(vector: readonly number[]): number[] | undefined {
  if (vector.length === 0) return undefined;
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return undefined;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm <= Number.EPSILON) return undefined;
  return vector.map((value) => value / norm);
}

/**
 * Acota un valor al intervalo indicado.
 *
 * @param value Valor de entrada.
 * @param minimum Límite inferior.
 * @param maximum Límite superior.
 * @returns Valor acotado.
 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
