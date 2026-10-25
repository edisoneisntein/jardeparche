/**
 * Normalización de texto para SÍNTESIS DE VOZ (Text Normalization / Verbalization).
 *
 * Un sintetizador lee LITERALMENTE lo que le dan. Sin esta capa, el TTS dice
 * en voz alta lo que el modelo escribió:
 *
 *   "$1.500,50"        → "dolar uno punto cinco cero cero cero coma cinco cero"
 *   "23/10/2026"       → "veintitrés barra diez barra dos mil veintiséis"
 *   "50%"              → "cincuenta por ciento" (a veces "cincuenta por ciento" partido)
 *   "**negrita**"      → "asterisco negrita asterisco"
 *
 * Aquí se traduce el texto a su forma hablada: números a palabras, fechas a
 * "23 de octubre de 2026", símbolos a su nombre y el markdown a nada.
 *
 * Es una función PURA y sin dependencias: la usan el servidor (antes de
 * sintetizar) y el navegador (respaldo con `speechSynthesis`), así ambos
 * hablan exactamente lo mismo.
 */

/* ──────────────────────────  NÚMEROS A PALABRAS  ────────────────────────── */

const UNIDADES = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince",
  "dieciséis", "diecisiete", "dieciocho", "diecinueve",
];

const DECENAS: Record<number, string> = {
  20: "veinte", 30: "treinta", 40: "cuarenta", 50: "cincuenta",
  60: "sesenta", 70: "setenta", 80: "ochenta", 90: "noventa",
};

/** Del 21 al 29 no se dice "veinte y uno", sino "veintiuno". */
const VEINTIS: Record<number, string> = {
  21: "veintiuno", 22: "veintidós", 23: "veintitrés", 24: "veinticuatro",
  25: "veinticinco", 26: "veintiséis", 27: "veintisiete", 28: "veintiocho", 29: "veintinueve",
};

const CENTENAS: Record<number, string> = {
  100: "ciento", 200: "doscientos", 300: "trescientos", 400: "cuatrocientos",
  500: "quinientos", 600: "seiscientos", 700: "setecientos", 800: "ochocientos",
  900: "novecientos",
};

/** Ordinales frecuentes: [masculino, femenino]. */
const ORDINALES: Record<number, [string, string]> = {
  1: ["primer", "primera"],
  2: ["segundo", "segunda"],
  3: ["tercer", "tercera"],
  4: ["cuarto", "cuarta"],
  5: ["quinto", "quinta"],
  6: ["sexto", "sexta"],
  7: ["séptimo", "séptima"],
  8: ["octavo", "octava"],
  9: ["noveno", "novena"],
  10: ["décimo", "décima"],
};

/**
 * Forma apocopada: "veintiuno años" → "veintiún años", "uno kilos" → "un kilos".
 * Se aplica solo cuando el número va seguido de una palabra (sustantivo).
 */
function apocopar(palabras: string): string {
  if (palabras.endsWith("veintiuno")) return `${palabras.slice(0, -"veintiuno".length)}veintiún`;
  if (palabras === "uno") return "un";
  if (palabras.endsWith(" uno")) return `${palabras.slice(0, -"uno".length)}un`;
  return palabras;
}

/** Convierte un entero a palabras en español. */
export function numberToSpanishWords(value: number, apocope = false): string {
  if (!Number.isFinite(value)) return "";
  const n = Math.trunc(Math.abs(value));
  const sign = value < 0 ? "menos " : "";
  const words = integerToWords(n);
  return sign + (apocope ? apocopar(words) : words);
}

function integerToWords(n: number): string {
  if (n < 20) return UNIDADES[n] ?? String(n);
  if (n < 30 && VEINTIS[n]) return VEINTIS[n];
  if (n < 100) {
    const decena = Math.floor(n / 10) * 10;
    const unidad = n % 10;
    return DECENAS[decena] + (unidad ? ` y ${UNIDADES[unidad]}` : "");
  }
  if (n < 1000) {
    const centena = Math.floor(n / 100) * 100;
    const resto = n % 100;
    const head = n === 100 ? "cien" : CENTENAS[centena];
    return head + (resto ? ` ${integerToWords(resto)}` : "");
  }
  if (n < 1_000_000) {
    const miles = Math.floor(n / 1000);
    const resto = n % 1000;
    // "ciento un mil", no "ciento uno mil".
    const head = miles === 1 ? "mil" : `${miles % 100 === 1 ? "ciento un" : integerToWords(miles)} mil`;
    return head + (resto ? ` ${integerToWords(resto)}` : "");
  }
  if (n < 1_000_000_000) {
    const millones = Math.floor(n / 1_000_000);
    const resto = n % 1_000_000;
    const head = millones === 1 ? "un millón" : `${millones % 100 === 1 ? "ciento un" : integerToWords(millones)} millones`;
    return head + (resto ? ` ${integerToWords(resto)}` : "");
  }
  const milesDeMillon = Math.floor(n / 1_000_000_000);
  const resto = n % 1_000_000_000;
  const head = milesDeMillon === 1 ? "mil millones" : `${integerToWords(milesDeMillon)} mil millones`;
  return head + (resto ? ` ${integerToWords(resto)}` : "");
}

