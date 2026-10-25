import { BiometricsError, biometricsHttpError, toBiometricsError } from "../errors.js";
import type {
  BiometricSample,
  BiometricSource,
  FetchLike,
  OAuthToken,
  TokenStore,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;

/**
 * Forma de credenciales en una petición de token OAuth2.
 */
export type OAuthTokenCredentialStyle = "body" | "basic";

/**
 * Configuración común del cliente OAuth2 usado por los bridges.
 */
export interface OAuth2ClientConfig {
  /** Proveedor al que corresponde el cliente. */
  provider: BiometricSource;
  /** Client ID de la aplicación OAuth2. */
  clientId: string;
  /** Client secret cuando el proveedor lo requiere. */
  clientSecret?: string;
  /** Endpoint de tokens. */
  tokenUrl: string;
  /** Endpoint de autorización. */
  authorizationUrl: string;
  /** URI de redirección registrado. */
  redirectUri?: string;
  /** Ámbitos solicitados. */
  scopes?: readonly string[];
  /** Almacén de tokens inyectado. */
  tokenStore: TokenStore;
  /** Clave del token en el almacén. */
  tokenKey: string;
  /** Transporte HTTP inyectable. */
  fetchImpl: FetchLike;
  /** Tiempo máximo de cada petición. */
  timeoutMs?: number;
  /** Ubicación de las credenciales del cliente en la petición de token. */
  credentialStyle: OAuthTokenCredentialStyle;
}

/**
 * Almacén de tokens OAuth2 en memoria.
 *
 * Es útil para pruebas y para procesos sin almacenamiento seguro, aunque en
 * producción se recomienda inyectar un almacén cifrado y persistente.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, OAuthToken>();

  /**
   * Recupera un token almacenado.
   *
   * @param key Clave lógica del token.
   * @returns Token o `undefined`.
   */
  get(key: string): OAuthToken | undefined {
    const token = this.tokens.get(key);
    return token === undefined ? undefined : { ...token };
  }

  /**
   * Guarda un token.
   *
   * @param key Clave lógica del token.
   * @param token Token que se debe guardar.
   */
  set(key: string, token: OAuthToken): void {
    this.tokens.set(key, { ...token });
  }

  /**
   * Elimina un token.
   *
   * @param key Clave lógica del token.
   */
  remove(key: string): void {
    this.tokens.delete(key);
  }
}

/**
 * Cliente OAuth2 reutilizable con almacenamiento, refresco y timeout inyectables.
 */
export class OAuth2Client {
  private readonly config: OAuth2ClientConfig;
  private readonly timeoutMs: number;

