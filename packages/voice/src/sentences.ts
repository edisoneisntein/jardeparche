/**
 * Segmentación de texto en frases para la síntesis por partes.
 *
 * El corte NO puede partir un número ni una URL: "1.500,50" y
 * "https://ejemplo.com/a.b" deben quedarse enteros, o la voz leería
 * "mil euros con cincuenta" como dos fragmentos sin relación.
 *
 * La segmentación se aplica al texto YA normalizado para voz (sin markdown),
 * así que solo hay que proteger cifras, abreviaturas y URLs.
 */

export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/** Abreviaturas que terminan en punto pero no cierran frase. */
const ABBREVIATIONS = new Set([
  "sr", "sra", "srta", "dr", "dra", "etc", "ej", "p", "pág", "págs", "vol", "núm",
  "art", "fig", "cap", "approx", "min", "max", "av", "ud", "uds", "d", "c", "b",
]);

/** ¿El carácter en `index` está dentro de una cifra (no es un corte de frase)? */
function insideNumber(text: string, index: number): boolean {
  const before = text[index - 1] ?? "";
  const after = text[index + 1] ?? "";
  const digitBefore = /\d/.test(before);
  const digitAfter = /\d/.test(after);
  // "1.500" y "3.14": el punto está entre dígitos o entre dígitos y separador.
  if (digitBefore && digitAfter) return true;
  // "1.500,50": coma entre dígitos.
  if ((before === "," || before === ".") && /\d/.test(after)) return true;
  return false;
}

/** ¿El corte cae dentro de una URL o un identificador con puntos? */
function insideToken(text: string, index: number): boolean {
  const start = Math.max(0, index - 60);
  const window = text.slice(start, index + 1);
  if (/https?:\/\/\S*$/i.test(window)) return true;
  // Solo los identificadores con LETRAS ("ejemplo.com", "fichero.txt"). Una
  // cifra con decimales ("1,500.50") NO es un token: si lo fuera, el punto que
  // cierra la frase se tomaría por parte de un nombre de archivo y la frase
  // nunca se cerraría (el TTS se callaba hasta el final del turno).
  if (/[\p{L}][\p{L}\d-]*(\.[\p{L}\d-]+){1,}\S*$/u.test(window)) return true;
  return false;
}

/**
 * Palabras que no deben quedar colgando al final de un fragmento: cortarlas
 * ahí produce una locución partida ("y" / "el" / "de"), que el sintetizador
 * lee con un troceo raro.
 */
const STOP_WORDS = new Set([
  "y", "e", "o", "u", "que", "de", "del", "la", "el", "los", "las", "un", "una",
  "en", "a", "al", "con", "sin", "por", "para", "como", "cuando", "si", "más",
  "muy", "pero", "ni", "ha", "he", "hay", "fue", "sea", "lo", "su", "sus", "le",
  "les", "me", "te", "se", "nos", "ya", "no", "tu", "este", "esta", "esto",
  "ese", "esa", "tan", "tras", "sobre", "bajo", "entre", "hasta", "desde",
  "durante", "según", "mediante", "hacia", "cada", "todo", "toda", "todos",
  "todas", "otro", "otra", "mismo", "misma", "solo", "sólo", "ser", "estar",
  "tener", "hacer", "poder", "decir", "dar", "ver", "ir", "al",
]);

/**
 * Punto de corte seguro: no parte cifras ni identificadores.
 *
 * Busca hacia atrás desde `limit` un límite natural (espacio, coma, punto y
 * coma) que no rompa un número ("1 500", "1.500") ni una URL, y que no deje
 * una palabra auxiliar colgando al final del fragmento. Si no encuentra
 * ninguno, devuelve el límite tal cual.
 */
export function safeCut(text: string, limit: number): number {
  const max = Math.min(limit, text.length);
  for (let index = max; index > 0; index -= 1) {
    const char = text[index - 1];
    if (char !== " " && char !== "," && char !== ";" && char !== ":") continue;
    if (insideNumber(text, index - 1) || insideToken(text, index - 1)) continue;
    if (char === " ") {
      // La última palabra del fragmento no debe ser una auxiliar.
      const word = text.slice(0, index - 1).match(/([\p{L}]+)$/u)?.[1]?.toLowerCase() ?? "";
      if (STOP_WORDS.has(word)) continue;
    }
    return index;
  }
  return max;
}

/** Divide el texto en frases respeitando cifras, URLs y abreviaturas. */
export function splitSentences(text: string, maxChars = 320): SentenceSpan[] {
  // El texto NO se recorta: los desplazamientos (`start`/`end`) se devuelven
  // sobre la cadena original, para que quien lo use recupere el texto
  // pendiente tal cual (con sus espacios) y no pierda palabras al recomponer.
  const source = text;
  if (!source.trim()) return [];
  const spans: SentenceSpan[] = [];
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char !== "." && char !== "!" && char !== "?" && char !== ";" && char !== "\n") continue;
    if (char === "." && insideNumber(source, index)) continue;
    if (char === "." && insideToken(source, index)) continue;
    if (char === ".") {
      const word = source.slice(Math.max(0, index - 12), index).match(/([\p{L}]+)$/u)?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word)) continue;
    }
    // Consume el espacio posterior para no arrastrarlo al siguiente fragmento.
    let end = index + 1;
    while (end < source.length && (source[end] === " " || source[end] === "\n")) end += 1;
    const chunk = source.slice(start, end);
    if (chunk.trim()) spans.push({ text: chunk, start, end });
    start = end;
    index = end - 1;
  }

  const tail = source.slice(start);
  if (tail.trim()) spans.push({ text: tail, start, end: source.length });

  // Fragmentos demasiado largos: se parten por comas o por longitud máxima.
  const sized: SentenceSpan[] = [];
  for (const span of spans) {
    if (span.text.trim().length <= maxChars) {
      sized.push(span);
      continue;
    }
    let cursor = 0;
    while (cursor < span.text.length) {
      let cut = Math.min(span.text.length, cursor + maxChars);
      if (cut < span.text.length) {
        const comma = span.text.lastIndexOf(",", cut);
        if (comma > cursor + 40) cut = comma + 1;
      }
      const piece = span.text.slice(cursor, cut);
      if (piece.trim()) sized.push({ text: piece, start: span.start + cursor, end: span.start + cut });
      cursor = cut;
    }
  }
  return sized;
}
