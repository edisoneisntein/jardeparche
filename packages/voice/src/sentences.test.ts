import { describe, expect, it } from "vitest";
import { safeCut, splitSentences } from "./sentences.js";
import { estimateDurationMs } from "./tts.js";

describe("segmentación en frases", () => {
  it("parte por puntos,y conserva cifras y URLs", () => {
    const text = "La cita es 1.500,50 euros. Visita https://ejemplo.com/a.b para más detalles. Fin.";
    const sentences = splitSentences(text);
    expect(sentences.length).toBe(3);
    expect(sentences[0]?.text).toContain("1.500,50");
    expect(sentences[1]?.text).toContain("https://ejemplo.com/a.b");
  });

  it("parte la frase aunque el número lleve decimales en formato inglés", () => {
    // El punto de "1,500.50" NO es el final de la frase: el que lo es, el
    // punto detrás del 50. Antes este caso no se partía nunca y el TTS se
    // callaba hasta el final del turno.
    const sentences = splitSentences("El total es $1,500.50. Lo siguiente es lo importante.");
    expect(sentences.length).toBe(2);
    expect(sentences[0]?.text).toContain("1,500.50");
  });

  it("no parte en abreviaturas", () => {
    const sentences = splitSentences("El Sr. Pérez llegó tarde. Fue puntual al final.");
    expect(sentences.length).toBe(2);
    expect(sentences[0]?.text).toContain("Sr. Pérez");
  });

  it("parte un texto largo en trozos manejables", () => {
    const largo = `${"palabra ".repeat(80)}.`;
    const sentences = splitSentences(largo, 120);
    expect(sentences.length).toBeGreaterThan(1);
    for (const sentence of sentences) expect(sentence.text.length).toBeLessThanOrEqual(140);
  });

  it("devuelve vacío para texto vacío", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("corte seguro del texto pendiente", () => {
  it("no parte una cifra", () => {
    const text = "El total es 1.500,50 euros y seguimos";
    const cut = safeCut(text, 30);
    expect(text.slice(0, cut)).not.toMatch(/\d$/);
  });

  it("no deja una palabra auxiliar colgando", () => {
    const text = "He revisado la configuración y el resultado";
    const cut = safeCut(text, 40);
    const lastWord = text.slice(0, cut).match(/([\p{L}]+)$/u)?.[1]?.toLowerCase() ?? "";
    expect(["y", "el", "la", "de"]).not.toContain(lastWord);
  });
});

describe("duración estimada de un WAV", () => {
  it("calcula los milisegundos a partir del tamaño del PCM", () => {
    const pcm = Buffer.alloc(44 + 2 * 22_050); // 1 segundo de audio
    expect(estimateDurationMs(pcm)).toBe(1000);
  });
});