  /**
   * Crea un cliente OAuth2.
   *
   * @param config Parámetros del proveedor y del transporte.
   */
  constructor(config: OAuth2ClientConfig) {
    if (config.clientId.trim().length === 0) {
      throw new BiometricsError("configuration", "El client ID OAuth2 no puede estar vacío.");
    }
    if (config.credentialStyle === "basic" && (config.clientSecret ?? "").length === 0) {
      throw new BiometricsError("configuration", "El proveedor requiere un client secret OAuth2.");
    }
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new BiometricsError("configuration", "timeoutMs debe ser un número positivo.");
    }
  }

  /**
   * Construye la URL de autorización OAuth2.
   *
   * @param state Valor opaco de protección CSRF.
   * @param redirectUri Redirección que sustituye a la configurada, si se proporciona.
   * @returns URL completa de autorización.
   */
  getAuthorizationUrl(state: string, redirectUri?: string): string {
    if (state.length === 0) {
      throw new BiometricsError("invalid_input", "El estado OAuth2 no puede estar vacío.");
    }
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("state", state);
    const effectiveRedirect = redirectUri ?? this.config.redirectUri;
    if (effectiveRedirect !== undefined) url.searchParams.set("redirect_uri", effectiveRedirect);
    if (this.config.scopes !== undefined && this.config.scopes.length > 0) {
      url.searchParams.set("scope", this.config.scopes.join(" "));
    }
    return url.toString();
  }

  /**
   * Canjea un código de autorización por tokens.
   *
   * @param code Código de autorización de un solo uso.
   * @param redirectUri Redirección que sustituye a la configurada, si se proporciona.
   * @returns Token OAuth2 almacenado.
   */
  async exchangeAuthorizationCode(code: string, redirectUri?: string): Promise<OAuthToken> {
    if (code.length === 0) {
      throw new BiometricsError("invalid_input", "El código de autorización OAuth2 no puede estar vacío.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
    });
    const effectiveRedirect = redirectUri ?? this.config.redirectUri;
    if (effectiveRedirect !== undefined) form.set("redirect_uri", effectiveRedirect);
    this.addClientCredentials(form);
    const token = await this.requestToken(form);
    await this.config.tokenStore.set(this.config.tokenKey, token);
    return token;
  }

  /**
   * Renueva un token mediante el `refresh_token` almacenado.
   *
   * @param refreshToken Token de renovación actual.
   * @returns Token renovado y almacenado.
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
    if (refreshToken.length === 0) {
      throw new BiometricsError("authentication", "No existe un token de renovación OAuth2.");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    this.addClientCredentials(form);
    const previous = await this.config.tokenStore.get(this.config.tokenKey);
    const token = await this.requestToken(form, previous);
    await this.config.tokenStore.set(this.config.tokenKey, token);
    return token;
  }

  /**
   * Recupera un token válido, refrescándolo proactivamente cuando expira.
   *
   * @returns Token de acceso vigente.
   */
  async getAccessToken(): Promise<OAuthToken> {
    let token = await this.config.tokenStore.get(this.config.tokenKey);
    if (token === undefined || token.accessToken.length === 0) {
      throw new BiometricsError(
        "authentication",
        `No existe un token OAuth2 para ${this.config.provider}.`,
      );
    }
    if (token.expiresAt !== undefined && token.expiresAt <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
      if (token.refreshToken === undefined) {
        throw new BiometricsError(
          "authentication",
          `El token OAuth2 de ${this.config.provider} expiró y no se puede renovar.`,
        );
      }
      token = await this.refreshAccessToken(token.refreshToken);
    }
    return token;
  }

  /**
   * Ejecuta una petición JSON autenticada.
   *
   * Ante un HTTP 401 se intenta una única renovación y se reintenta la misma
   * petición. El cuerpo de la respuesta se consume una sola vez y los errores
   * HTTP se traducen a `BiometricsError`.
   *
   * @param url URL absoluta de la petición.
   * @param init Configuración HTTP adicional.
   * @param externalSignal Señal opcional de cancelación externa.
   * @returns Respuesta JSON parseada como valor desconocido.
   */
  async requestJson(
    url: string,
    init: RequestInit = {},
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    try {
      return await this.performJsonRequest(url, init, token, externalSignal);
    } catch (error: unknown) {
      const biometricError = toBiometricsError(error, "network", this.config.provider);
      if (biometricError.kind !== "authentication" || biometricError.status !== 401) throw biometricError;
      const stored = await this.config.tokenStore.get(this.config.tokenKey);
      if (stored?.refreshToken === undefined) throw biometricError;
      const refreshed = await this.refreshAccessToken(stored.refreshToken);
      return this.performJsonRequest(url, init, refreshed, externalSignal);
    }
  }

  /**
   * Añade las credenciales del cliente a un formulario de token.
   *
   * @param form Formulario que se debe completar.
   */
  private addClientCredentials(form: URLSearchParams): void {
    if (this.config.credentialStyle === "body") {
      form.set("client_id", this.config.clientId);
      if (this.config.clientSecret !== undefined) form.set("client_secret", this.config.clientSecret);
    }
  }

  /**
   * Solicita y parsea un token OAuth2.
   *
   * @param form Formulario del grant_type.
   * @param previous Token previo para conservar datos no repetidos por el proveedor.
   * @returns Token OAuth2 normalizado.
   */
  private async requestToken(form: URLSearchParams, previous?: OAuthToken): Promise<OAuthToken> {
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (this.config.credentialStyle === "basic") {
      const credentials = `${this.config.clientId}:${this.config.clientSecret ?? ""}`;
      headers.set("Authorization", `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`);
    }

    const response = await fetchWithTimeout(
      this.config.fetchImpl,
      this.config.tokenUrl,
      {
        method: "POST",
        headers,
        body: form,
      },
      this.timeoutMs,
      this.config.provider,
    );
    const payload = await parseSuccessfulResponse(response, this.config.provider);
    const accessToken = readString(payload, ["access_token"]);
    if (accessToken === undefined || accessToken.length === 0) {
      throw new BiometricsError("protocol", "La respuesta OAuth2 no contiene access_token.", {
        provider: this.config.provider,
      });
    }
    const expiresIn = readNumber(payload, ["expires_in"]);
    const refreshToken = readString(payload, ["refresh_token"]) ?? previous?.refreshToken;
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(expiresIn === undefined
        ? previous?.expiresAt === undefined
          ? {}
          : { expiresAt: previous.expiresAt }
        : { expiresAt: Date.now() + expiresIn * 1_000 }),
      ...(readString(payload, ["token_type"]) === undefined
        ? {}
        : { tokenType: readString(payload, ["token_type"]) }),
      ...(readString(payload, ["scope"]) === undefined ? {} : { scope: readString(payload, ["scope"]) }),
      ...(readString(payload, ["x_user_id"]) === undefined
        ? {}
        : { userId: readString(payload, ["x_user_id"]) }),
    };
  }

  /**
   * Ejecuta una petición JSON con un token concreto.
   *
   * @param url URL absoluta.
   * @param init Configuración HTTP.
   * @param token Token que se debe utilizar.
   * @param externalSignal Señal externa opcional.
   * @returns Contenido JSON parseado.
   */
  private async performJsonRequest(
    url: string,
    init: RequestInit,
    token: OAuthToken,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", `${token.tokenType ?? "Bearer"} ${token.accessToken}`);
    const response = await fetchWithTimeout(
      this.config.fetchImpl,
      url,
      { ...init, headers },
      this.timeoutMs,
      this.config.provider,
      externalSignal,
    );
    return parseSuccessfulResponse(response, this.config.provider);
  }
}

