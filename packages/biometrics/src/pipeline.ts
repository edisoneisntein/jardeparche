import { BiometricsError, toBiometricsError } from "./errors.js";
import type {
  BiometricAlert,
  BiometricAlertSink,
  BiometricPipelineConfig,
  BiometricPipelineSink,
  BiometricSample,
  BiometricState,
  HrvMetrics,
  StressZone,
} from "./types.js";

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_SAMPLES = 600;
const DEFAULT_MIN_HRV_SAMPLES = 4;
const DEFAULT_BAEVSKY_BASELINE_MS = 30;
const DEFAULT_EMA_ALPHA = 0.2;
const DEFAULT_ALERT_THRESHOLD = 70;
const DEFAULT_RECOVERY_THRESHOLD = 50;
const DEFAULT_LOMB_FREQUENCIES = 256;
const DEFAULT_LF_BAND_HZ: readonly [number, number] = [0.04, 0.15];
const DEFAULT_HF_BAND_HZ: readonly [number, number] = [0.15, 0.4];
const VALID_SOURCES = new Set<BiometricSample["source"]>([
  "garmin",
  "oura",
  "polar",
  "esp32",
  "apple",
  "manual",
]);

/**
 * Opciones del cálculo del espectro Lomb–Scargle.
 */
export interface LombScargleOptions {
  /** Número de frecuencias evaluadas. */
  frequencies?: number;
  /** Frecuencia mínima en hercios. */
  minFrequencyHz?: number;
  /** Frecuencia máxima en hercios. */
  maxFrequencyHz?: number;
  /** Banda LF en hercios. */
  lfBandHz?: readonly [number, number];
  /** Banda HF en hercios. */
  hfBandHz?: readonly [number, number];
}

/**
 * Espectro de potencia Lomb–Scargle y potencias de banda.
 */
export interface LombScargleSpectrum {
  /** Frecuencias evaluadas, en hercios. */
  frequenciesHz: number[];
  /** Potencia normalizada en cada frecuencia. */
  power: number[];
  /** Potencia integrada en la banda LF. */
  lfPower: number;
  /** Potencia integrada en la banda HF. */
  hfPower: number;
  /** Cociente LF/HF. */
  lfHfRatio: number;
}

/**
 * Calcula RMSSD, SDNN, pNN50 y el cociente LF/HF de una secuencia RR.
 *
 * @param rrIntervalsMs Intervalos RR en milisegundos.
 * @param timestampsMs Marcas temporales alineadas con los intervalos RR.
 * @returns Métricas HRV calculadas sobre todos los intervalos válidos.
 * @throws BiometricsError si un intervalo no es positivo o finito.
 */
export function calculateHrvMetrics(
  rrIntervalsMs: readonly number[],
  timestampsMs?: readonly number[],
): HrvMetrics {
  const intervals = validateIntervals(rrIntervalsMs);
  const count = intervals.length;
  if (count === 0) {
    return { rmssdMs: 0, sdnnMs: 0, pnn50Percent: 0, lfHfRatio: 0, sampleCount: 0 };
  }
  if (count === 1) {
    return { rmssdMs: 0, sdnnMs: 0, pnn50Percent: 0, lfHfRatio: 0, sampleCount: 1 };
  }

  let squaredDifferenceSum = 0;
  let adjacentCount = 0;
  let changedCount = 0;
  for (let index = 1; index < count; index += 1) {
    const current = intervals[index];
    const previous = intervals[index - 1];
    if (current === undefined || previous === undefined) continue;
    const difference = current - previous;
    squaredDifferenceSum += difference * difference;
    adjacentCount += 1;
    if (Math.abs(difference) > 50) changedCount += 1;
  }
  const rmssdMs = adjacentCount > 0 ? Math.sqrt(squaredDifferenceSum / adjacentCount) : 0;

  let mean = 0;
  for (const interval of intervals) mean += interval;
  mean /= count;
  let varianceSum = 0;
  for (const interval of intervals) {
    const difference = interval - mean;
    varianceSum += difference * difference;
  }
  const sdnnMs = count > 1 ? Math.sqrt(varianceSum / (count - 1)) : 0;
  const pnn50Percent = adjacentCount > 0 ? (changedCount / adjacentCount) * 100 : 0;

  let alignedTimestamps: number[] | undefined;
  if (timestampsMs !== undefined) {
    if (timestampsMs.length !== count) {
      throw new BiometricsError(
        "invalid_input",
        "Las marcas temporales HRV deben estar alineadas con los intervalos RR.",
      );
    }
    alignedTimestamps = [...timestampsMs];
  }
  const spectrum = lombScarglePowerSpectrum(intervals, alignedTimestamps, {});

  return {
    rmssdMs,
    sdnnMs,
    pnn50Percent,
    lfHfRatio: spectrum.lfHfRatio,
    sampleCount: count,
  };
}

