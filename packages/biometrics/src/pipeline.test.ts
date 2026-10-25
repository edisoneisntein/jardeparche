import { describe, expect, it, vi } from "vitest";
import { BiometricsError } from "./errors.js";
import {
  calculateHrvMetrics,
  createBiometricPipeline,
  lombScarglePowerSpectrum,
} from "./pipeline.js";
import type { BiometricAlert, BiometricSample } from "./types.js";

describe("pipeline HRV", () => {
  it("calcula RMSSD de una señal sinusoidal con frecuencia conocida", () => {
    const amplitudeMs = 200;
    const frequencyHz = 0.05;
    const samplePeriodSeconds = 1;
    const intervals = Array.from({ length: 2_000 }, (_, index) => (
      1_000 + amplitudeMs * Math.sin(2 * Math.PI * frequencyHz * index * samplePeriodSeconds)
    ));
    const expectedRmssd = amplitudeMs * Math.SQRT2 * Math.sin(
      Math.PI * frequencyHz * samplePeriodSeconds,
    );

    const metrics = calculateHrvMetrics(intervals);

    expect(metrics.sampleCount).toBe(2_000);
    expect(metrics.rmssdMs).toBeCloseTo(expectedRmssd, 1);
    expect(metrics.pnn50Percent).toBeGreaterThan(0);
  });

  it("calcula SDNN y pNN50 con la definición muestral", () => {
    const intervals = [800, 810, 900, 805, 795];
    const metrics = calculateHrvMetrics(intervals);
    const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    const expectedSdnn = Math.sqrt(
      intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (intervals.length - 1),
    );
    const changedPairs = intervals.slice(1).filter((value, index) => Math.abs(value - (intervals[index] ?? 0)) > 50).length;

    expect(metrics.sdnnMs).toBeCloseTo(expectedSdnn, 8);
    expect(metrics.pnn50Percent).toBeCloseTo((changedPairs / (intervals.length - 1)) * 100, 8);
  });

  it("localiza el pico Lomb-Scargle de una frecuencia conocida", () => {
    const timestamps = Array.from({ length: 240 }, (_, index) => index * 1_000);
    const values = timestamps.map((timestamp) => (
      1_000
      + 30 * Math.sin(2 * Math.PI * 0.1 * (timestamp / 1_000))
      + 8 * Math.sin(2 * Math.PI * 0.25 * (timestamp / 1_000))
    ));

    const spectrum = lombScarglePowerSpectrum(values, timestamps, {
      frequencies: 512,
      minFrequencyHz: 0.05,
      maxFrequencyHz: 0.35,
    });
    let peakIndex = 0;
    for (let index = 1; index < spectrum.power.length; index += 1) {
      if ((spectrum.power[index] ?? 0) > (spectrum.power[peakIndex] ?? 0)) peakIndex = index;
    }

    expect(spectrum.frequenciesHz[peakIndex]).toBeCloseTo(0.1, 2);
    expect(spectrum.lfHfRatio).toBeGreaterThan(0);
  });

  it("publica HRV solo tras alcanzar el mínimo de muestras", async () => {
    const pipeline = createBiometricPipeline({ minHrvSamples: 4 });

    const first = await pipeline.push({ ts: 1_000, hrvMs: 800, source: "manual" });
    await pipeline.push({ ts: 2_000, hrvMs: 805, source: "manual" });
    await pipeline.push({ ts: 3_000, hrvMs: 810, source: "manual" });
    const fourth = await pipeline.push({ ts: 4_000, hrvMs: 815, source: "manual" });

    expect(first.hrv).toBeUndefined();
    expect(fourth.hrv?.sampleCount).toBe(4);
    expect(fourth.hrv?.rmssdMs).toBeGreaterThan(0);
  });
});

describe("pipeline de estrés y alertas", () => {
  it("deriva el índice de Baevsky y la zona de estrés desde RMSSD", async () => {
    const pipeline = createBiometricPipeline({ minHrvSamples: 4 });

    for (let index = 0; index < 4; index += 1) {
      await pipeline.push({ ts: index * 1_000, hrvMs: 800, source: "manual" });
    }
    const state = pipeline.getCurrent();

    expect(state?.hrv?.rmssdMs).toBe(0);
    expect(state?.baevskyIndex).toBeCloseTo(1, 8);
    expect(state?.stressScore).toBe(100);
    expect(state?.stressZone).toBe("high");
  });

  it("mantiene una tendencia EMA de la puntuación de estrés", async () => {
    const pipeline = createBiometricPipeline({ emaAlpha: 0.5, minHrvSamples: 10 });

    await pipeline.push({ ts: 1_000, stressScore: 100, source: "manual" });
    const state = await pipeline.push({ ts: 2_000, stressScore: 0, source: "manual" });

    expect(state.stressTrend).toBe(50);
    expect(state.stressScore).toBe(0);
  });

  it("detecta, persiste y resuelve una alerta de umbral", async () => {
    const persisted: BiometricAlert[] = [];
    const sink = vi.fn();
    const pipeline = createBiometricPipeline({
      sink,
      alertSink: (alert) => {
        persisted.push(alert);
      },
    });

    const high = await pipeline.push({ ts: 1_000, stressScore: 80, source: "manual" });
    const recovered = await pipeline.push({ ts: 2_000, stressScore: 40, source: "manual" });

    expect(high.alert?.kind).toBe("stress_threshold");
    expect(sink).toHaveBeenCalledTimes(2);
    expect(persisted).toHaveLength(1);
    expect(recovered.alert).toBeUndefined();
    expect(pipeline.alerts[0]?.resolvedAt).toBe(2_000);
  });

  it("mantiene un buffer y un historial deslizantes", async () => {
    const pipeline = createBiometricPipeline({ maxSamples: 2 });

    await pipeline.push({ ts: 1_000, source: "manual" });
    await pipeline.push({ ts: 2_000, source: "manual" });
    await pipeline.push({ ts: 3_000, source: "manual" });

    expect(pipeline.getHistory()).toHaveLength(2);
    expect(pipeline.getHistory(3_000)).toHaveLength(1);
    expect(pipeline.getCurrent()?.sample.ts).toBe(3_000);
  });

  it("rechaza muestras con métricas fuera de rango", async () => {
    const pipeline = createBiometricPipeline();

    await expect(
      pipeline.push({ ts: 1, spo2: 120, source: "manual" }),
    ).rejects.toBeInstanceOf(BiometricsError);
  });
});
