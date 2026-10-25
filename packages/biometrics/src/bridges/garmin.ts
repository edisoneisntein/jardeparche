import type { BiometricBridge, BiometricSample, GarminBridgeConfig } from "../types.js";
import {
  OAuth2Client,
  isRecord,
  mergeBiometricSamples,
  readNumber,
  readRecord,
  readString,
  validateDateRange,
} from "./common.js";

const DEFAULT_AUTHORIZATION_URL = "https://connect.garmin.com/oauth2-connect/auth";
const DEFAULT_TOKEN_URL = "https://connect.garmin.com/oauth2-connect/token";
const DEFAULT_BASE_URL = "https://apis.garmin.com/wellness-api/rest";
const DEFAULT_SCOPES: readonly string[] = ["CONNECT_READ"];

/**
 * Cliente de Garmin Health API compatible con OAuth2 y Wellness REST API.
 */
export class GarminBridge implements BiometricBridge {
  /** Proveedor de las muestras normalizadas. */
  readonly source = "garmin" as const;
  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;

  /**
   * Crea un bridge de Garmin.
   *
   * @param config Credenciales OAuth2, tokenStore, transporte y endpoints.
   * @throws BiometricsError si la configuración OAuth no es válida.
   */
  constructor(private readonly config: GarminBridgeConfig) {
    this.oauth = new OAuth2Client({
      provider: "garmin",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenUrl: config.tokenUrl ?? DEFAULT_TOKEN_URL,
      authorizationUrl: config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
      redirectUri: config.redirectUri,
      scopes: config.scopes ?? DEFAULT_SCOPES,
      tokenStore: config.tokenStore,
      tokenKey: config.tokenKey ?? "garmin",
      fetchImpl: config.fetch ?? globalThis.fetch,
      timeoutMs: config.timeoutMs,
      credentialStyle: "body",
    });
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Construye la URL de autorización de Garmin.
   *
   * @param state Estado opaco de protección CSRF.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns URL de autorización OAuth2.
   */
  getAuthorizationUrl(state: string, redirectUri?: string): string {
    return this.oauth.getAuthorizationUrl(state, redirectUri);
  }

  /**
   * Canjea un código de autorización de Garmin.
   *
   * @param code Código de un solo uso.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns Token almacenado en el tokenStore inyectado.
   */
  async exchangeAuthorizationCode(code: string, redirectUri?: string) {
    return this.oauth.exchangeAuthorizationCode(code, redirectUri);
  }

  /**
   * Renueva el token de Garmin.
   *
   * @param refreshToken Token de renovación actual.
   * @returns Token renovado y almacenado.
   */
  async refreshAccessToken(refreshToken: string) {
    return this.oauth.refreshAccessToken(refreshToken);
  }

  /**
   * Descarga y normaliza métricas diarias de Garmin.
   *
   * Usa los endpoints reales `heart_rates`, `heart_rate_variability`,
   * `stress`, `sleep` y `pulse_ox` de Garmin Wellness API. Los resúmenes que
   * comparten `calendarDate` se combinan en una sola muestra.
   *
   * @param start Inicio inclusivo del intervalo.
   * @param end Fin inclusivo del intervalo.
   * @param signal Señal opcional que cancela las peticiones REST pendientes.
   * @returns Muestras de Garmin ordenadas cronológicamente.
   */
  async fetchSamples(
    start: Date | number,
    end: Date | number,
    signal?: AbortSignal,
  ): Promise<BiometricSample[]> {
    const { startMs, endMs } = validateDateRange(start, end);
    const query = new URLSearchParams({
      uploadStartTimeInSeconds: String(Math.floor(startMs / 1_000)),
      uploadEndTimeInSeconds: String(Math.floor(endMs / 1_000)),
    });
    const samples: BiometricSample[] = [];

    const heartRates = await this.requestEndpoint("heart_rates", query, signal);
    samples.push(...mapGarminHeartRates(heartRates));

    const hrv = await this.requestEndpoint("heart_rate_variability", query, signal);
    samples.push(...mapGarminHrv(hrv));

    const stress = await this.requestEndpoint("stress", query, signal);
    samples.push(...mapGarminStress(stress));

    const sleep = await this.requestEndpoint("sleep", query, signal);
    samples.push(...mapGarminSleep(sleep));

    const pulseOx = await this.requestEndpoint("pulse_ox", query, signal);
    samples.push(...mapGarminPulseOx(pulseOx));

    return mergeBiometricSamples(samples);
  }

  /**
   * Solicita uno de los endpoints diarios de Garmin.
   *
   * @param endpoint Nombre REST del recurso.
   * @param query Parámetros temporales comunes.
   * @param signal Señal opcional de cancelación externa.
   * @returns Contenido JSON desconocido de Garmin.
   */
  private async requestEndpoint(
    endpoint: string,
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/${endpoint}?${query.toString()}`;
    return this.oauth.requestJson(url, {}, signal);
  }
}

/**
 * Crea un bridge de Garmin Health API.
 *
 * @param config Configuración del bridge.
 * @returns Cliente listo para consultar métricas.
 */
export function createGarminBridge(config: GarminBridgeConfig): GarminBridge {
  return new GarminBridge(config);
}

/**
 * Mapea resúmenes de frecuencia cardíaca de Garmin.
 *
 * @param payload Respuesta JSON de `heart_rates`.
 * @returns Muestras con frecuencia cardíaca.
 */
function mapGarminHeartRates(payload: unknown): BiometricSample[] {
  return asRecords(payload).flatMap((record) => {
    const summary = readRecord(record, ["summaryDTO"]) ?? record;
    const timestamp = garminTimestamp(record, summary);
    if (timestamp === undefined) return [];
    const heartRate = readNumber(summary, ["restingHeartRate"])
      ?? readNumber(summary, ["averageHeartRate"])
      ?? readNumber(summary, ["heartRate"])
      ?? readNumber(summary, ["lastHeartRate"]);
    if (heartRate === undefined) return [];
    return [{ ts: timestamp, heartRate, source: "garmin" }];
  });
}

/**
 * Mapea resúmenes de HRV de Garmin.
 *
 * @param payload Respuesta JSON de `heart_rate_variability`.
 * @returns Muestras con HRV.
 */
function mapGarminHrv(payload: unknown): BiometricSample[] {
  return asRecords(payload).flatMap((record) => {
    const summary = readRecord(record, ["hrvSummaryDTO"]) ?? record;
    const timestamp = garminTimestamp(record, summary);
    if (timestamp === undefined) return [];
    const hrvMs = readNumber(summary, ["lastNightAvg"])
      ?? readNumber(summary, ["weeklyAvg"])
      ?? readNumber(summary, ["lastNight5MinHigh"])
      ?? readNumber(summary, ["hrvValue"]);
    if (hrvMs === undefined) return [];
    return [{ ts: timestamp, hrvMs, source: "garmin" }];
  });
}

/**
 * Mapea resúmenes de estrés de Garmin.
 *
 * @param payload Respuesta JSON de `stress`.
 * @returns Muestras con puntuación de estrés.
 */
function mapGarminStress(payload: unknown): BiometricSample[] {
  return asRecords(payload).flatMap((record) => {
    const summary = readRecord(record, ["stressSummaryDTO"]) ?? record;
    const timestamp = garminTimestamp(record, summary);
    if (timestamp === undefined) return [];
    const stressScore = readNumber(summary, ["overallStressLevel"])
      ?? readNumber(summary, ["restStressLevel"])
      ?? readNumber(summary, ["activityStressLevel"]);
    if (stressScore === undefined) return [];
    return [{ ts: timestamp, stressScore, source: "garmin" }];
  });
}

/**
 * Mapea resúmenes de sueño de Garmin.
 *
 * @param payload Respuesta JSON de `sleep`.
 * @returns Muestras con puntuación de sueño cuando el recurso la publica.
 */
function mapGarminSleep(payload: unknown): BiometricSample[] {
  return asRecords(payload).flatMap((record) => {
    const summary = readRecord(record, ["sleepSummaryDTO"]) ?? record;
    const timestamp = garminTimestamp(record, summary);
    if (timestamp === undefined) return [];
    const sleepScore = readNumber(summary, ["sleepScore"]);
    if (sleepScore === undefined) return [];
    return [{ ts: timestamp, sleepScore, source: "garmin" }];
  });
}

/**
 * Mapea resúmenes de saturación de oxígeno de Garmin.
 *
 * @param payload Respuesta JSON de `pulse_ox`.
 * @returns Muestras con SpO2.
 */
function mapGarminPulseOx(payload: unknown): BiometricSample[] {
  return asRecords(payload).flatMap((record) => {
    const summary = readRecord(record, ["pulseOxSummaryDTO"]) ?? record;
    const timestamp = garminTimestamp(record, summary);
    if (timestamp === undefined) return [];
    const spo2 = readNumber(summary, ["averageSpO2"])
      ?? readNumber(summary, ["avgSleepSpO2"])
      ?? readNumber(summary, ["lowestSpO2"]);
    if (spo2 === undefined) return [];
    return [{ ts: timestamp, spo2, source: "garmin" }];
  });
}

/**
 * Extrae la marca temporal de un resumen diario de Garmin.
 *
 * @param record Registro raíz de la respuesta.
 * @param summary DTO de resumen del recurso.
 * @returns Instante en milisegundos o `undefined` si no existe fecha válida.
 */
function garminTimestamp(record: unknown, summary: unknown): number | undefined {
  const calendar = readRecord(summary, ["calendarDate"]) ?? readRecord(record, ["calendarDate"]);
  if (calendar !== undefined) {
    const year = readNumber(calendar, ["year"]);
    const month = readNumber(calendar, ["month"]);
    const day = readNumber(calendar, ["day"]);
    if (year !== undefined && month !== undefined && day !== undefined) {
      return Date.UTC(year, month - 1, day);
    }
  }
  const isoTimestamp = readString(record, ["timestamp"]) ?? readString(summary, ["timestamp"]);
  if (isoTimestamp !== undefined) {
    const parsed = Date.parse(isoTimestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const epoch = readNumber(record, ["timestamp"]) ?? readNumber(summary, ["timestamp"]);
  if (epoch !== undefined) return epoch > 10_000_000_000 ? epoch : epoch * 1_000;
  const date = readString(record, ["date"]) ?? readString(summary, ["date"]);
  if (date !== undefined) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Normaliza una respuesta de Garmin a una lista de registros.
 *
 * @param payload Respuesta JSON desconocida.
 * @returns Registros JSON.
 */
function asRecords(payload: unknown): Record<string, unknown>[] {
  const records = Array.isArray(payload) ? payload : [payload];
  return records.filter(isRecord);
}
