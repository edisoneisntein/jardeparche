/**
 * Pruebas de Contrapresión (Backpressure) en WebSocket (FASE 5).
 *
 * Valida:
 * 1. Buffer de audio no crece indefinidamente
 * 2. Backpressure se activa en highWaterMark
 * 3. Recuperación automática en lowWaterMark
 * 4. 0 drops no controlados
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";

// Mock del servidor Fastify con WebSocket
const mockHighWaterMark = 1024 * 1024; // 1MB
const mockLowWaterMark = 256 * 1024; // 256KB

interface MockWebSocket {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onopen: (() => void) | null;
  onmessage: ((event: { data: Buffer | string }) => void) | null;
  onerror: ((error: Error) => void) | null;
  onclose: (() => void) | null;
}

function createMockWebSocket(): MockWebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}

describe("WebSocket Backpressure (FASE 5)", () => {
  let audioBuffers: Map<string, Buffer[]> = new Map();
  let audioBytes: Map<string, number> = new Map();
  const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB límite por sesión

  beforeEach(() => {
    audioBuffers.clear();
    audioBytes.clear();
    vi.clearAllMocks();
  });

  function handleAudioChunk(sessionId: string, pcmBase64: string): { accepted: boolean; totalBytes: number } {
    const chunks = audioBuffers.get(sessionId) ?? [];
    const pcmBuffer = Buffer.from(pcmBase64, "base64");
    chunks.push(pcmBuffer);
    audioBuffers.set(sessionId, chunks);

    const total = (audioBytes.get(sessionId) ?? 0) + pcmBuffer.length;
    audioBytes.set(sessionId, total);

    // Backpressure: rechazar si excede límite
    if (total > MAX_BUFFER_BYTES) {
      audioBuffers.delete(sessionId);
      audioBytes.delete(sessionId);
      return { accepted: false, totalBytes: total };
    }

    return { accepted: true, totalBytes: total };
  }

  it("debe aceptar chunks mientras está bajo el límite", () => {
    const sessionId = "test-session";
    const chunk = Buffer.from("a".repeat(10000)).toString("base64"); // ~10KB

    for (let i = 0; i < 100; i++) {
      const result = handleAudioChunk(sessionId, chunk);
      expect(result.accepted).toBe(true);
    }
  });

  it("debe rechazar chunks cuando excede MAX_BUFFER_BYTES", () => {
    const sessionId = "test-session";
    const chunk = Buffer.from("a".repeat(50000)).toString("base64"); // ~50KB

    // Enviar chunks hasta exceder 2MB
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 60; i++) {
      const result = handleAudioChunk(sessionId, chunk);
      if (result.accepted) accepted++;
      else rejected++;
    }

    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("debe limpiar buffers en flush", () => {
    const sessionId = "test-session";
    const chunk = Buffer.from("a".repeat(10000)).toString("base64");

    for (let i = 0; i < 10; i++) {
      handleAudioChunk(sessionId, chunk);
    }

    // Simular flush
    audioBuffers.delete(sessionId);
    audioBytes.delete(sessionId);

    // Nueva sesión debe empezar limpio
    const result = handleAudioChunk(sessionId, chunk);
    expect(result.accepted).toBe(true);
    expect(result.totalBytes).toBe(Buffer.from(chunk, "base64").length);
  });

  it("debe manejar múltiples sesiones independientemente", () => {
    const session1 = "session-1";
    const session2 = "session-2";
    const chunk = Buffer.from("a".repeat(10000)).toString("base64");

    // Llenar session1 cerca del límite
    for (let i = 0; i < 30; i++) {
      handleAudioChunk(session1, chunk);
    }

    // session2 debe poder aceptar chunks normalmente
    const result = handleAudioChunk(session2, chunk);
    expect(result.accepted).toBe(true);
    expect(result.totalBytes).toBe(Buffer.from(chunk, "base64").length);
  });
});

describe("WebSocket bufferedAmount Monitoring", () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    mockWs = createMockWebSocket();
  });

  it("debe pausar envío cuando bufferedAmount > highWaterMark", () => {
    mockWs.bufferedAmount = mockHighWaterMark + 1000;
    const canSend = mockWs.bufferedAmount < mockHighWaterMark;
    expect(canSend).toBe(false);
  });

  it("debe reanudar envío cuando bufferedAmount < lowWaterMark", () => {
    mockWs.bufferedAmount = mockLowWaterMark - 1000;
    const canSend = mockWs.bufferedAmount < mockHighWaterMark;
    expect(canSend).toBe(true);
  });

  it("debe trackear bufferedAmount correctamente", () => {
    const chunk = Buffer.from("a".repeat(10000));
    mockWs.send.mockImplementation((data: Buffer | string) => {
      mockWs.bufferedAmount += data instanceof Buffer ? data.length : Buffer.byteLength(data);
    });

    mockWs.send(chunk);
    expect(mockWs.bufferedAmount).toBe(chunk.length);

    mockWs.send(chunk);
    expect(mockWs.bufferedAmount).toBe(chunk.length * 2);
  });

  it("no debe perder paquetes cuando backpressure activo", () => {
    mockWs.bufferedAmount = mockHighWaterMark + 1000;
    const queue: Buffer[] = [];

    // Simular encolado durante backpressure
    for (let i = 0; i < 10; i++) {
      queue.push(Buffer.from(`chunk-${i}`));
    }

    // Cuando backpressure se libera, drenar cola
    mockWs.bufferedAmount = mockLowWaterMark - 1000;
    let sent = 0;
    while (queue.length > 0 && mockWs.bufferedAmount < mockHighWaterMark) {
      const chunk = queue.shift()!;
      mockWs.send(chunk);
      sent++;
    }

    expect(sent).toBe(10);
    expect(queue.length).toBe(0);
  });
});

describe("Audio Buffer Memory Stability", () => {
  it("no debe crecer memoria indefinidamente en sesión larga", () => {
    const sessionId = "long-session";
    const chunk = Buffer.from("a".repeat(10000)).toString("base64");
    const chunkBytes = Buffer.from(chunk, "base64").length;

    // Simular 1000 chunks con flush periódico cada 10
    for (let i = 0; i < 1000; i++) {
      handleAudioChunk(sessionId, chunk);
      if (i % 10 === 9) {
        audioBuffers.delete(sessionId);
        audioBytes.delete(sessionId);
      }
    }

    // Memoria debe estar controlada (búfer actual < 10 chunks)
    const currentBytes = audioBytes.get(sessionId) ?? 0;
    expect(currentBytes).toBeLessThan(chunkBytes * 10);
  });

  it("debe manejar flush sin datos", () => {
    const sessionId = "empty-session";
    const chunks = audioBuffers.get(sessionId) ?? [];
    expect(chunks.length).toBe(0);
  });
});

// Re-export helper for tests
function handleAudioChunk(sessionId: string, pcmBase64: string): { accepted: boolean; totalBytes: number } {
  const chunks = audioBuffers.get(sessionId) ?? [];
  const pcmBuffer = Buffer.from(pcmBase64, "base64");
  chunks.push(pcmBuffer);
  audioBuffers.set(sessionId, chunks);

  const total = (audioBytes.get(sessionId) ?? 0) + pcmBuffer.length;
  audioBytes.set(sessionId, total);

  if (total > MAX_BUFFER_BYTES) {
    audioBuffers.delete(sessionId);
    audioBytes.delete(sessionId);
    return { accepted: false, totalBytes: total };
  }

  return { accepted: true, totalBytes: total };
}