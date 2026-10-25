import { BiometricsError } from "../errors.js";
import type { BiometricBridge, BiometricSample, PolarBridgeConfig } from "../types.js";
import {
  OAuth2Client,
  formatUtcDate,
  isRecord,
  mergeBiometricSamples,
  readArray,
  readNumber,
  readRecord,
  readString,
  validateDateRange,
} from "./common.js";

const DEFAULT_AUTHORIZATION_URL = "https://flow.polar.com/oauth2/authorization";
const DEFAULT_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
const DEFAULT_BASE_URL = "https://www.polaraccesslink.com";
const DEFAULT_SCOPES: readonly string[] = ["accesslink.read_all"];
const MAX_ACCESSLINK_RANGE_MS = 28 * 24 * 60 * 60 * 1_000;

/**
 * Cliente de Polar AccessLink API v3 con OAuth2 y métricas de salud normalizadas.
 */
export class PolarBridge implements BiometricBridge {
  /** Proveedor de las muestras normalizadas. */
  readonly source = "polar" as const;
  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;

  /**
   * Crea un bridge de Polar.
   *
   * @param config Credenciales OAuth2, tokenStore, transporte y endpoints.
   */
  constructor(private readonly config: PolarBridgeConfig) {
    this.oauth = new OAuth2Client({
      provider: "polar",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenUrl: config.tokenUrl ?? DEFAULT_TOKEN_URL,
      authorizationUrl: config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
      scopes: config.scopes ?? DEFAULT_SCOPES,
      tokenStore: config.tokenStore,
      tokenKey: config.tokenKey ?? "polar",
      fetchImpl: config.fetch ?? globalThis.fetch,
      timeoutMs: config.timeoutMs,
      credentialStyle: "basic",
    });
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Construye la URL de autorización de Polar.
   *
   * @param state Estado opaco de protección CSRF.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns URL de autorización OAuth2.
   */
  getAuthorizationUrl(state: string, redirectUri?: string): string {
    return this.oauth.getAuthorizationUrl(state, redirectUri);
  }

  /**
   * Canjea un código de autorización de Polar.
   *
   * @param code Código de un solo uso.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns Token almacenado en el tokenStore inyectado.
   */
  async exchangeAuthorizationCode(code: string, redirectUri?: string) {
    return this.oauth.exchangeAuthorizationCode(code, redirectUri);
  }

  /**
   * Renueva el token de Polar.
   *
   * @param refreshToken Token de renovación actual.
   * @returns Token renovado y almacenado.
   */
  async refreshAccessToken(refreshToken: string) {
    return this.oauth.refreshAccessToken(refreshToken);
  }

  /**
   * Descarga y normaliza datos de Polar AccessLink API v3.
   *
   * Utiliza los recursos reales de frecuencia cardíaca continua, sueño,
   * SpO2 y temperatura corporal. AccessLink limita los recursos de
   * biosensing a un intervalo máximo de 28 días.
   *
   * @param start Inicio inclusivo del intervalo.
   * @param end Fin inclusivo del intervalo.
   * @returns Muestras de Polar ordenadas cronológicamente.
   */
  async fetchSamples(start: Date | number, end: Date | number): Promise<BiometricSample[]> {
    const { startMs, endMs } = validateDateRange(start, end);
    if (endMs - startMs > MAX_ACCESSLINK_RANGE_MS) {
      throw new BiometricsError(
        "invalid_input",
        "Polar AccessLink limita el intervalo consultado a 28 días.",
      );
    }
    const query = new URLSearchParams({
      from: formatUtcDate(startMs),
      to: formatUtcDate(endMs),
    });
    const samples: BiometricSample[] = [];

    const continuousHeartRate = await this.oauth.requestJson(
      `${this.baseUrl}/v3/users/continuous-heart-rate?${query.toString()}`,
    );
    samples.push(...mapPolarContinuousHeartRate(continuousHeartRate, startMs, endMs));

    const sleep = await this.oauth.requestJson(`${this.baseUrl}/v3/users/sleep`);
    samples.push(...mapPolarSleep(sleep, startMs, endMs));

    const spo2 = await this.oauth.requestJson(
      `${this.baseUrl}/v3/users/biosensing/spo2?${query.toString()}`,
    );
    samples.push(...mapPolarSpo2(spo2, startMs, endMs));

    const temperature = await this.oauth.requestJson(
      `${this.baseUrl}/v3/users/biosensing/bodytemperature?${query.toString()}`,
    );
    samples.push(...mapPolarTemperature(temperature, startMs, endMs));

    return mergeBiometricSamples(samples);
  }
}

/**
 * Crea un bridge de Polar AccessLink API v3.
 *
 * @param config Configuración del bridge.
 * @returns Cliente listo para consultar métricas.
 */
export function createPolarBridge(config: PolarBridgeConfig): PolarBridge {
  return new PolarBridge(config);
}

/**
 * Mapea la respuesta de frecuencia cardíaca continua de Polar.
 *
 * @param payload Respuesta JSON de `continuous-heart-rate`.
 * @param startMs Inicio inclusivo del filtro local.
 * @param endMs Fin inclusivo del filtro local.
 * @returns Muestras con frecuencia cardíaca.
 */
function mapPolarContinuousHeartRate(
  payload: unknown,
  startMs: number,
  endMs: number,
): BiometricSample[] {
  const roots = Array.isArray(payload) ? payload : [payload];
  const samples: BiometricSample[] = [];
  for (const root of roots) {
    if (!isRecord(root)) continue;
    const date = readString(root, ["date"]);
    const heartRateSamples = readArray(root, ["heart_rate_samples"]) ?? [];
    for (const entry of heartRateSamples) {
      if (!isRecord(entry)) continue;
      const heartRate = readNumber(entry, ["heart_rate"]);
      const sampleTime = readString(entry, ["sample_time"]);
      if (heartRate === undefined || date === undefined || sampleTime === undefined) continue;
      const timestamp = Date.parse(`${date}T${sampleTime}Z`);
      if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp > endMs) continue;
      samples.push({ ts: timestamp, heartRate, source: "polar" });
    }
  }
  return samples;
}

