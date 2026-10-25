import type { DomoticsErrorKind } from "./types.js";

/**
 * Error propio del subsistema de domótica.
 *
 * Todos los fallos de configuración, protocolo, red, seguridad, procesos y
 * operaciones de dominio se representan con esta clase. El campo `kind`
 * permite que las herramientas decidan si reintentan, mientras `cause`
 * conserva el error original para diagnóstico.
 */
export class DomoticsError extends Error {
  /** Clasificación estable del fallo. */
  readonly kind: DomoticsErrorKind;
  /** Indica si una operación con este error puede reintentarse. */
  readonly retryable: boolean;
  /** Error original que provocó este fallo, si lo hubo. */
  override readonly cause?: unknown;

  /**
   * Crea un error de domótica.
   *
   * @param kind Clasificación funcional del fallo.
   * @param message Mensaje seguro para mostrar en una herramienta.
   * @param options Opciones adicionales del error.
   */
  constructor(
    kind: DomoticsErrorKind,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "DomoticsError";
    this.kind = kind;
    this.retryable = options.retryable ?? isRetryableKind(kind);
    this.cause = options.cause;
  }
}

/**
 * Convierte cualquier excepción recibida en un `DomoticsError` sin perder el
 * error original.
 *
 * @param error Excepción recibida en un `catch`.
 * @param fallbackKind Clasificación usada si el valor no es un Error.
 * @returns Error de domótica normalizado.
 */
export function toDomoticsError(error: unknown, fallbackKind: DomoticsErrorKind = "unknown"): DomoticsError {
  if (error instanceof DomoticsError) return error;
  if (error instanceof Error) {
    return new DomoticsError(fallbackKind, error.message, { cause: error });
  }
  return new DomoticsError(fallbackKind, "Se produjo un error de domótica inesperado.", { cause: error });
}

/**
 * Indica si un tipo de fallo admite reintento por defecto.
 *
 * @param kind Clasificación del fallo.
 * @returns `true` para fallos transitorios de red o de proceso.
 */
function isRetryableKind(kind: DomoticsErrorKind): boolean {
  return kind === "network" || kind === "timeout" || kind === "connection" || kind === "process";
}
