import type { BiometricSource } from "./types.js";

/**
 * Clasificación funcional de los fallos del subsistema biométrico.
 */
export type BiometricsErrorKind =
  | "configuration"
  | "invalid_input"
  | "authentication"
  | "authorization"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol"
  | "not_allowed"
  | "conflict"
  | "unknown";

/**
 * Error tipado común a pipelines, VAD, huellas vocales y bridges.
 */
export class BiometricsError extends Error {
  /** Clasificación estable del fallo. */
  readonly kind: BiometricsErrorKind;
  /** Código HTTP asociado, cuando el fallo procede de una respuesta REST. */
  readonly status?: number;
  /** Indica si la operación puede reintentarse. */
  readonly retryable: boolean;
  /** Detalle recortado y no sensible devuelto por el proveedor. */
  readonly detail?: string;
  /** Proveedor que originó el fallo, cuando se conoce. */
  readonly provider?: BiometricSource;
  /** Error original que provocó esta clasificación. */
  override readonly cause?: unknown;

  /**
   * Crea un error biométrico tipado.
   *
   * @param kind Clasificación funcional del fallo.
   * @param message Mensaje seguro para consumidores del package.
   * @param options Metadatos opcionales del error.
   */
  constructor(
    kind: BiometricsErrorKind,
    message: string,
    options: {
      /** Código HTTP de origen. */
      status?: number;
      /** Si la operación admite reintento. */
      retryable?: boolean;
      /** Detalle textual de la respuesta. */
      detail?: string;
      /** Proveedor de origen. */
      provider?: BiometricSource;
      /** Error original. */
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "BiometricsError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryable(kind);
    this.detail = options.detail;
    this.provider = options.provider;
    this.cause = options.cause;
  }
}

/**
 * Convierte una excepción desconocida en un `BiometricsError` conservando la causa.
 *
 * @param error Valor capturado en un `catch`.
 * @param fallbackKind Clasificación usada si el valor no es un `Error`.
 * @param provider Proveedor asociado al contexto de ejecución.
 * @returns Error biométrico normalizado.
 */
export function toBiometricsError(
  error: unknown,
  fallbackKind: BiometricsErrorKind = "unknown",
  provider?: BiometricSource,
): BiometricsError {
  if (error instanceof BiometricsError) return error;
  if (error instanceof Error) {
    return new BiometricsError(fallbackKind, error.message, { cause: error, provider });
  }
  return new BiometricsError(fallbackKind, "Se produjo un error biométrico inesperado.", {
    cause: error,
    provider,
  });
}

/**
 * Construye el error correspondiente a una respuesta HTTP no exitosa.
 *
 * @param status Código HTTP devuelto por el proveedor.
 * @param provider Proveedor que devolvió la respuesta.
 * @param body Cuerpo de respuesta recortado para diagnóstico.
 * @param detail Detalle específico ya extraído, si existe.
 * @returns Error HTTP tipado.
 */
export function biometricsHttpError(
  status: number,
  provider: BiometricSource,
  body: string,
  detail?: string,
): BiometricsError {
  const safeDetail = (detail ?? body).slice(0, 500);
  if (status === 401) {
    return new BiometricsError("authentication", "Las credenciales biométricas fueron rechazadas.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status === 403) {
    return new BiometricsError("authorization", "El proveedor denegó el acceso a los datos de salud.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status === 404) {
    return new BiometricsError("not_found", "El recurso biométrico solicitado no existe.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status === 408) {
    return new BiometricsError("timeout", "El proveedor agotó el tiempo de la petición.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status === 409) {
    return new BiometricsError("conflict", "El proveedor detectó un conflicto en la operación.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status === 429) {
    return new BiometricsError("rate_limit", "El proveedor aplicó un límite de peticiones.", {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status >= 500) {
    return new BiometricsError("server", `El proveedor de biometría devolvió HTTP ${status}.`, {
      status,
      provider,
      detail: safeDetail,
    });
  }
  if (status >= 400) {
    return new BiometricsError("invalid_input", `El proveedor rechazó la petición con HTTP ${status}.`, {
      status,
      provider,
      detail: safeDetail,
    });
  }
  return new BiometricsError("unknown", `El proveedor devolvió un estado HTTP inesperado: ${status}.`, {
    status,
    provider,
    detail: safeDetail,
  });
}

/**
 * Indica si un tipo de fallo es transitorio por defecto.
 *
 * @param kind Clasificación del fallo.
 * @returns `true` para red, timeout, rate limit y servidor.
 */
function isRetryable(kind: BiometricsErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate_limit" || kind === "server";
}
