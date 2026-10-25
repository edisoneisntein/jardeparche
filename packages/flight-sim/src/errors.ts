/**
 * Errores propios del simulador de vuelo.
 *
 * El simulador utiliza estas clases para que los fallos de validación y de
 * cálculo puedan distinguirse de errores genéricos de JavaScript. Todos los
 * mensajes se expresan en español para que los diagnósticos de la aplicación
 * sean comprensibles sin una tabla de traducción adicional.
 */

/** Código estable que permite identificar la causa de un fallo del simulador. */
export type FlightSimErrorCode =
  | "invalid_state"
  | "invalid_vector"
  | "invalid_quaternion"
  | "invalid_aerodynamics"
  | "invalid_thrust"
  | "invalid_controller"
  | "invalid_guidance"
  | "integration_failure";

/**
 * Error base del paquete de simulación de vuelo.
 *
 * Conserva un código estable y, cuando existe, la excepción original como
 * `cause`. No se usa ningún valor indefinido en los datos públicos del error.
 */
export class FlightSimError extends Error {
  public readonly code: FlightSimErrorCode;

  public constructor(
    code: FlightSimErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "FlightSimError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Error de validación de un estado o de una estructura matemática. */
export class InvalidStateError extends FlightSimError {
  public constructor(message: string, cause?: unknown) {
    super("invalid_state", message, cause);
    this.name = "InvalidStateError";
  }
}

/** Error producido por tablas o parámetros aerodinámicos inválidos. */
export class AerodynamicsError extends FlightSimError {
  public constructor(message: string, cause?: unknown) {
    super("invalid_aerodynamics", message, cause);
    this.name = "AerodynamicsError";
  }
}

/** Error producido por una configuración de propulsores imposible de aplicar. */
export class ThrustAllocationError extends FlightSimError {
  public constructor(message: string, cause?: unknown) {
    super("invalid_thrust", message, cause);
    this.name = "ThrustAllocationError";
  }
}

/** Error de validación de la configuración o del estado del controlador. */
export class ControllerError extends FlightSimError {
  public constructor(message: string, cause?: unknown) {
    super("invalid_controller", message, cause);
    this.name = "ControllerError";
  }
}

/** Error de validación de los parámetros de una ley de guiado. */
export class GuidanceError extends FlightSimError {
  public constructor(message: string, cause?: unknown) {
    super("invalid_guidance", message, cause);
    this.name = "GuidanceError";
  }
}
