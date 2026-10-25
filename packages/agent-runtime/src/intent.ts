/**
 * Intención → catálogo de herramientas.
 *
 * Antes de la refactorización, la resolución de intención, la lista de
 * señales, los patrones de "excusa" y la normalización de nombres vivían
 * dentro de la clase `AgentRuntime` (992 líneas). Aquí viven como datos y
 * como una clase con contrato: el runtime solo pregunta "¿qué tools encajan
 * con este texto?".
 *
 * Decisión de diseño: la resolución es LÉXICA y determinista. No hay LLM
 * implicado: un clasificador semántico costaría una inferencia extra en el
 * camino crítico de cada turno (el peor sitio posible para pagar latencia).
 */
import type { ToolIntentResolver } from "./contracts.js";
import { toProviderSafeName } from "@jarvis/tool-registry";
import { REFUSAL_PATTERNS, REFUSAL_STEM_PATTERNS } from "@jarvis/shared";

/** Señal léxica que activa un conjunto de tools. */
interface ToolSignal {
  /** Patrón que detecta la intención en el texto del usuario. */
  readonly pattern: RegExp;
  /** Nombres reales de las tools que la intención habilita. */
  readonly tools: readonly string[];
}

/**
 * Inyección dinámica de esquemas (Dynamic Tool Pruning): en vez de enviar los
 * 13 esquemas en cada turno — lo que infla el pre-fill y retrasa el TTFT —
 * solo inyectamos los esquemas cuyo nombre aparece en la intención detectada.
 */