/**
 * Calcula un espectro Lomb–Scargle normalizado para series irregularmente espaciadas.
 *
 * La implementación usa media flotante dependiente de la frecuencia, comum
 * en la forma generalizada de Lomb–Scargle. Para cada frecuencia calcula la
 * proyección de la señal residual sobre coseno y seno y obtiene la potencia
 * mediante la inversión de la matriz de normalización 2×2.
 *
 * @param values Valores de la serie.
 * @param timestampsMs Marcas temporales en milisegundos; si se omiten, se usan índices regulares.
 * @param options Frecuencias y bandas configurables.
 * @returns Espectro, potencias LF/HF y cociente LF/HF.
 * @throws BiometricsError si las series tienen longitudes distintas o valores no finitos.
 */
export function lombScarglePowerSpectrum(
  values: readonly number[],
  timestampsMs?: readonly number[],
  options: LombScargleOptions = {},
): LombScargleSpectrum {
  const count = values.length;
  if (timestampsMs !== undefined && timestampsMs.length !== count) {
    throw new BiometricsError(
      "invalid_input",
      "La serie temporal y sus marcas temporales deben tener la misma longitud.",
    );
  }
  if (count < 3) {
    return { frequenciesHz: [], power: [], lfPower: 0, hfPower: 0, lfHfRatio: 0 };
  }

  let mean = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new BiometricsError("invalid_input", "La serie HRV contiene valores no finitos.");
    }
    mean += value;
  }
  mean /= count;
  let variance = 0;
  for (const value of values) variance += (value - mean) * (value - mean);
  variance /= count;
  if (variance <= Number.EPSILON) {
    return { frequenciesHz: [], power: [], lfPower: 0, hfPower: 0, lfHfRatio: 0 };
  }

  const timesSeconds = new Array<number>(count);
  const origin = timestampsMs?.[0] ?? 0;
  for (let index = 0; index < count; index += 1) {
    const timestamp = timestampsMs?.[index];
    if (timestamp !== undefined && !Number.isFinite(timestamp)) {
      throw new BiometricsError("invalid_input", "La serie temporal contiene marcas no finitas.");
    }
    timesSeconds[index] = ((timestamp ?? index * 1_000) - origin) / 1_000;
  }

  const durationSeconds = Math.max(...timesSeconds) - Math.min(...timesSeconds);
  if (durationSeconds <= 0) {
    return { frequenciesHz: [], power: [], lfPower: 0, hfPower: 0, lfHfRatio: 0 };
  }

  const requestedFrequencies = options.frequencies ?? DEFAULT_LOMB_FREQUENCIES;
  const frequencyCount = Math.max(32, Math.floor(requestedFrequencies));
  const minimumFrequency = options.minFrequencyHz ?? Math.max(0.001, 1 / (2 * durationSeconds));
  const maximumFrequency = options.maxFrequencyHz ?? 0.5;
  if (!(minimumFrequency > 0) || !(maximumFrequency > minimumFrequency)) {
    throw new BiometricsError("invalid_input", "El rango de frecuencias Lomb–Scargle no es válido.");
  }

  const frequenciesHz: number[] = [];
  const power: number[] = [];
  for (let index = 0; index < frequencyCount; index += 1) {
    const fraction = frequencyCount === 1 ? 0 : index / (frequencyCount - 1);
    const frequency = minimumFrequency + fraction * (maximumFrequency - minimumFrequency);
    frequenciesHz.push(frequency);
    power.push(generalizedLombScarglePower(timesSeconds, values, mean, frequency));
  }

  const lfBand = options.lfBandHz ?? DEFAULT_LF_BAND_HZ;
  const hfBand = options.hfBandHz ?? DEFAULT_HF_BAND_HZ;
  const lfPower = integrateBand(frequenciesHz, power, lfBand);
  const hfPower = integrateBand(frequenciesHz, power, hfBand);
  return {
    frequenciesHz,
    power,
    lfPower,
    hfPower,
    lfHfRatio: hfPower > Number.EPSILON ? lfPower / hfPower : 0,
  };
}

