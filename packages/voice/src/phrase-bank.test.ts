import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PhraseBank, PhraseBankEngine, phraseKey, similarity } from "./phrase-bank.js";
import type { TtsEngine, TtsResult } from "./tts.js";

function fakeTts(): { tts: TtsEngine; llamadas: string[] } {
  const llamadas: string[] = [];
  const tts: TtsEngine = {
    name: "fake",
    available: async () => ({ ok: true }),
    synthesize: async (text: string): Promise<TtsResult> => {
      llamadas.push(text);
      return { audio: Buffer.from(`audio:${text}`), mimeType: "audio/wav", sampleRate: 24_000, durationMs: 1000 };
    },
  };
  return { tts, llamadas };
}

describe("clave de frase", () => {
  it("ignora mayúsculas y puntuación final", () => {
    expect(phraseKey("Entendido.")).toBe("entendido");
    expect(phraseKey("entendido")).toBe("entendido");
    expect(phraseKey("¡Entendido!")).toBe("entendido");
  });
});

describe("banco de frases", () => {
  it("graba una frase y la devuelve al instante", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-bank-"));
    try {
      const { tts, llamadas } = fakeTts();
      const bank = new PhraseBank({ directory: dir });
      await bank.load();
      await bank.render("Entendido.", tts);
      expect(llamadas).toEqual(["Entendido."]);

      const hit = await bank.find("entendido");
      expect(hit).not.toBeNull();
      expect(hit?.audio.toString()).toBe("audio:Entendido.");
      expect(hit?.entry.durationMs).toBe(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no encuentra lo que no está grabado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-bank-"));
    try {
      const { tts } = fakeTts();
      const bank = new PhraseBank({ directory: dir });
      await bank.load();
      await bank.render("Entendido.", tts);
      expect(await bank.find("Buenos días.")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("el motor con banco sirve del banco y delega lo que no está", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-bank-"));
    try {
      const { tts, llamadas } = fakeTts();
      const bank = new PhraseBank({ directory: dir });
      await bank.load();
      await bank.render("Entendido.", tts);
      const engine = new PhraseBankEngine(bank, tts);

      const desdeBanco = await engine.synthesize("Entendido.");
      expect(desdeBanco.audio.toString()).toBe("audio:Entendido.");
      expect(llamadas.length).toBe(1);

      const sintetizado = await engine.synthesize("Otra cosa.");
      expect(sintetizado.audio.toString()).toBe("audio:Otra cosa.");
      expect(llamadas.length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("similitud", () => {
  it("reconoce frases parecidas", () => {
    expect(similarity("entendido", "entendido")).toBe(1);
    expect(similarity("entendido", "entendi")).toBeGreaterThan(0.5);
    expect(similarity("entendido", "buenos dias")).toBeLessThan(0.3);
  });
});