const TOOL_SIGNALS: readonly ToolSignal[] = [
  {
    pattern:
      /\b(hora|fecha|d[ií]a|mes|a[nñ]o|today|time|date|qu[eé] d[ií]a es|qu[eé] hora es|cu[aá]ndo es|cu[aá]nto tiempo|amanece|anochecer)\b/i,
    tools: ["time.now"],
  },
  {
    pattern:
      /\b(calcula|calcular|cu[aá]nto (es|son|vale)|suma|resta|multiplica|divide|resultado|por ciento|%|inter[eé]s|descuento|propina|promedio|tasa)\b|\d+\s*[+\-*/^]\s*\d+/i,
    tools: ["math.calculate"],
  },
  {
    pattern:
      /\b(sistema|cpu|memoria|ram|disco|procesador|hostname|uptime|arquitectura|sistema operativo|informaci[oó]n del sistema|info del sistema)\b/i,
    tools: ["system.info"],
  },
  {
    pattern:
      /\b(documentos?|archivos?|ficheros?|pdf|docx|leyendo?|abre[r]? el|lee[r]? el|resume|resumen de|mis documentos|mis archivos|contenido de)\b/i,
    tools: ["document.list", "document.read"],
  },
  {
    // Archivos del workspace. Antes no había ninguna señal para `file.io`:
    // la tool quedaba registrada pero el modelo nunca podía invocarla.
    pattern:
      /\b(mis archivos|archivo de texto|crea (un |el |la )?archivo|escribe (un |el |la )?archivo|edita (el |la )?archivo|leeme el archivo|guarda (esto|el archivo) en|workspace)\b/i,
    tools: ["file.io"],
  },
  {
    // Terminal. Solo ante una petición explícita de ejecutar un comando.
    pattern:
      /\b(ejecuta (este |el |un )?comando|corre (este |el |un )?comando|en la terminal|por la terminal|shell|bash)\b/i,
    tools: ["shell.execute"],
  },
  {
    pattern:
      /\b(busca[r]? en|search|noticias|clima|weather|internet|www\.|https?:\/\/|google|precio de|cotizaci[oó]n|qu[eé] es la|qui[eé]n es|cu[aá]ndo fue|d[aá]me info(rmaci[oó]n)? de|lee la (p[aá]gina|url|web)|abre la url|extrae (el |la )?contenido)\b/i,
    // `web.fetch` acompaña a `web.search`: el extracto del buscador rara vez
    // contiene la respuesta (autores, fechas, cifras) y, sin poder leer la
    // página, el agente encadena búsquedas hasta agotar las iteraciones.
    tools: ["web.search", "web.fetch"],
  },
  {
    pattern:
      /\b(m[uú]sica|cancion|canci[oó]n|tema|playlist|ponme .*(m[uú]sica|cancion|canci[oó]n)|pausa (la )?m[uú]sica|para (la )?m[uú]sica|suena|reproduce)\b/i,
    tools: ["music.play"],
  },
  {
    pattern:
      /\b(youtube|youtu\.be|v[ií]deo|videos|canal de youtube|tutorial en v[ií]deo|charla|conferencia|ponme el v[ií]deo|mira el v[ií]deo|transcripci[oó]n)\b/i,
    tools: ["youtube.search", "youtube.transcript"],
  },
  {
    pattern:
      /\b(tareas?|recordatorio|agenda|mis tareas|crea[r]? .*tarea|programa[r]?|pendientes?|completar tarea|borrar tarea)\b/i,
    tools: ["task.create", "task.list", "task.complete", "task.delete"],
  },
  {
    pattern:
      /\b(ejecuta|ejecutar|corre|correr|programa|programar|script|algoritmo|implementa|implementar|python|script en|con c[+\+#]|código fuente)\b/i,
    tools: ["code.execute_interpreter", "code.compile_and_run"],
  },
  {
    pattern:
      /\b(recuerda que|guarda[r]? en memoria|sé lo que|lo que recuerdas|busc[aá]me? en (mi |la )?memoria|busca (en )?(mi |la )?memoria|qué sabes de mí|apunta|olv[ií]dame de|b[oó]rrate de la memoria)\b/i,
    tools: ["memory.remember", "memory.search", "memory.forget", "rag.local_search"],
  },
];

/**
 * Tools que siempre se ofrecen al modelo, aunque el pruneo dinámico no las
 * seleccione. Sin `web.search` el modelo se queda sin forma de investigar
 * cualquier dato externo y puede responder con la herramienta que sí tenía.
 */
export const ALWAYS_AVAILABLE_TOOLS: readonly string[] = ["web.search", "web.fetch"];

/**
 * Fallback de falsos negativos: si la ruta conversacional (sin herramientas)
 * produce una respuesta que delata que el modelo quería datos externos,
 * reintentamos UNA sola vez con el catálogo completo.
 *
 * Los patrones viven en `@jarvis/shared`: la memoria necesita reconocerlos
 * también para no servir desde caché una negativa ya grabada.
 */
export const FALLBACK_PATTERNS: readonly RegExp[] = REFUSAL_PATTERNS;

/**
 * Instrucción que se añade al prompt del sistema cuando se reintenta con el
 * catálogo completo. Sin ella, el modelo repite la misma negativa: acaba de
 * afirmar que no tiene herramientas y el catálogo no ha cambiado.
 */
export const FALLBACK_NUDGE =
  "ATENCIÓN: las herramientas de tu catálogo están habilitadas y funcionan de verdad; no hay que «activar» nada ni pedir permiso para usarlas. Si necesitas un dato externo (precio, resultado, noticia, tratamiento, documentación, dato que cambie), llama a web.search y luego a web.fetch para leer la página. No declares que careces de acceso a herramientas: pruébalo primero. Solo si la herramienta devuelve un error explícito explicas ese error real.";

/**
 * Prefijos con los que arranca una negativa del modelo.
 *
 * Se usan para decidir si un fragmento INCOMPLETO ya es una excusa: si el
 * texto empieza por "No…", todavía no se puede soltar a la voz porque la
 * frase completa podría ser una renuncia.
 */
export const EXCUSE_STEM_PATTERNS: readonly RegExp[] = REFUSAL_STEM_PATTERNS;

/**
 * Resolutor de intención basado en señales léxicas.
 *
 * Implementa `ToolIntentResolver`: el runtime no sabe cómo se decide el
 * catálogo, solo lo consume.
 */
export class IntentToolResolver implements ToolIntentResolver {
  readonly alwaysAvailable: readonly string[] = ALWAYS_AVAILABLE_TOOLS;

  constructor(private readonly signals: readonly ToolSignal[] = TOOL_SIGNALS) {}

  /**
   * Devuelve los nombres reales de las tools que encajan con el texto.
   *
   * El orden es determinista (el de las señales) y el resultado no tiene
   * duplicados: la poda es reproducible, auditable y comparable entre
   * ejecuciones.
   */
  resolve(text: string): readonly string[] {
    const wanted = new Set<string>();
    for (const signal of this.signals) {
      if (!signal.pattern.test(text)) continue;
      for (const name of signal.tools) wanted.add(name);
    }
    return [...wanted];
  }
}

/**
 * Normaliza un nombre real de tool al nombre que entiende el proveedor.
 *
 * Delega en el registro: una sola fuente de verdad. Antes cada capa tenía su
 * propia copia de la expresión regular y cualquier divergencia hacía que un
 * filtro de tools no encontrara nada (el turno se quedaba sin herramientas
 * sin ningún error visible).
 */
export function providerNameOf(toolName: string): string {
  return toProviderSafeName(toolName);
}

/**
 * ¿El texto es una invocación de tool escrita en crudo?
 * Patrón típico del modelo: `web.search(query="…")` o `time.now()`.
 */
export function isRawToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 400) return false;
  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)?\s*\(/.test(trimmed)) return false;
  return trimmed.endsWith(")") && trimmed.includes("(");
}

/** Resume la salida de una tool como respuesta utilizable. */
export function summariseToolOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; summary?: string; data?: unknown; error?: string };
    if (parsed.summary) return parsed.summary;
    if (parsed.error) return `La herramienta falló: ${parsed.error}`;
    if (parsed.data !== undefined) return JSON.stringify(parsed.data).slice(0, 1200);
  } catch {
    /* no es JSON: se devuelve tal cual */
  }
  return raw.slice(0, 1200);
}

/**
 * ¿El texto parece una negativa del modelo?
 *
 * Args:
 *   text: Texto acumulado del turno.
 *
 * Returns:
 *   `true` si el texto delata que el modelo se está rindiendo.
 */
export function looksLikeRefusal(text: string): boolean {
  return FALLBACK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * ¿El inicio del texto puede ser el comienzo de una negativa?
 *
 * Permite decidir con texto incompleto: si el fragmento empieza por "No…",
 * todavía no se puede soltar a la voz porque la frase completa podría ser una
 * renuncia que el runtime debe retener.
 */
export function looksLikeRefusalStem(text: string): boolean {
  return EXCUSE_STEM_PATTERNS.some((pattern) => pattern.test(text));
}