/**
 * Pipeline deslizante de métricas biométricas, HRV, estrés y alertas.
 */
export class BiometricPipeline {
  private readonly samples: BiometricSample[] = [];
  private readonly states: BiometricState[] = [];
  private readonly alertLog: BiometricAlert[] = [];
  private activeAlert?: BiometricAlert;
  private emaStressScore?: number;
  private alertSequence = 0;

  /**
   * Crea un pipeline biométrico.
   *
   * @param config Parámetros de ventana, estrés, persistencia y espectro.
   * @throws BiometricsError si la configuración contiene rangos inválidos.
   */
  constructor(private readonly config: BiometricPipelineConfig = {}) {
    validatePipelineConfig(config);
  }

  /**
   * Añade una muestra y recalcula las métricas de la ventana deslizante.
   *
   * El estado se actualiza de forma síncrona antes de persistirlo. Si un sink
   * falla, la excepción queda tipada y la muestra ya calculada permanece
   * disponible mediante `getCurrent()`.
   *
   * @param sample Muestra biométrica recibida.
   * @returns Estado calculado para la muestra.
   * @throws BiometricsError si la muestra o la persistencia son inválidas.
   */
  async push(sample: BiometricSample): Promise<BiometricState> {
    validateSample(sample);
    this.insertSample(sample);
    this.trimSamples();

    const intervals: number[] = [];
    const intervalTimestamps: number[] = [];
    for (const buffered of this.samples) {
      if (buffered.hrvMs !== undefined && Number.isFinite(buffered.hrvMs) && buffered.hrvMs > 0) {
        intervals.push(buffered.hrvMs);
        intervalTimestamps.push(buffered.ts);
      }
    }

    const minimumSamples = this.config.minHrvSamples ?? DEFAULT_MIN_HRV_SAMPLES;
    const hrv = intervals.length >= minimumSamples
      ? calculateHrvMetrics(intervals, intervalTimestamps)
      : undefined;

    let stressScore = sample.stressScore ?? 0;
    let baevskyIndex: number | undefined;
    if (hrv !== undefined) {
      const baseline = this.config.baevskyBaselineRmssdMs ?? DEFAULT_BAEVSKY_BASELINE_MS;
      baevskyIndex = Math.exp(-hrv.rmssdMs / (2 * baseline));
      stressScore = clamp(baevskyIndex * 100, 0, 100);
    }
    stressScore = clamp(stressScore, 0, 100);

    const alpha = this.config.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.emaStressScore = this.emaStressScore === undefined
      ? stressScore
      : alpha * stressScore + (1 - alpha) * this.emaStressScore;
    const stressTrend = this.emaStressScore;

    const alertThreshold = this.config.stressAlertThreshold ?? DEFAULT_ALERT_THRESHOLD;
    const recoveryThreshold = this.config.stressRecoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD;
    let createdAlert: BiometricAlert | undefined;
    if (this.activeAlert !== undefined && stressScore < recoveryThreshold) {
      this.activeAlert.resolvedAt = sample.ts;
      this.activeAlert = undefined;
    }
    if (this.activeAlert === undefined && stressScore >= alertThreshold) {
      this.alertSequence += 1;
      createdAlert = {
        id: `stress-${sample.ts}-${this.alertSequence}`,
        kind: "stress_threshold",
        severity: this.stressZone(stressScore),
        value: stressScore,
        threshold: alertThreshold,
        triggeredAt: sample.ts,
        sample,
      };
      this.activeAlert = createdAlert;
      this.alertLog.push(createdAlert);
    }

    const state: BiometricState = {
      sample,
      ...(hrv === undefined ? {} : { hrv }),
      ...(baevskyIndex === undefined ? {} : { baevskyIndex }),
      stressScore,
      stressZone: this.stressZone(stressScore),
      stressTrend,
      ...(this.activeAlert === undefined ? {} : { alert: this.activeAlert }),
    };
    this.states.push(state);
    this.trimStates();

    await this.persistSample(sample, state);
    if (createdAlert !== undefined) await this.persistAlert(createdAlert, state);
    return state;
  }

