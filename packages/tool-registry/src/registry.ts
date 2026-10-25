import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ToolDefinition, ToolResult, ToolContext } from "@jarvis/shared";
import { ToolResultSchema } from "@jarvis/shared";
import type { ProviderTool } from "@jarvis/ai-provider";
import { analyseSource, type GateFinding } from "./static-gate.js";

/**
 * SEC-002 · Token de aprobación ligado a la ejecución concreta.
 *
 * Un "sí" del usuario no es una luz blanca: vale para UNA llamada concreta
 * (tool + argumentos + sesión) y caduca pronto. El token lleva dentro un
 * hash de los argumentos, así que nadie puede aprobar `ls` y ejecutar `rm`.
 *
 * Firma HMAC-SHA256: la verifica el registro con el secreto del servidor, en
 * comparación de tiempo constante. Si el token no está, está caducado, no
 * corresponde a la tool o no corresponde a los argumentos, la ejecución se
 * RECHAZA (fail-closed).
 */
export interface ApprovalGrantClaims {
  /** Tool a la que se autoriza. */
  toolName: string;
  userId: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  /** Hash canónico de los argumentos: liga el token a la llamada exacta. */
  argsHash: string;
  /** `user` = el usuario aprobó; `auto` = la política de auto-aprobación. */
  mode: "user" | "auto";
  issuedAt: number;
  expiresAt: number;
}

/** Error de autorización. Su mensaje empieza SIEMPRE por `ACCESO DENEGADO`. */
export class ApprovalGrantError extends Error {
  constructor(reason: string) {
    super(`ACCESO DENEGADO: ${reason}`);
    this.name = "ApprovalGrantError";
  }
}

/** Vida máxima de un token: lo justo para ejecutar la llamada aprobada. */
export const APPROVAL_GRANT_TTL_MS = 120_000;

/** Longitud máxima que acepta la API del proveedor para el nombre de una tool. */
export const PROVIDER_TOOL_NAME_MAX = 64;

/**
 * Normaliza el nombre real de una tool al alfabético que acepta la API del
 * proveedor (`^[a-zA-Z0-9_-]{1,64}$`).
 *
 * Fuente única de verdad: el registro la usa para publicar los esquemas y el
 * runtime la usa para cruzar nombres. Antes cada uno tenía su propia copia
 * y cualquier divergencia hacía que un filtro de tools no encontrara nada.
 *
 * Args:
 *   tool_name: Nombre real de la tool (por ejemplo `math.calculate`).
 *
 * Returns:
 *   El nombre seguro para el proveedor (`math_calculate`).
 */
export function toProviderSafeName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, PROVIDER_TOOL_NAME_MAX) || "tool";
}