/**
 * Ejecuta una petición `fetch` con timeout y cancelación externa.
 *
 * @param fetchImpl Transporte HTTP inyectado.
 * @param url URL de la petición.
 * @param init Configuración HTTP.
 * @param timeoutMs Tiempo máximo en milisegundos.
 * @param provider Proveedor para contextualizar errores.
 * @param externalSignal Señal externa opcional.
 * @returns Respuesta HTTP recibida.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: BiometricSource,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromExternal = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (timedOut) {
      throw new BiometricsError("timeout", `La petición a ${provider} excedió ${timeoutMs} ms.`, {
        provider,
        cause: error,
      });
    }
    if (externalSignal?.aborted) {
      throw new BiometricsError("aborted", `La petición a ${provider} fue cancelada.`, {
        provider,
        cause: error,
      });
    }
    throw new BiometricsError("network", `No se pudo contactar con ${provider}.`, {
      provider,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

/**
 * Parsea una respuesta HTTP exitosa como JSON.
 *
 * @param response Respuesta recibida.
 * @param provider Proveedor de la respuesta.
 * @returns Valor JSON desconocido.
 */
export async function parseSuccessfulResponse(
  response: Response,
  provider: BiometricSource,
): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) throw biometricsHttpError(response.status, provider, body);
  if (body.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch (error: unknown) {
    throw new BiometricsError("protocol", `${provider} devolvió una respuesta JSON inválida.`, {
      provider,
      cause: error,
      detail: body.slice(0, 500),
    });
  }
}

/**
 * Comprueba si un valor es un objeto con propiedades indexables.
 *
 * @param value Valor que se debe comprobar.
 * @returns `true` cuando el valor es un objeto no nulo.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lee un número finito siguiendo una ruta de propiedades.
 *
 * @param source Objeto raíz.
 * @param path Ruta de propiedades.
 * @returns Número leído o `undefined`.
 */