/**
 * Mapea noches y muestras de sueño de Polar.
 *
 * @param payload Respuesta JSON de `sleep`.
 * @param startMs Inicio inclusivo del filtro local.
 * @param endMs Fin inclusivo del filtro local.
 * @returns Muestras con sueño y frecuencia cardíaca.
 */
function mapPolarSleep(payload: unknown, startMs: number, endMs: number): BiometricSample[] {
  const nights = readArray(payload, ["nights"]) ?? [];
  const samples: BiometricSample[] = [];
  for (const night of nights) {
    if (!isRecord(night)) continue;
    const date = readString(night, ["date"]);
    const sleepEnd = readString(night, ["sleep_end_time"]);
    const sleepScore = readNumber(night, ["sleep_score"]);
    if (date !== undefined && sleepEnd !== undefined && sleepScore !== undefined) {
      const timestamp = Date.parse(sleepEnd);
      if (Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs) {
        samples.push({ ts: timestamp, sleepScore, source: "polar" });
      }
    }

    const heartRateSamples = readRecord(night, ["heart_rate_samples"]);
    if (heartRateSamples === undefined || date === undefined) continue;
    for (const [sampleTime, value] of Object.entries(heartRateSamples)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const timestamp = Date.parse(`${date}T${sampleTime}:00Z`);
      if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp > endMs) continue;
      samples.push({ ts: timestamp, heartRate: value, source: "polar" });
    }
  }
  return samples;
}

/**
 * Mapea resultados de SpO2 de Polar.
 *
 * @param payload Respuesta JSON de `biosensing/spo2`.
 * @param startMs Inicio inclusivo del filtro local.
 * @param endMs Fin inclusivo del filtro local.
 * @returns Muestras con SpO2, frecuencia cardíaca y HRV.
 */
function mapPolarSpo2(payload: unknown, startMs: number, endMs: number): BiometricSample[] {
  const records = Array.isArray(payload) ? payload : [];
  const samples: BiometricSample[] = [];
  for (const record of records) {
    if (!isRecord(record)) continue;
    const testTime = readNumber(record, ["test_time"]);
    const spo2 = readNumber(record, ["blood_oxygen_percent"]);
    if (testTime === undefined || spo2 === undefined) continue;
    const timestamp = testTime * 1_000;
    if (timestamp < startMs || timestamp > endMs) continue;
    const heartRate = readNumber(record, ["average_heart_rate_bpm"]);
    const hrvMs = readNumber(record, ["heart_rate_variability_ms"]);
    samples.push({
      ts: timestamp,
      spo2,
      ...(heartRate === undefined ? {} : { heartRate }),
      ...(hrvMs === undefined ? {} : { hrvMs }),
      source: "polar",
    });
  }
  return samples;
}

/**
 * Mapea periodos de temperatura corporal de Polar.
 *
 * @param payload Respuesta JSON de `biosensing/bodytemperature`.
 * @param startMs Inicio inclusivo del filtro local.
 * @param endMs Fin inclusivo del filtro local.
 * @returns Muestras con temperatura.
 */
function mapPolarTemperature(payload: unknown, startMs: number, endMs: number): BiometricSample[] {
  const periods = Array.isArray(payload) ? payload : [];
  const samples: BiometricSample[] = [];
  for (const period of periods) {
    if (!isRecord(period)) continue;
    const startTime = readString(period, ["start_time"]);
    const periodSamples = readArray(period, ["samples"]) ?? [];
    for (const sample of periodSamples) {
      if (!isRecord(sample)) continue;
      const temperatureC = readNumber(sample, ["temperature_celsius"]);
      const deltaMs = readNumber(sample, ["recording_time_delta_milliseconds"]) ?? 0;
      if (temperatureC === undefined || startTime === undefined) continue;
      const timestamp = Date.parse(`${startTime}Z`) + deltaMs;
      if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp > endMs) continue;
      samples.push({ ts: timestamp, temperatureC, source: "polar" });
    }
  }
  return samples;
}