  /**
   * Recupera el estado más reciente.
   *
   * @returns Copia del estado actual o `undefined` si aún no hay muestras.
   */
  getCurrent(): BiometricState | undefined {
    const current = this.states[this.states.length - 1];
    return current === undefined ? undefined : copyState(current);
  }

  /**
   * Recupera el historial de estados a partir de una marca temporal.
   *
   * @param since Instante inclusivo en milisegundos desde Unix.
   * @returns Copias de los estados ordenados cronológicamente.
   * @throws BiometricsError si `since` no es un instante finito válido.
   */
  getHistory(since?: number): BiometricState[] {
    if (since !== undefined && !Number.isFinite(since)) {
      throw new BiometricsError("invalid_input", "El inicio del historial debe ser un número finito.");
    }
    return this.states
      .filter((state) => since === undefined || state.sample.ts >= since)
      .map((state) => copyState(state));
  }

  /**
   * Obtiene una copia de todas las alertas emitidas.
   *
   * @returns Alertas en orden de activación.
   */
  get alerts(): BiometricAlert[] {
    return this.alertLog.map((alert) => ({ ...alert, sample: { ...alert.sample } }));
  }

  /**
   * Alias explícito de la propiedad `alerts`.
   *
   * @returns Alertas en orden de activación.
   */
  getAlerts(): BiometricAlert[] {
    return this.alerts;
  }

  /**
   * Inserta una muestra manteniendo el orden temporal.
   *
   * @param sample Muestra válida que se debe insertar.
   */
  private insertSample(sample: BiometricSample): void {
    const insertionIndex = this.samples.findIndex((buffered) => buffered.ts > sample.ts);
    if (insertionIndex === -1) this.samples.push(sample);
    else this.samples.splice(insertionIndex, 0, sample);
  }

  /**
   * Elimina muestras anteriores a la ventana temporal y las que superan el límite de tamaño.
   */
  private trimSamples(): void {
    const latestTimestamp = this.samples[this.samples.length - 1]?.ts;
    if (latestTimestamp === undefined) return;
    const windowMs = this.config.windowMs ?? DEFAULT_WINDOW_MS;
    const minimumTimestamp = latestTimestamp - windowMs;
    while (this.samples[0] !== undefined && this.samples[0].ts < minimumTimestamp) {
      this.samples.shift();
    }
    const maxSamples = this.config.maxSamples ?? DEFAULT_MAX_SAMPLES;
    while (this.samples.length > maxSamples) this.samples.shift();
  }

  /**
   * Limita el historial al mismo tamaño que el buffer de muestras.
   */
  private trimStates(): void {
    const maxSamples = this.config.maxSamples ?? DEFAULT_MAX_SAMPLES;
    while (this.states.length > maxSamples) this.states.shift();
  }

  /**
   * Calcula la zona de estrés según los límites configurados.
   *
   * @param score Puntuación de estrés entre 0 y 100.
   * @returns Zona de estrés correspondiente.
   */
  private stressZone(score: number): StressZone {
    const thresholds = this.config.stressZoneThresholds;
    const recoveryLimit = thresholds?.recovery ?? 30;
    const lowLimit = thresholds?.low ?? 50;
    const mediumLimit = thresholds?.medium ?? 70;
    if (score < recoveryLimit) return "recovery";
    if (score < lowLimit) return "low";
    if (score < mediumLimit) return "medium";
    return "high";
  }

  /**
   * Invoca el sink de muestras sin acoplar el pipeline a una base de datos.
   *
   * @param sample Muestra procesada.
   * @param state Estado calculado.
   */
  private async persistSample(sample: BiometricSample, state: BiometricState): Promise<void> {
    const sink = this.config.sink;
    if (sink === undefined) return;
    try {
      await sink(sample, state);
    } catch (error: unknown) {
      throw toBiometricsError(error, "unknown", sample.source);
    }
  }

