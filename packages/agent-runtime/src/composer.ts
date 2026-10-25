/**
 * Composición de la respuesta visible y audible.
 *
 * Problema que resuelve: el modelo puede empezar el turno con una EXCUSA
 * ("no dispongo de una herramienta…"). Si el texto sale a la vez que llega,
 * el usuario OYE la excusa antes de la respuesta buena. La solución
 * original retenía los primeros 90 caracteres: correcto en contenido,
 * defectuoso en latencia (si el modelo emite tokens despacio, el usuario
 * espera 90 caracteres antes de oír nada).
 *
 * Reglas del compositor:
 *   1. Se retiene lo que parece una negativa (patrones de excusa completos).
 *   2. Se suelta en cuanto hay evidencia suficiente de que NO es una negativa.
 *   3. El retención tiene un TECHO DE TIEMPO: si el modelo va lento, el texto
 *      sale igual. La latencia perceptual no depende del ritmo del modelo.
 *   4. Un fragmento que empieza por "No…", "Lo siento…" se sigue reteniendo
 *      aunque todavía no complete la frase: puede ser una renuncia.
 */
import { looksLikeRefusal, looksLikeRefusalStem } from "./intent.js";

export interface ResponseComposerOptions {
  /**
   * Caracteres que hay que acumular antes de soltar el texto si no hay
   * señales de negativa. Por defecto 90.
   */
  holdChars?: number;
  /**
   * Techo de retención en ms. Por defecto 150 ms: es el presupuesto máximo
   * que se acepta añadir a la latencia perceptual para poder corregir una
   * negativa.
   */
  holdMs?: number;
  /**
   * Emite un fragmento de texto ya liberado (visible y audible).
   */
  onDelta: (text: string) => void;
  /**
   * Se invoca UNA vez, en el primer fragmento que se libera. Es el punto en
   * que JARVIS empieza de verdad a hablar: antes, la interfaz podía mostrar
   * "hablando" con el micrófono callado.
   */
  onFirstRelease?: () => void;
  /** Reloj inyectable (pruebas deterministas). */
  now?: () => number;
  /** Detector de negativa: por defecto, los patrones de excusa del runtime. */
  isRefusal?: (text: string) => boolean;
}

/**
 * Acumula los fragmentos del modelo y decide cuándo se hacen visibles.
 *
 * No es concurrente: lo usa un único turno a la vez.
 */
export class ResponseComposer {
  private readonly holdChars: number;
  private readonly holdMs: number;
  private readonly onDelta: (text: string) => void;
  private readonly onFirstRelease: (() => void) | undefined;
  private readonly now: () => number;
  private readonly isRefusal: (text: string) => boolean;
  private pending: string[] = [];
  private released = false;
  private startedAt: number;

  constructor(options: ResponseComposerOptions) {
    this.holdChars = options.holdChars ?? 90;
    this.holdMs = options.holdMs ?? 150;
    this.onDelta = options.onDelta;
    this.onFirstRelease = options.onFirstRelease;
    this.now = options.now ?? Date.now;
    this.isRefusal = options.isRefusal ?? looksLikeRefusal;
    this.startedAt = this.now();
  }

  /** Texto retenido hasta ahora. */
  get pendingText(): string {
    return this.pending.join("");
  }

  /** `true` si aún no se ha liberado ningún fragmento. */
  get isHolding(): boolean {
    return !this.released;
  }

  /**
   * Recibe un fragmento del modelo.
   *
   * Una vez liberado, los fragmentos salen tal cual. Antes de liberarse, se
   * acumulan y se decide con las reglas del módulo.
   */
  accept(chunk: string): void {
    if (this.released) {
      this.onDelta(chunk);
      return;
    }
    this.pending.push(chunk);
    const accumulated = this.pendingText;
    if (this.isRefusal(accumulated)) return;
    if (accumulated.length >= this.holdChars) {
      this.flush();
      return;
    }
    if (this.now() - this.startedAt >= this.holdMs && !looksLikeRefusalStem(accumulated)) this.flush();
  }

  /**
   * Cierra el turno de texto: suelta lo retenido si NO es una negativa.
   *
   * Si es una negativa, el texto se descarta (quedará retenido en el
   * historial para que el runtime pueda reintentar con el catálogo completo).
   */
  release(): void {
    if (this.released) return;
    if (this.isRefusal(this.pendingText)) return;
    this.flush();
  }

  /** Descarta lo retenido sin emitirlο. */
  discard(): void {
    this.pending = [];
  }

  /** Libera todos los fragmentos pendientes y pasa a modo directo. */
  private flush(): void {
    this.released = true;
    if (this.pending.length === 0) return;
    this.onFirstRelease?.();
    for (const fragment of this.pending.splice(0)) this.onDelta(fragment);
  }
}
