import { describe, expect, it } from "vitest";
import { BiometricsError } from "./errors.js";
import {
  ReferenceVoiceprintEmbedder,
  cosineSimilarity,
  createVoiceprint,
} from "./voiceprint.js";
import type { VoiceprintEmbedder, VoiceprintSample } from "./types.js";

class FixedEmbedder implements VoiceprintEmbedder {
  constructor(private readonly vector: readonly number[]) {}

  embed(_sample: VoiceprintSample): readonly number[] {
    return this.vector;
  }
}

function vocalSample(seed: number): VoiceprintSample {
  const pcm = new Float32Array(320);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = Math.sin((2 * Math.PI * 180 * index) / 16_000) * (0.3 + seed * 0.01);
  }
  return { pcm, sampleRate: 16_000 };
}

describe("voiceprint", () => {
  it("verifica correctamente el mismo embedding", async () => {
    const manager = createVoiceprint({ embedder: new FixedEmbedder([1, 0, 0]) });

    await manager.enroll("user-1", [vocalSample(1)]);
    const result = await manager.verify("user-1", vocalSample(2));

    expect(result.verified).toBe(true);
    expect(result.score).toBeCloseTo(1, 10);
    expect(result.threshold).toBe(0.85);
  });

  it("rechaza un embedding distinto", async () => {
    let call = 0;
    const manager = createVoiceprint({
      embedder: {
        embed: () => (call++ === 0 ? [1, 0, 0] : [0, 1, 0]),
      },
      threshold: 0.85,
    });

    await manager.enroll("user-1", [vocalSample(1)]);
    const result = await manager.verify("user-1", vocalSample(2));

    expect(result.verified).toBe(false);
    expect(result.score).toBeCloseTo(0, 10);
  });

  it("rechaza una persona con vector ortogonal", async () => {
    let call = 0;
    const embedder: VoiceprintEmbedder = {
      embed: () => (call++ === 0 ? [1, 0] : [0, 1]),
    };
    const manager = createVoiceprint({ embedder });

    await manager.enroll("user-1", [vocalSample(1)]);
    const result = await manager.verify("user-1", vocalSample(2));

    expect(result.verified).toBe(false);
    expect(result.score).toBeCloseTo(0, 10);
  });

  it("promedia embeddings normalizados durante el enrollment", async () => {
    const embeddings: readonly number[][] = [[1, 0], [0, 1]];
    let call = 0;
    const manager = createVoiceprint({
      embedder: { embed: () => embeddings[call++] ?? [0, 0] },
    });

    const voiceprint = await manager.enroll("user-1", [vocalSample(1), vocalSample(2)]);

    expect(voiceprint.embedding[0]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(voiceprint.embedding[1]).toBeCloseTo(Math.SQRT1_2, 10);
    expect(Math.hypot(...voiceprint.embedding)).toBeCloseTo(1, 10);
  });

  it("devuelve una decisión negativa para una persona no registrada", async () => {
    const manager = createVoiceprint({ embedder: new FixedEmbedder([1, 0]) });

    const result = await manager.verify("unknown", vocalSample(1));

    expect(result).toEqual({ verified: false, score: 0, threshold: 0.85 });
  });

  it("ofrece un embedder de referencia determinista", () => {
    const embedder = new ReferenceVoiceprintEmbedder();
    const sample = vocalSample(3);

    const first = embedder.embed(sample);
    const second = embedder.embed(sample);

    expect(first).toEqual(second);
    expect(first).toHaveLength(64);
    expect(Math.hypot(...first)).toBeCloseTo(1, 10);
  });

  it("rechaza embeddings vacíos o no finitos", async () => {
    const manager = createVoiceprint({ embedder: new FixedEmbedder([0, 0]) });

    await expect(manager.enroll("user-1", [vocalSample(1)])).rejects.toBeInstanceOf(BiometricsError);
  });

  it("calcula similitud coseno y rechaza dimensiones incompatibles", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(BiometricsError);
  });
});
