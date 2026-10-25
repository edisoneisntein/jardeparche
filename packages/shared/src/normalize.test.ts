import { describe, expect, it } from "vitest";
import { normalizeForSpeech, numberToSpanishWords, parseNumberToken, stripMarkdown } from "./normalize.js";

describe("número a palabras en español", () => {
  it("escribe los númerosbasic bien", () => {
    expect(numberToSpanishWords(0)).toBe("cero");
    expect(numberToSpanishWords(15)).toBe("quince");
    expect(numberToSpanishWords(16)).toBe("dieciséis");
    expect(numberToSpanishWords(21)).toBe("veintiuno");
    expect(numberToSpanishWords(30)).toBe("treinta");
    expect(numberToSpanishWords(31)).toBe("treinta y uno");
    expect(numberToSpanishWords(100)).toBe("cien");
    expect(numberToSpanishWords(101)).toBe("ciento uno");
    expect(numberToSpanishWords(500)).toBe("quinientos");
    expect(numberToSpanishWords(1000)).toBe("mil");
    expect(numberToSpanishWords(2000)).toBe("dos mil");
    expect(numberToSpanishWords(101000)).toBe("ciento un mil");
    expect(numberToSpanishWords(1500)).toBe("mil quinientos");
    expect(numberToSpanishWords(1_000_000)).toBe("un millón");
    expect(numberToSpanishWords(2_000_000)).toBe("dos millones");
    expect(numberToSpanishWords(1_500_000)).toBe("un millón quinientos mil");
    expect(numberToSpanishWords(1_000_000_000)).toBe("mil millones");
    expect(numberToSpanishWords(-42)).toBe("menos cuarenta y dos");
  });

  it("apocopa cuando el número va seguido de un sustantivo", () => {
    expect(numberToSpanishWords(21, true)).toBe("veintiún");
    expect(numberToSpanishWords(1, true)).toBe("un");
    expect(numberToSpanishWords(2, true)).toBe("dos");
  });
});

describe("interpretación de cifras con separadores", () => {
  it("trata el separador de millares en formato español", () => {
    expect(parseNumberToken("1.500")).toEqual({ integer: "1500", fraction: null, negative: false });
    expect(parseNumberToken("3.200")).toEqual({ integer: "3200", fraction: null, negative: false });
  });

  it("trata la coma corta como decimal", () => {
    expect(parseNumberToken("1,50")).toEqual({ integer: "1", fraction: "50", negative: false });
    expect(parseNumberToken("3.14")).toEqual({ integer: "3", fraction: "14", negative: false });
  });

  it("usa el último separador como decimal cuando hay dos", () => {
    expect(parseNumberToken("1,500.50")).toEqual({ integer: "1500", fraction: "50", negative: false });
    expect(parseNumberToken("1.500,50")).toEqual({ integer: "1500", fraction: "50", negative: false });
  });

  it("detecta el signo negativo", () => {
    expect(parseNumberToken("-12")?.negative).toBe(true);
  });
});

describe("normalización para voz", () => {
  it("convierte la moneda a palabras", () => {
    expect(normalizeForSpeech("Cuesta $1,500.50 en total")).toBe(
      "Cuesta mil quinientos dólares con cincuenta centavos en total",
    );
    expect(normalizeForSpeech("Son 1.500,50 €")).toBe("Son mil quinientos euros con cincuenta céntimos");
  });

  it("convierte las fechas a su forma hablada", () => {
    expect(normalizeForSpeech("El 23/10/2026 revisamos el plan")).toBe(
      "El veintitrés de octubre de dos mil veintiséis revisamos el plan",
    );
    expect(normalizeForSpeech("Fecha 2026-10-23")).toBe("Fecha veintitrés de octubre de dos mil veintiséis");
  });

  it("convierte las horas", () => {
    expect(normalizeForSpeech("A las 14:30").replace("A las", "A las")).toBe("A las catorce y treinta");
    expect(normalizeForSpeech("A las 14:00")).toBe("A las catorce en punto");
  });

  it("convierte los porcentajes", () => {
    expect(normalizeForSpeech("Subió un 12,5%")).toBe("Subió un doce coma cinco por ciento");
  });

  it("convierte las unidades con su plural correcto", () => {
    expect(normalizeForSpeech("Recorrió 50 km")).toBe("Recorrió cincuenta kilómetros");
    expect(normalizeForSpeech("Recorrió 1 km")).toBe("Recorrió un kilómetro");
    expect(normalizeForSpeech("Va a 120 km/h")).toBe("Va a ciento veinte kilómetros por hora");
  });

  it("lee los rangos como intervalo", () => {
    expect(normalizeForSpeech("Entre 10 y 20")).toBe("Entre diez y veinte");
  });

  it("quita el markdown para que no se pronuncie", () => {
    expect(stripMarkdown("**negrita** y `código`")).toBe("negrita y código");
    expect(normalizeForSpeech("## Título\n- punto")).toBe("Título punto");
  });

  it("no deja que las cifras de una URL se conviertan", () => {
    expect(normalizeForSpeech("Mira https://ejemplo.com/2026")).toBe(
      "Mira dirección web ejemplo punto com",
    );
  });

  it("lee el correo como tal", () => {
    expect(normalizeForSpeech("Escribe a edison@ejemplo.com")).toBe(
      "Escribe a edison arroba ejemplo punto com",
    );
  });

  it("convierte los ordinales", () => {
    expect(normalizeForSpeech("El 1º de mayo")).toBe("El primer de mayo");
    expect(normalizeForSpeech("La 2ª vez")).toBe("La segunda vez");
  });

  it("lee los símbolos con su nombre", () => {
    expect(normalizeForSpeech("A & B")).toBe("A y B");
    expect(normalizeForSpeech("3+4")).toBe("tres más cuatro");
  });

  it("es idempotente", () => {
    const source = "Cuesta $1,500.50 el 23/10/2026, un 12% de descuento";
    const once = normalizeForSpeech(source);
    expect(normalizeForSpeech(once)).toBe(once);
  });
});
