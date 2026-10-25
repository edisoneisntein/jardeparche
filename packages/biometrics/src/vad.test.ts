import { describe, expect, it } from "vitest";
import { BiometricsError } from "./errors.js";
import { createVad } from "./vad.js";

function speechFrame(amplitude = 8_000): Int16Array {
  const frame = new Int16Array(1_024);
  for (let index = 0; index < frame.length; index += 1) {
    frame[index] = Math.round(amplitude * Math.sin((2 * Math.PI * 180 * index) / 16_000));
  }
  return frame;
}

function noiseFrame(amplitude = 100): Int16Array {
  const frame = new Int16Array(1_024);
  let state = 0x1234_5678;
  for (let index = 0; index < frame.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    frame[index] = Math.round(((state / 0xffffffff) * 2 - 1) * amplitude);
  }
  return frame;
}

describe("VAD", () => {
  it("detecta una señal de voz con energía y zero-crossing válidos", () => {
    const vad = createVad();

    const result = vad.process(speechFrame());

    expect(result.speech).toBe(true);
    expect(result.probability).toBeGreaterThan(0.9);
    expect(result.rms).toBeGreaterThan(3_000);
  });

  it("rechaza ruido de baja energía", () => {
    const vad = createVad();

    const result = vad.process(noiseFrame());

    expect(result.speech).toBe(false);
    expect(result.probability).toBeLessThan(0.1);
    expect(result.rms).toBeLessThan(300);
  });

  it("mantiene el estado de voz durante el hangover configurado", () => {
    const vad = createVad({ hangoverFrames: 2 });

    vad.process(speechFrame());
    const firstNoise = vad.process(noiseFrame());
    const secondNoise = vad.process(noiseFrame());
    const thirdNoise = vad.process(noiseFrame());

    expect(firstNoise.speech).toBe(true);
    expect(secondNoise.speech).toBe(true);
    expect(thirdNoise.speech).toBe(false);
  });

  it("restablece el estado de habla", () => {
    const vad = createVad();

    vad.process(speechFrame());
    vad.reset();

    expect(vad.isSpeaking).toBe(false);
    expect(vad.process(noiseFrame()).speech).toBe(false);
  });

  it("permite inyectar un detector neuronal", () => {
    const vad = createVad({
      neural: { probability: () => 0.95 },
    });

    const result = vad.process(noiseFrame());

    expect(result.speech).toBe(true);
    expect(result.probability).toBe(0.95);
  });

  it("rechaza tramas vacías", () => {
    const vad = createVad();

    expect(() => vad.process(new Int16Array(0))).toThrow(BiometricsError);
  });

  it("rechaza configuraciones de umbral inválidas", () => {
    expect(() => createVad({ threshold: 1.5 })).toThrow(BiometricsError);
    expect(() => createVad({ energyCeiling: 10, energyThreshold: 20 })).toThrow(BiometricsError);
  });
});