/** Parte decimal leída dígito a dígito: "0,50" → "cero coma cinco cero". */
function decimalToWords(frac: string): string {
  return frac.split("").map((digit) => UNIDADES[Number(digit)] ?? digit).join(" ");
}

/* ──────────────────────────  ANÁLISIS DE CIFRAS  ────────────────────────── */

export interface ParsedNumber {
  /** Parte entera, ya limpia de separadores. */
  integer: string;
  /** Parte decimal, si la había. */
  fraction: string | null;
  negative: boolean;
}

/**
 * Interpreta un número escrito con separadores.
 *
 * El formato es ambiguo: "1.500" son mil quinientos en español y uno coma
 * cinco en inglés. Se aplica la convención del idioma de la locución
 * (español): el separador con exactamente tres dígitos detrás es de millares;
 * con uno o dos, es decimal. Si aparecen ambos separadores, el ÚLTIMO es el
 * decimal ("1,500.50" → 1500,50; "1.500,50" → 1500,50).
 */
export function parseNumberToken(token: string): ParsedNumber | null {
  const match = /^([+-]?)(\d[\d.,]*\d|\d)$/.exec(token.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  const body = match[2] ?? "";

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;

  let integer = body;
  let fraction: string | null = null;

  if (dots > 0 && commas > 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    integer = body.slice(0, decimalAt).replace(/[.,]/g, "");
    fraction = body.slice(decimalAt + 1);
  } else if (dots > 0 || commas > 0) {
    const separator = dots > 0 ? "." : ",";
    const count = dots > 0 ? dots : commas;
    const at = body.lastIndexOf(separator);
    const tail = body.slice(at + 1);
    if (count === 1 && tail.length === 3) {
      // "1.500" → 1500 (millares).
      integer = body.replace(/[.,]/g, "");
    } else {
      integer = body.slice(0, at).replace(/[.,]/g, "");
      fraction = tail;
    }
  }

  if (!/^\d+$/.test(integer)) return null;
  if (fraction !== null && !/^\d+$/.test(fraction)) return null;
  return { integer, fraction, negative };
}

/* ──────────────────────────  SÍMBOLOS Y UNIDADES  ────────────────────────── */

/** Unidades con su forma singular y plural (el plural depende de la cifra). */
const UNIDADES_MEDIDA: Array<[RegExp, string, string]> = [
  [/^\s*km\/h\b/i, "kilómetro por hora", "kilómetros por hora"],
  [/^\s*kWh\b/i, "kilovatio hora", "kilovatios hora"],
  [/^\s*kW\b/i, "kilovatio", "kilovatios"],
  [/^\s*MB\/s\b/i, "megabyte por segundo", "megabytes por segundo"],
  [/^\s*MB\b/, "megabyte", "megabytes"],
  [/^\s*GB\b/, "gigabyte", "gigabytes"],
  [/^\s*TB\b/, "terabyte", "terabytes"],
  [/^\s*KB\b/, "kilobyte", "kilobytes"],
  [/^\s*km\b/i, "kilómetro", "kilómetros"],
  [/^\s*cm\b/i, "centímetro", "centímetros"],
  [/^\s*mm\b/i, "milímetro", "milímetros"],
  [/^\s*kg\b/i, "kilogramo", "kilogramos"],
  [/^\s*mg\b/i, "miligramo", "miligramos"],
  [/^\s*ml\b/i, "mililitro", "mililitros"],
  [/^\s*l\b/, "litro", "litros"],
  [/^\s*°\s*C\b/, "grado Celsius", "grados Celsius"],
  [/^\s*°\s*F\b/, "grado Fahrenheit", "grados Fahrenheit"],
  [/^\s*°/, "grado", "grados"],
];

const MONEDAS: Record<string, string> = {
  "US$": "dólares",
  $: "dólares",
  "€": "euros",
  "£": "libras",
  "¥": "yenes",
  "₿": "bitcoins",
};

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/* ──────────────────────────  LIMPIEZA DE MARKDOWN  ────────────────────────── */

/**
 * Quita el markdown. Sin esto el TTS pronuncia "asterisco", "corchete" o
 * "guion bajo" en mitad de la frase.
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " código ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[«»""“”„]/g, "")
    .replace(/`/g, "")
    // Markdown que llega SIN pareja (el modelo escribe "**¿Qué es...?" y deja
    // un "**" suelto): si no se quitan, el TTS pronuncia "asterisco".
    .replace(/\*\*?/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+\.\s+/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ──────────────────────────  NORMALIZACIÓN  ────────────────────────── */

/** Marcador interno: protege lo ya verbalizado de las reglas de cifras. */
const MARK = "\u0001";
/** Carácter de índice privado: no contiene dígitos, así que las reglas numéricas no lo tocan. */
const INDEX_BASE = 0xe000;

function spokenUrl(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split(/[/?#]/)[0] ?? withoutScheme;
  const parts = host.split(".").filter(Boolean);
  if (parts.length === 0) return "";
  const words = parts.map((part) => {
    if (/^\d+$/.test(part)) return part.split("").map((digit) => UNIDADES[Number(digit)]).join(" ");
    if (part === "www") return "doble ve doble ve";
    return part;
  });
  return `dirección web ${words.join(" punto ")}`;
}

function spokenEmail(mail: string): string {
  const [user, domain] = mail.split("@");
  if (!domain) return mail;
  return `${user} arroba ${domain.split(".").join(" punto ")}`;
}

/** ¿La posición siguiente es una palabra? (decide "veintiún años" vs "veintiuno") */
function nextIsWord(text: string, from: number): boolean {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (/\s/.test(char)) continue;
    return /[\p{L}]/u.test(char);
  }
  return false;
}

/** Forma hablada de una cifra, con signo y decimales. */
function speakNumber(parsed: ParsedNumber, apocope: boolean): string {
  const value = Number(parsed.integer);
  const negative = parsed.negative;
  const integerWords = numberToSpanishWords(negative ? -value : value, apocope);
  if (parsed.fraction === null) return integerWords;
  return `${integerWords} coma ${decimalToWords(parsed.fraction)}`;
}

/**
 * Normaliza texto para que suene bien dicho.
 *
 * Es idempotente: normalizar dos veces da el mismo resultado.
 */
export function normalizeForSpeech(input: string): string {
  if (!input) return "";
  let text = stripMarkdown(input);

  // 1. URLs, correos e IPs: se apartan para que las reglas de cifras no los toquen.
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    protectedParts.push(value);
    return `${MARK}${String.fromCharCode(INDEX_BASE + protectedParts.length - 1)}${MARK}`;
  };

  text = text.replace(/https?:\/\/[^\s<>"'）)]+/gi, (url) => protect(spokenUrl(url)));
  text = text.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, (mail) => protect(spokenEmail(mail)));
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) =>
    protect(`dirección ip ${ip.split(".").map((part) => UNIDADES[Number(part)]).join(" punto ")}`),
  );

  // 2. Fechas en formato numérico: "23/10/2026" → "23 de octubre de 2026".
  text = text.replace(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g, (_match, day, month, year) => {
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) return `${day} de ${month} de ${year}`;
    return `${day} de ${MESES[monthIndex]} de ${year}`;
  });
  text = text.replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_match, year, month, day) => {
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) return `${day} de ${month} de ${year}`;
    return `${day} de ${MESES[monthIndex]} de ${year}`;
  });

  // 3. Horas: "14:30" → "14 y 30"; "14:00" → "14 en punto".
  text = text.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_match, hour, minute) =>
    minute === "00" ? `${hour} en punto` : `${hour} y ${minute}`,
  );

  // 4. Rangos: "10-20" → "de 10 a 20". Con guion solo si ambas partes son cortas
  //    (si no, "2024-10" sería un año, no un rango).
  text = text.replace(/(?<![\d.,$€£¥])(\d{1,3})\s*[-–—]\s*(\d{1,3})(?![\d.,])/g, (_match, from, to) =>
    `de ${from} a ${to}`,
  );

  // 5. Ordinales: "1º" → "primer", "2ª" → "segunda". Antes de convertir cifras.
  text = text.replace(/\b(\d{1,2})([ºª])(?=\s|$)/g, (_match, raw: string, marker: string) => {
    const value = Number(raw);
    const entry = ORDINALES[value];
    if (!entry) return raw;
    return marker === "ª" ? entry[1] : entry[0];
  });

  // 6. Moneda: "$1,500.50" → "mil quinientos dólares con cincuenta centavos".
  //    Admite el símbolo delante ("$1500") y detrás ("1500 €").
  const speakCurrency = (amount: string, symbol: string, apocope: boolean): string | null => {
    const parsed = parseNumberToken(amount);
    if (!parsed) return null;
    const unit = MONEDAS[symbol] ?? "unidades";
    const value = Number(parsed.integer);
    const integerWords = numberToSpanishWords(parsed.negative ? -value : value, apocope);
    if (parsed.fraction === null) return `${integerWords} ${unit}`;
    const cents = Number(parsed.fraction);
    if (cents === 0) return `${integerWords} ${unit}`;
    const centName = unit === "dólares" ? "centavos" : "céntimos";
    return `${integerWords} ${unit} con ${numberToSpanishWords(cents)} ${centName}`;
  };

  text = text.replace(
    /(US\$|[$€£¥₿])\s*(\d[\d.,]*\d|\d)(?=\D|$)/g,
    (match, symbol: string, amount: string, offset: number, whole: string) =>
      speakCurrency(amount, symbol, nextIsWord(whole, offset + match.length)) ?? match,
  );
  text = text.replace(
    /(\d[\d.,]*\d|\d)\s*(US\$|[$€£¥₿])(?=\D|$)/g,
    (match, amount: string, symbol: string, offset: number, whole: string) =>
      speakCurrency(amount, symbol, nextIsWord(whole, offset + match.length)) ?? match,
  );

  // 7. Cifra + unidad: "50 km/h" → "cincuenta kilómetros por hora".
  //    Sin límite de palabra antes de la cifra para que "5km" también case.
  text = text.replace(
    /(?<![\p{L}])([+-]?)(\d[\d.,]*\d|\d)(\s*)(km\/h|kWh|kW|MB\/s|MB|GB|TB|KB|km|cm|mm|kg|mg|ml|°\s*C|°\s*F|°|l)(?![a-zA-ZÀ-ÿ])/giu,
    (match, sign: string, raw: string, gap: string, unit: string) => {
      const parsed = parseNumberToken(`${sign}${raw}`);
      if (!parsed) return match;
      const value = Number(parsed.integer);
      const rule = UNIDADES_MEDIDA.find(([pattern]) => pattern.test(gap + unit));
      if (!rule) return match;
      const [pattern, singular, plural] = rule;
      const unitWords = value === 1 ? singular : plural;
      const numberWords = numberToSpanishWords(parsed.negative ? -value : value, true);
      void pattern;
      return `${numberWords} ${unitWords}`;
    },
  );

  // 8. Cifras sueltas: porcentajes, decimales y enteros.
  text = text.replace(
    /([+-]?)\b(\d[\d.,]*\d|\d)\b(\s*%)?/g,
    (match, sign: string, raw: string, percent: string | undefined, offset: number, whole: string) => {
      const parsed = parseNumberToken(raw);
      if (!parsed) return match;
      const apocope = !percent && !sign && nextIsWord(whole, offset + match.length);
      const words = speakNumber(parsed, apocope);
      // El signo va por delante: "+3" se lee "más tres", "-3" se lee "menos tres".
      const withSign = sign === "+" ? ` más ${words}` : sign === "-" ? ` menos ${words}` : words;
      return percent ? `${withSign} por ciento` : withSign;
    },
  );

  // 9. Símbolos sueltos.
  text = text
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[&]/g, " y ")
    .replace(/@/g, " arroba ")
    .replace(/#/g, " hash ")
    .replace(/\+/g, " más ")
    .replace(/=/g, " igual a ")
    .replace(/~/g, " aproximadamente ")
    .replace(/[±]/g, " más o menos ")
    .replace(/[≤]/g, " menor o igual a ")
    .replace(/[≥]/g, " mayor o igual a ")
    .replace(/[≠]/g, " distinto de ")
    .replace(/[×]/g, " por ")
    .replace(/[÷]/g, " dividido por ")
    .replace(/…/g, "...")
    .replace(/[•]/g, ", ")
    .replace(/[·]/g, " coma ");

  // 10. Se restauran las partes protegidas.
  text = text.replace(
    new RegExp(`${MARK}([\\uE000-\\uF8FF])${MARK}`, "g"),
    (_match, char: string) => protectedParts[char.charCodeAt(0) - INDEX_BASE] ?? "",
  );

  return text
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