export function readNumber(source: unknown, path: readonly string[]): number | undefined {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

/**
 * Lee una cadena siguiendo una ruta de propiedades.
 *
 * @param source Objeto raíz.
 * @param path Ruta de propiedades.
 * @returns Cadena leída o `undefined`.
 */
export function readString(source: unknown, path: readonly string[]): string | undefined {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * Lee un objeto siguiendo una ruta de propiedades.
 *
 * @param source Objeto raíz.
 * @param path Ruta de propiedades.
 * @returns Objeto leído o `undefined`.
 */
export function readRecord(source: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

/**
 * Lee un arreglo siguiendo una ruta de propiedades.
 *
 * @param source Objeto raíz.
 * @param path Ruta de propiedades.
 * @returns Arreglo leído o `undefined`.
 */
export function readArray(source: unknown, path: readonly string[]): unknown[] | undefined {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return Array.isArray(current) ? current : undefined;
}

/**
 * Convierte una fecha o epoch a milisegundos desde Unix.
 *
 * @param value Fecha o epoch en milisegundos.
 * @returns Instante en milisegundos desde Unix.
 */
export function toEpochMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * Valida un intervalo temporal inclusivo.
 *
 * @param start Inicio del intervalo.
 * @param end Fin del intervalo.
 * @returns Inicio y fin normalizados en milisegundos.
 */
export function validateDateRange(start: Date | number, end: Date | number): {
  startMs: number;
  endMs: number;
} {
  const startMs = toEpochMs(start);
  const endMs = toEpochMs(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new BiometricsError("invalid_input", "El intervalo de muestras contiene fechas no finitas.");
  }
  if (endMs < startMs) {
    throw new BiometricsError("invalid_input", "El fin del intervalo precede a su inicio.");
  }
  return { startMs, endMs };
}

/**
 * Convierte un instante en una fecha UTC `YYYY-MM-DD`.
 *
 * @param epochMs Instante en milisegundos desde Unix.
 * @returns Fecha UTC en formato ISO de día.
 */
export function formatUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Convierte una fecha UTC `YYYY-MM-DD` en medianoche Unix.
 *
 * @param date Fecha en formato ISO de día.
 * @returns Instante de medianoche UTC en milisegundos.
 */
export function parseUtcDate(date: string): number | undefined {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Combina muestras por timestamp conservando el primer valor no vacío.
 *
 * @param samples Muestras que se deben combinar.
 * @returns Muestras combinadas y ordenadas cronológicamente.
 */
export function mergeBiometricSamples(samples: readonly BiometricSample[]): BiometricSample[] {
  const byTimestamp = new Map<number, BiometricSample>();
  for (const sample of samples) {
    const existing = byTimestamp.get(sample.ts);
    if (existing === undefined) {
      byTimestamp.set(sample.ts, { ...sample });
      continue;
    }
    const heartRate = firstDefined(existing.heartRate, sample.heartRate);
    const hrvMs = firstDefined(existing.hrvMs, sample.hrvMs);
    const spo2 = firstDefined(existing.spo2, sample.spo2);
    const temperatureC = firstDefined(existing.temperatureC, sample.temperatureC);
    const stressScore = firstDefined(existing.stressScore, sample.stressScore);
    const sleepScore = firstDefined(existing.sleepScore, sample.sleepScore);
    byTimestamp.set(sample.ts, {
      ts: sample.ts,
      source: sample.source,
      ...(heartRate === undefined ? {} : { heartRate }),
      ...(hrvMs === undefined ? {} : { hrvMs }),
      ...(spo2 === undefined ? {} : { spo2 }),
      ...(temperatureC === undefined ? {} : { temperatureC }),
      ...(stressScore === undefined ? {} : { stressScore }),
      ...(sleepScore === undefined ? {} : { sleepScore }),
    });
  }
  return [...byTimestamp.values()].sort((left, right) => left.ts - right.ts);
}

/**
 * Devuelve el primer valor definido entre varios candidatos.
 *
 * @param values Valores candidatos.
 * @returns Primer valor no `undefined` o `undefined` si no existe.
 */
function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}
