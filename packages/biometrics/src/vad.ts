import { BiometricsError } from "./errors.js";
import type { NeuralVadDetector, VadConfig, VadResult } from "./types.js";

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_ENERGY_THRESHOLD = 300;
const DEFAULT_ENERGY_CEILING = 3_000;
const DEFAULT_HANGOVER_FRAMES = 3;
const DEFAULT_ZERO_CROSSING_MIN = 0.005;
const DEFAULT_ZERO_CROSSING_MAX = 0.45;

/**
 * Detector síncrono de actividad de voz basado en RMS y cruces de signo.
 */
export class VoiceActivityDetector {
  private readonly threshold: number;
  private readonly energyThreshold: number;
  private readonly energyCeiling: number;
  private readonly hangoverFrames: number;
  private readonly zeroCrossingMin: number;
  private readonly zeroCrossingMax: number;
  private readonly neural?: NeuralVadDetector;
  private speech = false;
  private hangoverRemaining = 0;

  /**
   * Crea un detector de actividad de voz.
   *
   * @param config Umbrales, hangover y detector neuronal opcional.
   * @throws BiometricsError si algún umbral no es válido.
   */
  constructor(config: VadConfig = {}) {
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.energyThreshold = config.energyThreshold ?? DEFAULT_ENERGY_THRESHOLD;
    this.energyCeiling = config.energyCeiling ?? DEFAULT_ENERGY_CEILING;
    this.hangoverFrames = config.hangoverFrames ?? DEFAULT_HANGOVER_FRAMES;
    this.zeroCrossingMin = config.zeroCrossingMin ?? DEFAULT_ZERO_CROSSING_MIN;
    this.zeroCrossingMax = config.zeroCrossingMax ?? DEFAULT_ZERO_CROSSING_MAX;
    this.neural = config.neural;

    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1) {
      throw new BiometricsError("configuration", "El threshold VAD debe estar entre 0 y 1.");
    }
    if (!Number.isFinite(this.energyThreshold) || this.energyThreshold < 0) {
      throw new BiometricsError("configuration", "energyThreshold debe ser un valor no negativo.");
    }
    if (!Number.isFinite(this.energyCeiling) || this.energyCeiling <= this.energyThreshold) {
      throw new BiometricsError(
        "configuration",
        "energyCeiling debe ser mayor que energyThreshold.",
      );
    }
    if (!Number.isInteger(this.hangoverFrames) || this.hangoverFrames < 0) {
      throw new BiometricsError("configuration", "hangoverFrames debe ser un entero no negativo.");
    }
    if (
      !Number.isFinite(this.zeroCrossingMin)
      || !Number.isFinite(this.zeroCrossingMax)
      || this.zeroCrossingMin < 0
      || this.zeroCrossingMax <= this.zeroCrossingMin
      || this.zeroCrossingMax > 1
    ) {
      throw new BiometricsError("configuration", "El rango de zero-crossing no es válido.");
    }
  }

  /**
   * Analiza una trama PCM 16 bits, mono y 16 kHz.
   *
   * @param frame Trama de audio sin signo de 16 bits.
   * @returns Estado de habla, probabilidad y RMS de la trama.
   * @throws BiometricsError si la trama está vacía o el detector neuronal falla.
   */
  process(frame: Int16Array): VadResult {
    if (frame.length === 0) {
      throw new BiometricsError("invalid_input", "La trama PCM del VAD no puede estar vacía.");
    }

    let squareSum = 0;
    let crossingCount = 0;
    let previous = frame[0];
    for (let index = 0; index < frame.length; index += 1) {
      const value = frame[index];
      if (value === undefined) continue;
      squareSum += value * value;
      if (index > 0 && previous !== undefined && (value >= 0) !== (previous >= 0)) {
        crossingCount += 1;
      }
      previous = value;
    }
    const rms = Math.sqrt(squareSum / frame.length);
    const zeroCrossingRate = frame.length > 1 ? crossingCount / (frame.length - 1) : 0;

    let probability: number;
    if (this.neural !== undefined) {
      const neuralProbability = this.neural.probability(frame);
      if (!Number.isFinite(neuralProbability)) {
        throw new BiometricsError("protocol", "El detector neuronal VAD devolvió una probabilidad inválida.");
      }
      probability = clamp(neuralProbability, 0, 1);
    } else {
      const energyRatio = clamp(
        (rms - this.energyThreshold) / (this.energyCeiling - this.energyThreshold),
        0,
        1,
      );
      const zeroCrossingScore = this.zeroCrossingScore(zeroCrossingRate);
      probability = energyRatio * zeroCrossingScore;
    }

    const candidate = probability >= this.threshold;
    if (candidate) {
      this.speech = true;
      this.hangoverRemaining = this.hangoverFrames;
    } else if (this.speech && this.hangoverRemaining > 0) {
      this.hangoverRemaining -= 1;
    } else {
      this.speech = false;
      this.hangoverRemaining = 0;
    }

    return { speech: this.speech, probability, rms };
  }

  /**
   * Restablece el estado de habla y el hangover.
   */
  reset(): void {
    this.speech = false;
    this.hangoverRemaining = 0;
  }

  /**
   * Indica si el detector considera activa la voz.
   *
   * @returns `true` mientras el estado de habla o su hangover estén activos.
   */
  get isSpeaking(): boolean {
    return this.speech;
  }

  /**
   * Calcula la confianza del cero-crossing para la banda de voz configurada.
   *
   * @param rate Tasa de cambios de signo por muestra.
   * @returns Confianza acotada entre 0 y 1.
   */
  private zeroCrossingScore(rate: number): number {
    if (rate >= this.zeroCrossingMin && rate <= this.zeroCrossingMax) return 1;
    const distance = rate < this.zeroCrossingMin
      ? this.zeroCrossingMin - rate
      : rate - this.zeroCrossingMax;
    return clamp(1 - distance / 0.25, 0, 1);
  }
}

/**
 * Crea un detector de actividad de voz.
 *
 * Para sustituir el detector energético por Silero, implemente
 * `NeuralVadDetector.probability(frame)`: mantenga el estado recurrentes del
 * modelo ONNX, aplique la normalización PCM esperada por Silero y devuelva la
 * probabilidad de voz. Un runtime que solo produzca inferencias asíncronas
 * puede alimentarlo mediante un worker y una cola de resultados, conservando
 * el contrato síncrono de `process()`.
 *
 * @param config Configuración del detector.
 * @returns Detector listo para procesar tramas.
 */
export function createVad(config: VadConfig = {}): VoiceActivityDetector {
  return new VoiceActivityDetector(config);
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
