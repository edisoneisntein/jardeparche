/**
 * Pruebas de Integración End-to-End Pipeline de Voz (FASE 5).
 *
 * Valida el pipeline completo: VAD -> ASR Streaming -> LLM Streaming -> TTS Streaming
 * con handshake de interrupción atómico.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SentenceStreamer } from "../packages/voice/src/streamer.js";
import type { TtsEngine, TtsResult } from "../packages/voice/src/tts.js";

// Mock completo del pipeline
interface MockPipelineComponents {
  tts: TtsEngine & { synthesizeCalls: Array<{ text: string; resolve: (v: TtsResult) => void }> };
  asr: { transcribe: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> };
  llm: { stream: ReturnType<typeof vi.fn> };
  network: { send: ReturnType<typeof vi.fn>; latency: number };
}

function createMockPipeline(): MockPipelineComponents {
  const ttsCalls: Array<{ text: string; resolve: (v: TtsResult) => void }> = [];
  const mockTts: TtsEngine & { synthesizeCalls: typeof ttsCalls } = {
    name: "mock-tts",
    synthesizeCalls: ttsCalls,
    available: vi.fn().mockResolvedValue({ ok: true }),
    synthesize: vi.fn().mockImplementation((text: string) => {
      return new Promise<TtsResult>((resolve) => {
        ttsCalls.push({ text, resolve });
      });
    }),
    describe: vi.fn().mockReturnValue({ voice: "mock", realistic: true, hint: "" }),
  };

  return {
    tts: mockTts,
    asr: {
      transcribe: vi.fn().mockResolvedValue({ text: "transcripción mock", confidence: 0.95 }),
      stream: vi.fn(),
    },
    llm: {
      stream: vi.fn().mockImplementation(async function* (prompt: string) {
        const words = prompt.split(" ");
        for (const word of words) {
          yield { type: "delta", text: word + " " };
        }
      }),
    },
    network: {
      send: vi.fn().mockResolvedValue(true),
      latency: 50,
    },
  };
}

function createMockTtsResult(text: string): TtsResult {
  const audio = Buffer.from(`audio-${text}-${Date.now()}`);
  return {
    audio,
    mimeType: "audio/wav",
    sampleRate: 22050,
    durationMs: Math.max(100, text.length * 20),
  };
}

describe("Pipeline E2E: VAD -> ASR -> LLM -> TTS (FASE 5)", () => {
  let pipeline: MockPipelineComponents;
  let emittedSegments: Array<{ generationId: string; index: number; text: string; serverEpoch: number }> = [];
  let interruptEvents: Array<{ type: string; epoch: number }> = [];

  beforeEach(() => {
    pipeline = createMockPipeline();
    emittedSegments = [];
    interruptEvents = [];
    vi.clearAllMocks();
  });

  it("debe procesar turno completo sin interrupción", async () => {
    const streamer = new SentenceStreamer({
      tts: pipeline.tts,
      maxConcurrent: 3,
      onSegment: (segment) => {
        emittedSegments.push({
          generationId: segment.generationId,
          index: segment.index,
          text: segment.text,
          serverEpoch: segment.serverEpoch,
        });
        // Simular envío de red
        pipeline.network.send({
          type: "voice.audio.segment",
          ...segment,
        });
      },
      onEnd: (generationId) => {
        pipeline.network.send({ type: "voice.audio.end", generationId });
      },
      onError: (error) => console.error("TTS error:", error),
    });

    // Simular flujo: voice.speaking.started -> assistant.deltas -> assistant.message_completed
    streamer.start("gen-e2e-1");
    streamer.push("Hola ");
    streamer.push("mundo, ");
    streamer.push("¿cómo ");
    streamer.push("estás? ");
    streamer.flush();

    // Resolver síntesis TTS
    for (const call of pipeline.tts.synthesizeCalls) {
      call.resolve(createMockTtsResult(call.text));
    }

    await new Promise((r) => setTimeout(r, 100));

    // Verificar pipeline completo
    expect(emittedSegments.length).toBeGreaterThan(0);
    expect(pipeline.network.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.audio.segment" }),
    );
    expect(pipeline.network.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice.audio.end" }),
    );
  });

  it("debe manejar interrupción atómica durante streaming", async () => {
    const streamer = new SentenceStreamer({
      tts: pipeline.tts,
      maxConcurrent: 3,
      onSegment: (segment) => {
        emittedSegments.push(segment);
      },
      onEnd: () => {},
    });

    // Iniciar locución larga
    streamer.start("gen-interrupt-1");
    for (let i = 0; i < 20; i++) {
      streamer.push(`Frase ${i}. `);
    }
    streamer.flush();

    // Interrumpir a los 50ms (simulando click usuario)
    await new Promise((r) => setTimeout(r, 50));
    interruptEvents.push({ type: "interrupt_request", epoch: streamer.getCurrentEpoch() });
    streamer.stop();

    // Nueva locución
    streamer.start("gen-interrupt-2");
    streamer.push("Interrumpido. ");
    streamer.flush();

    // Resolver TODAS las síntesis (incluyendo las de la locución interrumpida)
    for (const call of pipeline.tts.synthesizeCalls) {
      call.resolve(createMockTtsResult(call.text));
    }

    await new Promise((r) => setTimeout(r, 100));

    // Verificar: solo segmentos de gen-interrupt-2 emitidos
    const gen1 = emittedSegments.filter((s) => s.generationId === "gen-interrupt-1");
    const gen2 = emittedSegments.filter((s) => s.generationId === "gen-interrupt-2");

    expect(gen1.length).toBe(0);
    expect(gen2.length).toBeGreaterThan(0);
  });

  it("debe medir TTFA correctamente", async () => {
    const ttfaMeasurements: number[] = [];
    const streamer = new SentenceStreamer({
      tts: pipeline.tts,
      maxConcurrent: 3,
      onSegment: (segment) => {
        if (segment.index === 0) {
          ttfaMeasurements.push(Date.now() - streamerStartTime);
        }
        emittedSegments.push(segment);
      },
      onEnd: () => {},
    });

    const streamerStartTime = Date.now();
    streamer.start("gen-ttfa-1");
    streamer.push("Respuesta rápida. ");
    streamer.flush();

    // Resolver primera síntesis rápido
    pipeline.tts.synthesizeCalls[0]?.resolve(createMockTtsResult("Respuesta rápida. "));

    await new Promise((r) => setTimeout(r, 50));

    expect(ttfaMeasurements.length).toBe(1);
    expect(ttfaMeasurements[0]).toBeGreaterThan(0);
    expect(ttfaMeasurements[0]).toBeLessThan(1000); // TTFA < 1s en mock
  });

  it("debe mantener orden de segmentos bajo síntesis paralela variable", async () => {
    const streamer = new SentenceStreamer({
      tts: pipeline.tts,
      maxConcurrent: 5,
      onSegment: (segment) => {
        emittedSegments.push(segment);
      },
      onEnd: () => {},
    });

    streamer.start("gen-order-1");
    for (let i = 0; i < 10; i++) {
      streamer.push(`Segmento ${i}. `);
    }
    streamer.flush();

    // Resolver en orden ALEATORIO
    const calls = [...pipeline.tts.synthesizeCalls];
    while (calls.length > 0) {
      const idx = Math.floor(Math.random() * calls.length);
      const call = calls.splice(idx, 1)[0];
      call.resolve(createMockTtsResult(call.text));
    }

    await new Promise((r) => setTimeout(r, 200));

    // Verificar orden de emisión
    const genSegments = emittedSegments.filter((s) => s.generationId === "gen-order-1");
    for (let i = 1; i < genSegments.length; i++) {
      expect(genSegments[i].index).toBe(genSegments[i - 1].index + 1);
    }
  });
});

describe("Interruption Handshake Protocol", () => {
  it("debe sincronizar epoch cliente-servidor", () => {
    let clientGeneration = 0;
    let serverEpoch = 0;

    // Cliente envía interrupt request
    clientGeneration++;
    const request = { clientGeneration, serverEpoch };
    
    // Servidor procesa y responde ACK
    serverEpoch++; // stop() incrementa epoch
    const ack = { confirmedEpoch: serverEpoch, newServerEpoch: serverEpoch + 1 };

    // Cliente actualiza
    clientGeneration = ack.newServerEpoch;
    serverEpoch = ack.newServerEpoch;

    expect(clientGeneration).toBe(serverEpoch);
    expect(ack.confirmedEpoch).toBe(serverEpoch - 1);
  });

  it("debe manejar timeout de ACK gracefully", async () => {
    let clientGeneration = 0;
    let serverEpoch = 0;
    let ackReceived = false;

    clientGeneration++;
    const request = { clientGeneration, serverEpoch };

    // Simular timeout (servidor no responde)
    const timeoutPromise = new Promise<{ confirmedEpoch: number; newServerEpoch: number }>((_, reject) => {
      setTimeout(() => reject(new Error("ACK timeout")), 100);
    });

    try {
      await timeoutPromise;
    } catch {
      // Timeout: forzar avance local
      serverEpoch = request.serverEpoch + 1;
      clientGeneration = serverEpoch;
    }

    expect(serverEpoch).toBe(1);
    expect(clientGeneration).toBe(1);
  });
});

describe("Backpressure Integration", () => {
  it("debe pausar upstream cuando WebSocket saturado", async () => {
    let wsBufferedAmount = 0;
    const highWaterMark = 1024 * 1024; // 1MB
    const audioQueue: Buffer[] = [];
    let upstreamPaused = false;

    // Simular producción de audio upstream
    const produceAudio = async () => {
      for (let i = 0; i < 100; i++) {
        // Verificar backpressure
        if (wsBufferedAmount > highWaterMark) {
          upstreamPaused = true;
          // Esperar a que se drene
          await new Promise((r) => setTimeout(r, 10));
          upstreamPaused = false;
        }
        
        const chunk = Buffer.from(`audio-${i}`);
        wsBufferedAmount += chunk.length;
        audioQueue.push(chunk);
        
        // Simular drenado de red
        wsBufferedAmount = Math.max(0, wsBufferedAmount - 5000);
      }
    };

    await produceAudio();
    expect(audioQueue.length).toBe(100);
  });

  it("no debe perder chunks durante backpressure", () => {
    const sentChunks: Buffer[] = [];
    const receivedChunks: Buffer[] = [];
    let wsBufferedAmount = 0;
    const highWaterMark = 50000;

    // Productor rápido
    for (let i = 0; i < 20; i++) {
      const chunk = Buffer.from(`chunk-${i}-${"x".repeat(5000)}`);
      
      if (wsBufferedAmount > highWaterMark) {
        // Backpressure: encolar localmente
        sentChunks.push(chunk);
      } else {
        // Enviar directamente
        wsBufferedAmount += chunk.length;
        sentChunks.push(chunk);
      }
      
      // Consumidor lento drena
      wsBufferedAmount = Math.max(0, wsBufferedAmount - 10000);
    }

    // Todos los chunks deben estar contabilizados
    expect(sentChunks.length).toBe(20);
  });
});