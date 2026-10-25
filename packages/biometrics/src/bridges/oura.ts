import type { BiometricBridge, BiometricSample, OuraBridgeConfig } from "../types.js";
import {
  OAuth2Client,
  formatUtcDate,
  mergeBiometricSamples,
  readArray,
  readNumber,
  readString,
  validateDateRange,
} from "./common.js";

const DEFAULT_AUTHORIZATION_URL = "https://api.ouraring.com/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const DEFAULT_BASE_URL = "https://api.ouraring.com";
const DEFAULT_SCOPES: readonly string[] = [
  "email",
  "personal",
  "daily",
  "heart_rate",
  "sleep",
  "spo2",
];

/**
 * Cliente de Oura API v2 con OAuth2 y métricas biométricas normalizadas.
 */
export class OuraBridge implements BiometricBridge {
  /** Proveedor de las muestras normalizadas. */
  readonly source = "oura" as const;
  private readonly oauth: OAuth2Client;
  private readonly baseUrl: string;

  /**
   * Crea un bridge de Oura.
   *
   * @param config Credenciales OAuth2, tokenStore, transporte y endpoints.
   */
  constructor(private readonly config: OuraBridgeConfig) {
    this.oauth = new OAuth2Client({
      provider: "oura",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      tokenUrl: config.tokenUrl ?? DEFAULT_TOKEN_URL,
      authorizationUrl: config.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
      redirectUri: config.redirectUri,
      scopes: config.scopes ?? DEFAULT_SCOPES,
      tokenStore: config.tokenStore,
      tokenKey: config.tokenKey ?? "oura",
      fetchImpl: config.fetch ?? globalThis.fetch,
      timeoutMs: config.timeoutMs,
      credentialStyle: "basic",
    });
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  /**
   * Construye la URL de autorización de Oura.
   *
   * @param state Estado opaco de protección CSRF.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns URL de autorización OAuth2.
   */
  getAuthorizationUrl(state: string, redirectUri?: string): string {
    return this.oauth.getAuthorizationUrl(state, redirectUri);
  }

  /**
   * Canjea un código de autorización de Oura.
   *
   * @param code Código de un solo uso.
   * @param redirectUri Redirección opcional que sustituye a la configurada.
   * @returns Token almacenado en el tokenStore inyectado.
   */
  async exchangeAuthorizationCode(code: string, redirectUri?: string) {
    return this.oauth.exchangeAuthorizationCode(code, redirectUri);
  }

  /**
   * Renueva el token de Oura.
   *
   * @param refreshToken Token de renovación actual.
   * @returns Token renovado y almacenado.
   */
  async refreshAccessToken(refreshToken: string) {
    return this.oauth.refreshAccessToken(refreshToken);
  }

  /**
   * Descarga y normaliza métricas diarias de Oura API v2.
   *
   * Consulta `daily_heart_rate`, `daily_hrv`, `daily_spo2`, `daily_sleep` y
   * `daily_stress`. Los recursos que comparten timestamp se combinan en una
   * única muestra, sin interpolar valores ausentes.
   *
   * @param start Inicio inclusivo del intervalo.
   * @param end Fin inclusivo del intervalo.
   * @param signal Señal opcional que cancela las peticiones REST pendientes.
   * @returns Muestras de Oura ordenadas cronológicamente.
   */
  async fetchSamples(
    start: Date | number,
    end: Date | number,
    signal?: AbortSignal,
  ): Promise<BiometricSample[]> {
    const { startMs, endMs } = validateDateRange(start, end);
    const query = new URLSearchParams({
      start_date: formatUtcDate(startMs),
      end_date: formatUtcDate(endMs),
    });
    const samples: BiometricSample[] = [];

    const heartRate = await this.requestCollection("daily_heart_rate", query, signal);
    samples.push(...mapOuraHeartRate(heartRate));

    const hrv = await this.requestCollection("daily_hrv", query, signal);
    samples.push(...mapOuraHrv(hrv));

    const spo2 = await this.requestCollection("daily_spo2", query, signal);
    samples.push(...mapOuraSpo2(spo2));

    const sleep = await this.requestCollection("daily_sleep", query, signal);
    samples.push(...mapOuraSleep(sleep));

    const stress = await this.requestCollection("daily_stress", query, signal);
    samples.push(...mapOuraStress(stress));

    return mergeBiometricSamples(samples);
  }

  /**
   * Solicita una colección de Oura API v2.
   *
   * @param collection Nombre de la colección.
   * @param query Rango de fechas ISO.
   * @param signal Señal opcional de cancelación externa.
   * @returns Contenido JSON desconocido de Oura.
   */
  private async requestCollection(
    collection: string,
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/v2/usercollection/${collection}?${query.toString()}`;
    return this.oauth.requestJson(url, {}, signal);
  }
}

/**
 * Crea un bridge de Oura API v2.
 *
 * @param config Configuración del bridge.
 * @returns Cliente listo para consultar métricas.
 */
export function createOuraBridge(config: OuraBridgeConfig): OuraBridge {
  return new OuraBridge(config);
}

/**
 * Mapea la colección diaria de frecuencia cardíaca de Oura.
 *
 * @param payload Respuesta JSON de `daily_heart_rate`.
 * @returns Muestras con frecuencia cardíaca.
 */
function mapOuraHeartRate(payload: unknown): BiometricSample[] {
  return ouraRecords(payload).flatMap((record) => {
    const timestamp = ouraTimestamp(record);
    if (timestamp === undefined) return [];
    const heartRate = readNumber(record, ["contributors", "resting_heart_rate"])
      ?? readNumber(record, ["contributors", "average_heart_rate"])
      ?? readNumber(record, ["contributors", "lowest_heart_rate"]);
    if (heartRate === undefined) return [];
    return [{ ts: timestamp, heartRate, source: "oura" }];
  });
}

/**
 * Mapea la colección diaria de HRV de Oura.
 *
 * @param payload Respuesta JSON de `daily_hrv`.
 * @returns Muestras con RMSSD publicado por Oura.
 */
function mapOuraHrv(payload: unknown): BiometricSample[] {
  return ouraRecords(payload).flatMap((record) => {
    const timestamp = ouraTimestamp(record);
    if (timestamp === undefined) return [];
    const hrvMs = readNumber(record, ["contributors", "hrv", "rmssd"])
      ?? readNumber(record, ["contributors", "hrv"])
      ?? readNumber(record, ["contributors", "rmssd"]);
    if (hrvMs === undefined) return [];
    return [{ ts: timestamp, hrvMs, source: "oura" }];
  });
}

/**
 * Mapea la colección diaria de saturación de oxígeno de Oura.
 *
 * Admite el campo agregado actual `spo2_percentage.average` y las formas
 * históricas `contributors.spo2.average` y `contributors.average_spo2`.
 *
 * @param payload Respuesta JSON de `daily_spo2`.
 * @returns Muestras con SpO2.
 */
function mapOuraSpo2(payload: unknown): BiometricSample[] {
  return ouraRecords(payload).flatMap((record) => {
    const timestamp = ouraTimestamp(record);
    if (timestamp === undefined) return [];
    const spo2 = readNumber(record, ["spo2_percentage", "average"])
      ?? readNumber(record, ["contributors", "spo2", "average"])
      ?? readNumber(record, ["contributors", "spo2"])
      ?? readNumber(record, ["contributors", "average_spo2"]);
    if (spo2 === undefined) return [];
    return [{ ts: timestamp, spo2, source: "oura" }];
  });
}

/**
 * Mapea la colección diaria de sueño de Oura.
 *
 * Oura publica la puntuación diaria en `score`; el campo histórico
 * `contributors.sleep_score` también se acepta para Integraciones previas.
 *
 * @param payload Respuesta JSON de `daily_sleep`.
 * @returns Muestras con puntuación de sueño.
 */
function mapOuraSleep(payload: unknown): BiometricSample[] {
  return ouraRecords(payload).flatMap((record) => {
    const timestamp = ouraTimestamp(record);
    if (timestamp === undefined) return [];
    const sleepScore = readNumber(record, ["score"])
      ?? readNumber(record, ["contributors", "sleep_score"]);
    if (sleepScore === undefined) return [];
    return [{ ts: timestamp, sleepScore, source: "oura" }];
  });
}

/**
 * Mapea la colección diaria de estrés de Oura.
 *
 * Una puntuación numérica se conserva directamente. El resumen textual real
 * de Oura se traduce con una calibración fija: `restored` vale 20, `normal`
 * vale 50 y `stressful` vale 80. Si una colección_histórica aporta
 * `recovery_index`, se transforma de forma determinista a estrés como
 * `100 - recovery_index`, respetando la semántica inversa del índice.
 *
 * @param payload Respuesta JSON de `daily_stress`.
 * @returns Muestras con puntuación de estrés.
 */
function mapOuraStress(payload: unknown): BiometricSample[] {
  return ouraRecords(payload).flatMap((record) => {
    const timestamp = ouraTimestamp(record);
    if (timestamp === undefined) return [];
    const directScore = readNumber(record, ["stress_score"])
      ?? readNumber(record, ["contributors", "stress_score"]);
    const recoveryIndex = readNumber(record, ["contributors", "recovery_index"]);
    const summaryScore = mapOuraStressSummary(readString(record, ["day_summary"]));
    const stressScore = directScore
      ?? summaryScore
      ?? (recoveryIndex === undefined ? undefined : 100 - recoveryIndex);
    if (stressScore === undefined) return [];
    return [{ ts: timestamp, stressScore, source: "oura" }];
  });
}

/**
 * Traduce el resumen textual oficial de estrés diario de Oura a una escala
 * numérica estable para el modelo biométrico común.
 *
 * @param summary Resumen `restored`, `normal` o `stressful`.
 * @returns Puntuación de estrés o `undefined` si el resumen no es reconocido.
 */
function mapOuraStressSummary(summary: string | undefined): number | undefined {
  if (summary === "restored") return 20;
  if (summary === "normal") return 50;
  if (summary === "stressful") return 80;
  return undefined;
}

/**
 * Extrae los registros `data` de una respuesta de colección de Oura.
 *
 * @param payload Respuesta JSON desconocida.
 * @returns Registros de la colección.
 */
function ouraRecords(payload: unknown): Record<string, unknown>[] {
  const data = readArray(payload, ["data"]) ?? [];
  return data.filter((record): record is Record<string, unknown> => (
    typeof record === "object" && record !== null && !Array.isArray(record)
  ));
}

/**
 * Extrae el timestamp real de un registro diario de Oura.
 *
 * @param record Registro de la colección.
 * @returns Instante en milisegundos o `undefined`.
 */
function ouraTimestamp(record: Record<string, unknown>): number | undefined {
  const timestamp = readString(record, ["timestamp"]);
  if (timestamp !== undefined) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  const timestampUnix = readNumber(record, ["timestamp_unix"]);
  if (timestampUnix !== undefined) return timestampUnix;
  const day = readString(record, ["day"]);
  if (day !== undefined) {
    const parsed = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