  /**
   * Invoca el sink de alertas y conserva el error original tipado.
   *
   * @param alert Alerta recién activada.
   * @param state Estado que originó la alerta.
   */
  private async persistAlert(alert: BiometricAlert, state: BiometricState): Promise<void> {
    const sink = this.config.alertSink;
    if (sink === undefined) return;
    try {
      await sink(alert, state);
    } catch (error: unknown) {
      throw toBiometricsError(error, "unknown", alert.sample.source);
    }
  }
}

/**
 * Crea un pipeline biométrico deslizante.
 *
 * @param config Configuración del pipeline.
 * @returns Instancia lista para recibir muestras.
 */
export function createBiometricPipeline(config: BiometricPipelineConfig = {}): BiometricPipeline {
  return new BiometricPipeline(config);
}

/**
 * Calcula la potencia Lomb–Scargle generalizada en una frecuencia.
 *
 * @param timesSeconds Tiempos relativos en segundos.
 * @param values Valores observados.
 * @param mean Media global de la serie.
 * @param frequency Frecuencia evaluada en hercios.
 * @returns Potencia normalizada.
 */
function generalizedLombScarglePower(
  timesSeconds: readonly number[],
  values: readonly number[],
  mean: number,
  frequency: number,
): number {
  const angularFrequency = 2 * Math.PI * frequency;
  let sineWeight = 0;
  let weightedValue = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const time = timesSeconds[index];
    if (value === undefined || time === undefined) continue;
    const sine = Math.sin(angularFrequency * time);
    sineWeight += sine;
    weightedValue += value * sine;
  }
  const floatingMean = Math.abs(sineWeight) > 1e-12 ? weightedValue / sineWeight : mean;

  let cosineSignal = 0;
  let sineSignal = 0;
  let cosineSquare = 0;
  let sineSquare = 0;
  let cross = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const time = timesSeconds[index];
    if (value === undefined || time === undefined) continue;
    const centered = value - floatingMean;
    const cosine = Math.cos(angularFrequency * time);
    const sine = Math.sin(angularFrequency * time);
    cosineSignal += centered * cosine;
    sineSignal += centered * sine;
    cosineSquare += cosine * cosine;
    sineSquare += sine * sine;
    cross += cosine * sine;
  }

  const determinant = cosineSquare * sineSquare - cross * cross;
  if (determinant <= Number.EPSILON) return 0;
  const numerator = sineSquare * cosineSignal * cosineSignal
    + cosineSquare * sineSignal * sineSignal
    - 2 * cross * cosineSignal * sineSignal;
  return Math.max(0, numerator / (2 * determinant));
}

/**
 * Integra la potencia del espectro dentro de una banda.
 *
 * @param frequenciesHz Frecuencias del espectro.
 * @param power Potencia de cada frecuencia.
 * @param band Límites inclusivos de la banda.
 * @returns Potencia integrada.
 */
function integrateBand(
  frequenciesHz: readonly number[],
  power: readonly number[],
  band: readonly [number, number],
): number {
  let integrated = 0;
  for (let index = 0; index < frequenciesHz.length; index += 1) {
    const frequency = frequenciesHz[index];
    const value = power[index];
    if (frequency === undefined || value === undefined) continue;
    if (frequency >= band[0] && frequency <= band[1]) integrated += value;
  }
  return integrated;
}

/**
 * Valida los intervalos RR de entrada.
 *
 * @param intervals Intervalos RR en milisegundos.
 * @returns Copia validada de los intervalos.
 */
function validateIntervals(intervals: readonly number[]): number[] {
  const validated: number[] = [];
  for (const interval of intervals) {
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new BiometricsError("invalid_input", "Los intervalos RR deben ser positivos y finitos.");
    }
    validated.push(interval);
  }
  return validated;
}

/**
 * Valida la configuración completa del pipeline.
 *
 * @param config Configuración que se debe comprobar.
 */
