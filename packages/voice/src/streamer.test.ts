import { describe, expect, it, vi } from "vitest";
import { SentenceStreamer, type StreamSegment } from "./streamer.js";
import type { TtsEngine, TtsResult } from "./tts.js";

function fakeTts(delayMs = 0): { tts: TtsEngine; calls: string[] } {
  const calls: string[] = [];
  const tts: TtsEngine = {
    name: "fake",
    available: async () => ({ ok: true }),
    synthesize: async (text: string): Promise<TtsResult> => {
      calls.push(text);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        audio: Buffer.from(text),
        mimeType: "audio/wav",
        sampleRate: 22_050,
        durationMs: text.length * 10,
      };
    },
  };
  return { tts, calls };
}

function collector(): { segments: StreamSegment[]; ends: string[]; onSegment: (s: StreamSegment) => void; onEnd: (g: string) => void } {
  const segments: StreamSegment[] = [];
  const ends: string[] = [];
  return {
    segments,
    ends,
    onSegment: (segment) => segments.push(segment),
    onEnd: (generationId) => ends.push(generationId),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("SentenceStreamer", () => {
  it("sintetiza por frases, en orden, y avisa del final", async () => {
    const { tts, calls } = fakeTts();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Primera frase. ");
    streamer.push("Segunda frase. ");
    streamer.flush();
    await tick();

    expect(calls).toEqual(["Primera frase.", "Segunda frase."]);
    expect(sink.segments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(sink.segments.every((segment) => segment.generationId === "g1")).toBe(true);
    expect(sink.ends).toEqual(["g1"]);
  });

  it("no sintetiza hasta que la frase está cerrada", async () => {
    const { tts, calls } = fakeTts();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Frase a medio");
    await tick();
    expect(calls).toEqual([]);

    streamer.push(" cerrar.");
    await tick();
    expect(calls).toEqual(["Frase a medio cerrar."]);
  });

  it("Corta el texto pendiente para no esperar a una frase entera", async () => {
    const { tts, calls } = fakeTts();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd, maxPendingChars: 40 });

    streamer.start("g1");
    streamer.push("Esta es una enumeración bastante larga sin ningún punto ");
    streamer.push("que separe las partes del texto que va llegando");
    await tick();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.length).toBeLessThanOrEqual(40);
  });

  it("no parte cifras al cortar el texto pendiente", async () => {
    const { tts, calls } = fakeTts();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd, maxPendingChars: 30 });

    streamer.start("g1");
    streamer.push("El total es 1.500,50 euros y el resto de la frase sigue");
    await tick();

    // La cifra se lee entera en un solo fragmento: no se parte en dos.
    expect(calls.some((text) => text.includes("mil quinientos coma cinco cero"))).toBe(true);
  });

  it("normaliza el texto antes de sintetizarlo", async () => {
    const { tts, calls } = fakeTts();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Cuesta $1,500.50.");
    streamer.flush();
    await tick();

    expect(calls).toEqual(["Cuesta mil quinientos dólares con cincuenta centavos."]);
  });

  it("NO verbaliza el turno interrumpido (carrera de generación)", async () => {
    const { tts, calls } = fakeTts(20);
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Respuesta larga de la pregunta anterior. ");
    // La síntesis ya está en marcha cuando el usuario interrumpe.
    await tick();
    streamer.stop();

    // Llega un turno nuevo: su texto no puede mezclarse con el anterior.
    streamer.start("g2");
    streamer.push("Respuesta nueva. ");
    streamer.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const published = sink.segments.map((segment) => segment.text);
    expect(published.some((text) => text.includes("Respuesta larga"))).toBe(false);
    expect(published).toEqual(["Respuesta nueva."]);
    expect(sink.segments.every((segment) => segment.generationId === "g2")).toBe(true);
  });

  it("descarta el audio que ya estaba sintetizándose cuando se cancela", async () => {
    const { tts } = fakeTts(30);
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Frase que ya está en el sintetizador.");
    await tick();
    streamer.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sink.segments).toHaveLength(0);
  });

  it("descarta lo que quedara pendiente tras una interrupción", async () => {
    const { tts } = fakeTts(0);
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd });

    streamer.start("g1");
    streamer.push("Antes. ");
    streamer.stop();
    streamer.push("Después. ");
    streamer.flush();
    await tick();

    // Nada de lo interrumpido llega a sonar: ni el fragmento en cola ni el
    // texto que llegó después de la interrupción.
    expect(sink.segments).toHaveLength(0);
    expect(sink.ends).toEqual([]);
  });

  it("informa de los fallos de síntesis sin romper la locución", async () => {
    const error = new Error("sin voz");
    const tts: TtsEngine = {
      name: "roto",
      available: async () => ({ ok: true }),
      synthesize: async () => {
        throw error;
      },
    };
    const onError = vi.fn();
    const sink = collector();
    const streamer = new SentenceStreamer({ tts, onSegment: sink.onSegment, onEnd: sink.onEnd, onError });

    streamer.start("g1");
    streamer.push("Frase. ");
    streamer.flush();
    await tick();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
