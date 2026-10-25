import { describe, expect, it } from "vitest";
import {
  Esp32Bridge,
  Esp32FrameDecoder,
  decodeEsp32Frame,
  encodeEsp32ControlFrame,
  encodeEsp32EcgFrame,
  encodeEsp32VitalsFrame,
} from "./esp32.js";
import { BiometricsError } from "../errors.js";
import type {
  Esp32ByteStream,
  Esp32Frame,
  Esp32Transport,
  BiometricSample,
} from "../types.js";

class FakeEsp32Stream implements Esp32ByteStream {
  readonly sent: Uint8Array[] = [];
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();

  async send(data: Uint8Array): Promise<void> {
    this.sent.push(new Uint8Array(data));
    const frames = new Esp32FrameDecoder().push(data);
    for (const frame of frames) {
      if (frame.type === "ping") {
        this.emit(encodeEsp32ControlFrame("pong", frame.sequence + 1, Date.now()));
      }
    }
  }

  async close(): Promise<void> {
    for (const listener of this.closeListeners) listener();
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emit(data: Uint8Array): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakeEsp32Transport implements Esp32Transport {
  readonly stream = new FakeEsp32Stream();

  async connect(): Promise<Esp32ByteStream> {
    return this.stream;
  }
}

describe("ESP32 protocol", () => {
  it("codifica y decodifica una trama de constantes vitales", () => {
    const encoded = encodeEsp32VitalsFrame({
      type: "vitals",
      sequence: 7,
      timestampMs: 1_700_000_000_123,
      heartRate: 64,
      hrvMs: 38,
    });

    const decoded = decodeEsp32Frame(encoded);

    expect(decoded).toEqual({
      type: "vitals",
      sequence: 7,
      timestampMs: 1_700_000_000_123,
      heartRate: 64,
      hrvMs: 38,
    });
  });

  it("codifica y decodifica ECG PCM con signo", () => {
    const encoded = encodeEsp32EcgFrame({
      type: "ecg",
      sequence: 8,
      timestampMs: 1_700_000_000_123,
      sampleRateHz: 250,
      samples: Int16Array.from([0, -1_000, 2_000, -32_768, 32_767]),
    });

    const decoded = decodeEsp32Frame(encoded);

    expect(decoded.type).toBe("ecg");
    if (decoded.type !== "ecg") throw new Error("La trama no fue de tipo ECG.");
    expect(decoded.sampleRateHz).toBe(250);
    expect(Array.from(decoded.samples)).toEqual([0, -1_000, 2_000, -32_768, 32_767]);
  });

  it("decodifica tramas parciales y múltiples del mismo stream", () => {
    const first = encodeEsp32VitalsFrame({
      type: "vitals",
      sequence: 1,
      timestampMs: 1_000,
      heartRate: 60,
      hrvMs: 30,
    });
    const second = encodeEsp32ControlFrame("ping", 2, 2_000);
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first, 0);
    combined.set(second, first.length);
    const decoder = new Esp32FrameDecoder();

    expect(decoder.push(combined.subarray(0, 11))).toEqual([]);
    const frames: Esp32Frame[] = decoder.push(combined.subarray(11));

    expect(frames.map((frame) => frame.type)).toEqual(["vitals", "ping"]);
  });

  it("rechaza una trama cuyo CRC no coincide", () => {
    const encoded = encodeEsp32VitalsFrame({
      type: "vitals",
      sequence: 1,
      timestampMs: 1_000,
      heartRate: 60,
      hrvMs: 30,
    });
    encoded[20] = (encoded[20] ?? 0) ^ 0xff;

    expect(() => decodeEsp32Frame(encoded)).toThrow(BiometricsError);
  });

  it("completa el handshake y entrega muestras ESP32", async () => {
    const transport = new FakeEsp32Transport();
    const samples: BiometricSample[] = [];
    const bridge = new Esp32Bridge({
      mode: "tcp",
      host: "127.0.0.1",
      port: 8_266,
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [8_266],
      timeoutMs: 1_000,
      transport,
      onSample: (sample) => {
        samples.push(sample);
      },
    });

    await bridge.start();
    transport.stream.emit(encodeEsp32VitalsFrame({
      type: "vitals",
      sequence: 3,
      timestampMs: 5_000,
      heartRate: 72,
      hrvMs: 41,
    }));
    await Promise.resolve();

    expect(bridge.connected).toBe(true);
    expect(samples[0]).toEqual({
      ts: 5_000,
      heartRate: 72,
      hrvMs: 41,
      source: "esp32",
    });
    await bridge.stop();
  });

  it("impide conectar con hosts o puertos fuera de la allowlist", () => {
    expect(() => new Esp32Bridge({
      mode: "tcp",
      host: "192.168.1.20",
      port: 8_266,
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [8_266],
    })).toThrow(BiometricsError);

    expect(() => new Esp32Bridge({
      mode: "tcp",
      host: "127.0.0.1",
      port: 9_999,
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [8_266],
    })).toThrow(BiometricsError);
  });
});