/** JSON canónico: claves ordenadas, para que el hash no dependa del orden. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Hash estable de los argumentos de una llamada. */
export function hashArguments(args: unknown): string {
  return createHmac("sha256", "jarvis.args.v1").update(canonicalJson(args)).digest("hex");
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Firma un token de aprobación. */
export function signApprovalGrant(claims: ApprovalGrantClaims, secret: string): string {
  const payload = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${signature}`;
}

export interface ApprovalGrantExpectation {
  toolName: string;
  argsHash: string;
  userId: string;
  sessionId: string;
}

/**
 * Verifica un token de aprobación. Lanza `ApprovalGrantError` si algo no
 * encaja: NUNCA devuelve un booleano "casi válido".
 */
export function verifyApprovalGrant(token: string, secret: string, expected: ApprovalGrantExpectation): ApprovalGrantClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new ApprovalGrantError("token de aprobación malformado");
  const [payload, signature] = parts as [string, string];
  const expectedSignature = base64url(createHmac("sha256", secret).update(payload).digest());
  const given = Buffer.from(signature, "base64url");
  const wanted = Buffer.from(expectedSignature, "base64url");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new ApprovalGrantError("firma de aprobación inválida");
  }
  let claims: ApprovalGrantClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ApprovalGrantClaims;
  } catch {
    throw new ApprovalGrantError("token de aprobación ilegible");
  }
  if (claims.expiresAt <= Date.now()) throw new ApprovalGrantError("la aprobación ha caducado");
  if (claims.toolName !== expected.toolName) throw new ApprovalGrantError("la aprobación es de otra herramienta");
  if (claims.argsHash !== expected.argsHash) throw new ApprovalGrantError("los argumentos no coinciden con los aprobados");
  if (claims.userId !== expected.userId) throw new ApprovalGrantError("la aprobación es de otro usuario");
  if (claims.sessionId !== expected.sessionId) throw new ApprovalGrantError("la aprobación es de otra sesión");
  return claims;
}

export class ToolValidationError extends Error {
  constructor(
    public readonly toolName: string,
    message: string,
  ) {
    super(`Invalid arguments for ${toolName}: ${message}`);
    this.name = "ToolValidationError";
  }
}

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`${toolName} exceeded its ${timeoutMs} ms budget.`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Herramientas cuyo código se somete al gate estático antes de ejecutarse.
 * El gate es un límite del servidor: no depende de que el modelo lo respete.
 */
const GATED_TOOLS = new Set(["code.execute_interpreter", "code.compile_and_run"]);

/** Disponibilidad cacheada de una tool. */
export interface ToolAvailability {
  available: boolean;
  reason?: string;
}

interface AvailabilitySnapshot extends ToolAvailability {
  checkedAt: number;
}

export interface ToolRegistryOptions {
  /** Tope de bytes por resultado de tool. */
  maxResultBytes?: number;
  /** Secreto de firma de las aprobaciones. */
  approvalSecret?: string;
  /**
   * TTL de la instantánea de disponibilidad, en ms.
   *
   * La disponibilidad se consulta en el camino caliente de cada turno. Antes
   * cada consulta sondaba el disco (y el daemon de docker) de forma
   * SÍNCRONA, congelando el event loop del servidor durante cientos de
   * milisegundos. Ahora se cachea: el camino caliente solo lee memoria y el
   * sondeo real ocurre una vez por ventana.
   */
  availabilityTtlMs?: number;
}

/**
 * The single authorized path for side effects. The model can only ever *name*
 * a tool; execution always goes through this registry and its policies.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  /** Maps the provider-safe spelling (dots are illegal in OpenAI tool names) back to the real tool. */
  private readonly providerNames = new Map<string, string>();
  /** Tope de bytes por resultado de tool. */
  private readonly maxResultBytes: number;
  /**
   * Secreto de firma de las aprobaciones.
   *
   * Se genera uno aleatorio si no se pasa: los tokens no sobreviven al
   * reinicio del proceso (que es lo correcto: una aprobación vieja no debe
   * volver a valer).
   */
  private readonly approvalSecret: string;
  /** TTL de la instantánea de disponibilidad. */
  private readonly availabilityTtlMs: number;
  /** Instantánea de disponibilidad por tool: el camino caliente no sondea. */
  private readonly availabilitySnapshot = new Map<string, AvailabilitySnapshot>();
  /** Marca de tiempo del último refresco completo de la instantánea. */
  private availabilityRefreshedAt = 0;

  constructor(options: ToolRegistryOptions = {}) {
    this.maxResultBytes = options.maxResultBytes ?? 256 * 1024;
    this.approvalSecret = options.approvalSecret ?? randomBytes(32).toString("base64url");
    this.availabilityTtlMs = options.availabilityTtlMs ?? 5_000;
  }

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
    // El nombre PUBLICADO se asigna al registrar, no al publicar el
    // catálogo: es determinista desde el primer instante, no depende de que
    // se haya llamado a `toProviderTools()` y no cambia si una tool aparece
    // o desaparece del catálogo.
    this.providerNames.set(this.assignProviderName(tool.name), tool.name);
    this.availabilitySnapshot.delete(tool.name);
    return this;
  }

  /**
   * Asigna el nombre publicado (el que entiende el proveedor) a una tool.
   *
   * Si el nombre saneado ya está ocupado, se desambigua con un sufijo
   * numérico: dos tools distintas nunca pueden compartir el mismo nombre
   * publicado, que es la clave del modelo.
   */
  private assignProviderName(toolName: string): string {
    const base = toProviderSafeName(toolName);
    if (!this.providerNames.has(base)) return base;
    let suffix = 2;
    while (this.providerNames.has(`${base}_${suffix}`) && suffix < 100) suffix += 1;
    return `${base}_${suffix}`;
  }

  registerAll(tools: ToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  /**
   * Resuelve el nombre que emite el MODELO a una tool.
   *
   * El modelo solo conoce los nombres PUBLICADOS (sin puntos). Por eso el
   * alias tiene prioridad sobre el nombre real: si una tool se publica como
   * `a_b` y otra tool se llama realmente `a_b`, el modelo que invoque `a_b`
   * QUIERE la primera. Con el orden inverso, el registro ejecutaría la tool
   * equivocada: una colisión de nombres se convertiría en una ejecución no
   * solicitada.
   *
   * Args:
   *   name: Nombre publicado por el modelo o nombre real de la tool.
   *
   * Returns:
   *   La tool, o `undefined` si no existe.
   */
  get(name: string): ToolDefinition | undefined {
    const aliased = this.providerNames.get(name);
    if (aliased) return this.tools.get(aliased);
    return this.tools.get(name);
  }

  /**
   * Resuelve un nombre REAL de tool (uso interno del runtime).
   *
   * A diferencia de `get`, aquí no se consultan los alias: el runtime ya
   * resolvió el nombre y pasa el real, de modo que una colisión no puede
   * desviar la ejecución a otra tool.
   */
  private getByRealName(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Resolves a name emitted by the model to the registered tool name. */
  resolveName(name: string): string {
    return this.providerNames.get(name) ?? name;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Disponibilidad de una tool sin E/S en el camino caliente: lee la
   * instantánea y solo sondea si la entrada está caducada.
   *
   * Args:
   *   tool_name: Nombre real o nombre seguro del proveedor.
   *
   * Returns:
   *   La disponibilidad cacheada (recalculada si expiró).
   */
  availabilityOf(toolName: string): ToolAvailability {
    const tool = this.getByRealName(toolName) ?? this.get(toolName);
    if (!tool) return { available: false, reason: "herramienta desconocida" };
    const snapshot = this.availabilitySnapshot.get(tool.name);
    if (snapshot && Date.now() - snapshot.checkedAt < this.availabilityTtlMs) {
      return { available: snapshot.available, reason: snapshot.reason };
    }
    return this.probe(tool);
  }

  /** Sondea una tool concreta y guarda el resultado en la instantánea. */
  private probe(tool: ToolDefinition): ToolAvailability {
    const fresh = tool.availability();
    this.availabilitySnapshot.set(tool.name, { ...fresh, checkedAt: Date.now() });
    return fresh;
  }

  /** Refresca la instantánea completa de disponibilidad. */
  refreshAvailability(): void {
    for (const tool of this.tools.values()) this.probe(tool);
    this.availabilityRefreshedAt = Date.now();
  }

  /** Only tools that are actually configured are advertised to the model. */
  available(): ToolDefinition[] {
    if (Date.now() - this.availabilityRefreshedAt > this.availabilityTtlMs) this.refreshAvailability();
    return this.list().filter((tool) => this.availabilitySnapshot.get(tool.name)?.available === true);
  }

  /**
   * Nombre PUBLICADO de una tool: el que el modelo ve y usa para llamarla.
   *
   * Es la fuente de verdad para cruzar el catálogo con las intenciones: si
   * el runtime normalizara los nombres por su cuenta, una tool desambiguada
   * (`x_y_2`) no coincidiría con su nombre real y se quedaría fuera del
   * catálogo sin error visible.
   *
   * Args:
   *   tool_name: Nombre real de la tool.
   *
   * Returns:
   *   El nombre publicado (o el saneado, si la tool no existe).
   */
  publishedNameOf(toolName: string): string {
    for (const [published, real] of this.providerNames) {
      if (real === toolName) return published;
    }
    return toProviderSafeName(toolName);
  }

  toProviderTools(): ProviderTool[] {
    return this.available().map((tool) => ({
      type: "function" as const,
      function: { name: this.publishedNameOf(tool.name), description: tool.description, parameters: tool.parameters },
    }));
  }

  /**
   * Emite un token de aprobación para UNA llamada concreta.
   *
   * El token ata la aprobación a la tool, a los argumentos (por hash) y a la
   * sesión: aprobarla no autoriza "lo que venga después".
   */
  issueGrant(input: {
    toolName: string;
    userId: string;
    sessionId: string;
    taskId: string;
    toolCallId: string;
    arguments: unknown;
    mode: "user" | "auto";
    ttlMs?: number;
  }): string {
    const now = Date.now();
    const claims: ApprovalGrantClaims = {
      toolName: input.toolName,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      argsHash: hashArguments(input.arguments),
      mode: input.mode,
      issuedAt: now,
      expiresAt: now + (input.ttlMs ?? APPROVAL_GRANT_TTL_MS),
    };
    return signApprovalGrant(claims, this.approvalSecret);
  }

  /**
   * Verifica un token de aprobación contra la llamada que se va a ejecutar.
   *
   * Lanza `ApprovalGrantError` (mensaje `ACCESO DENEGADO: ...`) si el token
   * falta, caduca, no está firmado por este registro o no corresponde a esta
   * tool, a estos argumentos o a esta sesión.
   */
  verifyGrant(token: string | undefined, expectation: ApprovalGrantExpectation): ApprovalGrantClaims {
    if (!token) throw new ApprovalGrantError("la herramienta exige aprobación y no se ha presentado ninguna");
    return verifyApprovalGrant(token, this.approvalSecret, expectation);
  }

  validate(toolName: string, rawArguments: unknown): unknown {
    const tool = this.getByRealName(toolName) ?? this.get(toolName);
    if (!tool) throw new ToolValidationError(toolName, "unknown tool");
    try {
      return tool.parse(rawArguments);
    } catch (error) {
      throw new ToolValidationError(toolName, (error as Error).message);
    }
  }

  /**
   * Única vía autorizada para producir efectos.
   *
   * Garantías:
   *   - Fail-closed: una tool que exige aprobación no corre sin un token
   *     firmado válido para ESA tool, ESOS argumentos y ESA sesión.
   *   - Cancelación real: el `AbortSignal` del turno y el presupuesto de
   *     tiempo de la tool se combinan en una sola señal que se propaga a la
   *     tool. Antes el vencimiento del presupuesto solo abandonaba la
   *     `Promise`: el proceso o la petición seguían vivos.
   *
   * Args:
   *   tool_name: Nombre real de la tool.
   *   raw_arguments: Argumentos sin validar (los valida la tool).
   *   ctx: Contexto de ejecución (usuario, sesión, tarea, señal).
   *   approval_token: Token firmado si la tool exige aprobación.
   *
   * Returns:
   *   El resultado de la tool, recortado al tope de bytes configurado.
   *
   * Raises:
   *   ToolValidationError: La tool no existe o los argumentos no validan.
   *   ApprovalGrantError: El token falta, caducó o no corresponde.
   *   ToolTimeoutError: La tool superó su presupuesto de tiempo.
   */
  async execute(
    toolName: string,
    rawArguments: unknown,
    ctx: ToolContext,
    approvalToken?: string,
  ): Promise<ToolResult> {
    // El runtime pasa el nombre REAL de la tool. La resolución por alias es
    // solo un respaldo para invocaciones directas con el nombre publicado.
    const tool = this.getByRealName(toolName) ?? this.get(toolName);
    if (!tool) throw new ToolValidationError(toolName, "unknown tool");

    // SEC-002 · Fail-closed. Una tool que exige aprobación NO se ejecuta sin
    // un token firmado que acredite esa aprobación para ESTA tool, ESTOS
    // argumentos y ESTA sesión. Sin token, la llamada se rechaza con
    // `ACCESO DENEGADO` antes de tocar nada.
    if (tool.requiresApproval) {
      this.verifyGrant(approvalToken, {
        toolName: tool.name,
        argsHash: hashArguments(rawArguments),
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      });
    }

    // El gate estático va ANTES que la comprobación de disponibilidad: es la
    // capa autoritativa y tiene que rechazar el código destructivo aunque el
    // sandbox no esté disponible. Si no, el modelo se llevaría un "no hay
    // imagen de sandbox" en lugar de un rechazo de seguridad, y el análisis
    // estático dejaría de ejecutarse justo cuando el sandbox falta.
    const input = this.validate(toolName, rawArguments);
    if (GATED_TOOLS.has(tool.name)) {
      const verdict = gateVerdictFor(tool.name, input);
      if (!verdict.allowed) {
        const blocking = verdict.findings.filter((finding) => finding.severity === "reject");
        return ToolResultSchema.parse({
          ok: false,
          summary: `El análisis estático rechazó el código (${blocking.map((finding) => finding.ruleId).join(", ")}).`,
          unavailable: false,
          error: "static_gate_rejected",
          data: { findings: verdict.findings },
        });
      }
    }

    const availability = this.availabilityOf(tool.name);
    if (!availability.available) {
      return ToolResultSchema.parse({
        ok: false,
        summary: `${tool.title} no está disponible.`,
        unavailable: true,
        error: availability.reason ?? "not configured",
      });
    }

    // El presupuesto de tiempo y la señal del turno se combinan: si el
    // usuario interrumpe o se agota el tiempo, la tool recibe una señal
    // abortada y puede cortar su trabajo (red, subproceso, sandbox).
    const budget = AbortSignal.timeout(tool.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget;
    const scopedCtx: ToolContext = { ...ctx, signal };

    try {
      const result = await withTimeout(tool.execute(input, scopedCtx), tool.timeoutMs, toolName);
      return ToolResultSchema.parse(capResult(result, this.maxResultBytes));
    } catch (error) {
      if (budget.aborted && !ctx.signal?.aborted) {
        throw new ToolTimeoutError(tool.name, tool.timeoutMs);
      }
      throw error;
    }
  }
}

/** Profundidad máxima al recortar payloads anidados. */
const MAX_CAP_DEPTH = 6;

/**
 * Recorta un valor arbitrario al tope de bytes, en profundidad.
 *
 * Antes solo se recortaban las cadenas de primer nivel: un array de 20 000
 * resultados (la forma habitual de `web.search` o `file.io list`) atravesaba
 * el tope intacto y el modelo recibía megabytes.
 */
function capValue(value: unknown, maxBytes: number, depth: number): { value: unknown; truncated: boolean } {
  if (depth > MAX_CAP_DEPTH) return { value: "[payload truncado: profundidad máxima]", truncated: true };
  if (typeof value === "string") return capString(value, maxBytes);
  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map((item) => {
      const capped = capValue(item, maxBytes, depth + 1);
      truncated = truncated || capped.truncated;
      return capped.value;
    });
    return { value: items, truncated };
  }
  if (value && typeof value === "object") {
    let truncated = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const capped = capValue(item, maxBytes, depth + 1);
      truncated = truncated || capped.truncated;
      output[key] = capped.value;
    }
    return { value: output, truncated };
  }
  return { value, truncated: false };
}

/** Recorta una cadena midiendo BYTES (no caracteres) como exige el contrato. */
function capString(text: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { value: text, truncated: false };
  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return {
    value: `${clipped}\n[salida truncada por el límite de ${maxBytes} bytes]`,
    truncated: true,
  };
}

/** Recorta el payload de una tool y marca el truncamiento. */
export function capResult(result: ToolResult, maxBytes: number): ToolResult {
  if (!result.data || typeof result.data !== "object") return result;
  const capped = capValue(result.data, maxBytes, 0);
  const data = capped.value as Record<string, unknown>;
  if (capped.truncated) data.truncated = true;
  return { ...result, data };
}

/** Extrae el código fuente de los argumentos de una tool con gate. */
function gateVerdictFor(toolName: string, input: unknown): { allowed: boolean; findings: GateFinding[] } {
  const args = (input ?? {}) as { code_string?: unknown; files?: unknown };
  const code = typeof args.code_string === "string" ? args.code_string : "";
  const extraFiles: Record<string, string> = {};
  if (args.files && typeof args.files === "object") {
    for (const [name, content] of Object.entries(args.files as Record<string, unknown>)) {
      if (typeof content === "string") extraFiles[name] = content;
    }
  }
  const verdict = analyseSource(code, extraFiles);
  void toolName;
  return { allowed: verdict.allowed, findings: verdict.findings };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
