import { createGarminBridge } from "./bridges/garmin.js";
import { createOuraBridge } from "./bridges/oura.js";
import { createPolarBridge } from "./bridges/polar.js";
import { Esp32Bridge } from "./bridges/esp32.js";
import { createBiometricPipeline } from "./pipeline.js";
import { createVad } from "./vad.js";
import { createVoiceprint } from "./voiceprint.js";
import type { GarminBridge } from "./bridges/garmin.js";
import type { OuraBridge } from "./bridges/oura.js";
import type { PolarBridge } from "./bridges/polar.js";
import type { BiometricPipeline } from "./pipeline.js";
import type { VoiceActivityDetector } from "./vad.js";
import type { VoiceprintManager } from "./voiceprint.js";
import type {
  BiometricSample,
  BiometricState,
  BiometricsConfig,
  Esp32BridgeConfig,
} from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export * from "./pipeline.js";
export * from "./voiceprint.js";
export * from "./vad.js";
export * from "./bridges/common.js";
export * from "./bridges/garmin.js";
export * from "./bridges/oura.js";
export * from "./bridges/polar.js";
export * from "./bridges/esp32.js";

/**
 * Bridges disponibles en una instancia de biometría.
 */
export interface BiometricsBridges {
  /** Bridge de Garmin Health API. */
  garmin?: GarminBridge;
  /** Bridge de Oura API v2. */
  oura?: OuraBridge;
  /** Bridge de Polar AccessLink API v3. */
  polar?: PolarBridge;
  /** Bridge del dispositivo ESP32. */
  esp32?: Esp32Bridge;
}

/**
 * Fachada funcional del subsistema biométrico.
 */
export interface BiometricsRuntime {
  /** Pipeline HRV, estrés, tendencia y alertas. */
  pipeline: BiometricPipeline;
  /** Gestor de huellas vocales. */
  voiceprint: VoiceprintManager;
  /** Detector de actividad de voz. */
  vad: VoiceActivityDetector;
  /** Bridges construidos a partir de la configuración. */
  bridges: BiometricsBridges;
  /**
   * Añade una muestra al pipeline.
   *
   * @param sample Muestra que se debe procesar.
   * @returns Estado biométrico calculado.
   */
  push(sample: BiometricSample): Promise<BiometricState>;
  /**
   * Recupera el estado actual.
   *
   * @returns Estado actual o `undefined` si no hay muestras.
   */
  current(): BiometricState | undefined;
  /**
   * Recupera el historial calculado.
   *
   * @param since Inicio inclusivo opcional en milisegundos desde Unix.
   * @returns Estados ordenados cronológicamente.
   */
  history(since?: number): BiometricState[];
}

/**
 * Crea la fachada de biometría con pipeline, voz, VAD y bridges configurados.
 *
 * @param config Configuración agregada; las partes omitidas usan valores por defecto.
 * @returns Fachada lista para recibir muestras y usar sus servicios.
 */
export function createBiometrics(config: BiometricsConfig = {}): BiometricsRuntime {
  const pipeline = createBiometricPipeline(config.pipeline);
  const voiceprint = createVoiceprint(config.voiceprint);
  const vad = createVad(config.vad);
  const bridges: BiometricsBridges = {};

  const garminConfig = config.bridges?.garmin;
  if (garminConfig !== undefined) bridges.garmin = createGarminBridge(garminConfig);
  const ouraConfig = config.bridges?.oura;
  if (ouraConfig !== undefined) bridges.oura = createOuraBridge(ouraConfig);
  const polarConfig = config.bridges?.polar;
  if (polarConfig !== undefined) bridges.polar = createPolarBridge(polarConfig);

  const esp32Config = config.bridges?.esp32;
  if (esp32Config !== undefined) {
    bridges.esp32 = createEsp32Bridge(pipeline, esp32Config);
  }

  return {
    pipeline,
    voiceprint,
    vad,
    bridges,
    push: (sample) => pipeline.push(sample),
    current: () => pipeline.getCurrent(),
    history: (since) => pipeline.getHistory(since),
  };
}

/**
 * Construye un bridge ESP32 conectado al pipeline de la fachada.
 *
 * @param pipeline Pipeline que recibe las muestras del dispositivo.
 * @param config Configuración del bridge ESP32.
 * @returns Bridge ESP32 listo para iniciar.
 */
function createEsp32Bridge(pipeline: BiometricPipeline, config: Esp32BridgeConfig): Esp32Bridge {
  const userCallback = config.onSample;
  return new Esp32Bridge({
    ...config,
    onSample: async (sample) => {
      await pipeline.push(sample);
      await userCallback?.(sample);
    },
  });
}