function validatePipelineConfig(config: BiometricPipelineConfig): void {
  requirePositive(config.windowMs, "windowMs");
  requirePositive(config.maxSamples, "maxSamples");
  requirePositive(config.minHrvSamples, "minHrvSamples");
  requirePositive(config.baevskyBaselineRmssdMs, "baevskyBaselineRmssdMs");
  requirePositive(config.lombScargleFrequencies, "lombScargleFrequencies");
  if (config.emaAlpha !== undefined && (config.emaAlpha <= 0 || config.emaAlpha > 1)) {
    throw new BiometricsError("configuration", "emaAlpha debe estar en el intervalo (0, 1].");
  }
  requireScore(config.stressAlertThreshold, "stressAlertThreshold");
  requireScore(config.stressRecoveryThreshold, "stressRecoveryThreshold");
  const alertThreshold = config.stressAlertThreshold ?? DEFAULT_ALERT_THRESHOLD;
  const recoveryThreshold = config.stressRecoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD;
  if (recoveryThreshold > alertThreshold) {
    throw new BiometricsError(
      "configuration",
      "stressRecoveryThreshold no puede superar stressAlertThreshold.",
    );
  }
  if (config.stressZoneThresholds !== undefined) {
    const thresholds = config.stressZoneThresholds;
    if (
      thresholds.recovery < 0
      || thresholds.recovery >= thresholds.low
      || thresholds.low >= thresholds.medium
      || thresholds.medium > 100
    ) {
      throw new BiometricsError(
        "configuration",
        "Los límites de zonas de estrés deben ser estrictos y estar dentro de 0..100.",
      );
    }
  }
}

/**
 * Exige un número positivo en una configuración opcional.
 *
 * @param value Valor que se debe validar.
 * @param name Nombre público de la opción.
 */
function requirePositive(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new BiometricsError("configuration", `${name} debe ser un número positivo.`);
  }
}

/**
 * Exige una puntuación dentro del intervalo de 0 a 100.
 *
 * @param value Valor que se debe validar.
 * @param name Nombre público de la opción.
 */
function requireScore(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
    throw new BiometricsError("configuration", `${name} debe estar entre 0 y 100.`);
  }
}

/**
 * Valida los campos de una muestra biométrica.
 *
 * @param sample Muestra que se debe comprobar.
 */
function validateSample(sample: BiometricSample): void {
  if (!Number.isFinite(sample.ts) || sample.ts < 0) {
    throw new BiometricsError("invalid_input", "La marca temporal de la muestra no es válida.");
  }
  if (!VALID_SOURCES.has(sample.source)) {
    throw new BiometricsError("invalid_input", `El origen biométrico '${sample.source}' no es válido.`);
  }
  validateOptionalRange(sample.heartRate, 1, 300, "heartRate");
  validateOptionalRange(sample.hrvMs, Number.MIN_VALUE, 60_000, "hrvMs");
  validateOptionalRange(sample.spo2, 0, 100, "spo2");
  validateOptionalRange(sample.temperatureC, -100, 100, "temperatureC");
  validateOptionalRange(sample.stressScore, 0, 100, "stressScore");
  validateOptionalRange(sample.sleepScore, 0, 100, "sleepScore");
}

/**
 * Valida un campo numérico opcional y su rango.
 *
 * @param value Valor opcional que se debe validar.
 * @param minimum Límite inferior.
 * @param maximum Límite superior.
 * @param name Nombre del campo.
 */
function validateOptionalRange(
  value: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new BiometricsError("invalid_input", `El campo '${name}' está fuera de su rango válido.`);
  }
}

/**
 * Acota un valor numérico al intervalo indicado.
 *
 * @param value Valor de entrada.
 * @param minimum Límite inferior.
 * @param maximum Límite superior.
 * @returns Valor acotado.
 */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Copia un estado para impedir mutaciones accidentales desde el exterior.
 *
 * @param state Estado original.
 * @returns Copia superficial segura del estado.
 */
function copyState(state: BiometricState): BiometricState {
  return {
    ...state,
    sample: { ...state.sample },
    ...(state.hrv === undefined ? {} : { hrv: { ...state.hrv } }),
    ...(state.alert === undefined ? {} : { alert: { ...state.alert, sample: { ...state.alert.sample } } }),
  };
}
