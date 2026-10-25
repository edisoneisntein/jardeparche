import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CameraService, isInternalCameraHost, validateCameraUrl } from "./cameras.js";
import { DomoticsError } from "./errors.js";
import type { CameraProcess, CameraSpawner } from "./types.js";

class FakeCameraProcess implements CameraProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined = undefined;
  killedWith?: NodeJS.Signals | number;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  once(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    return true;
  }

  close(code = 0): void {
    for (const listener of this.listeners.get("close") ?? []) listener(code, null);
  }

  error(error: Error): void {
    for (const listener of this.listeners.get("error") ?? []) listener(error);
  }
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("cámaras", () => {
  it("captura una imagen y devuelve dimensiones reales", async () => {
    const process = new FakeCameraProcess();
    const spawner: CameraSpawner = () => {
      setImmediate(() => {
        process.stdout.write(pngBytes(640, 480));
        process.close(0);
      });
      return process;
    };
    const service = new CameraService({ cameras: [{ id: "front", url: "https://camera.example.test/snapshot" }], spawner });

    const snapshot = await service.snapshot("front");
    expect(snapshot.cameraId).toBe("front");
    expect(snapshot.width).toBe(640);
    expect(snapshot.height).toBe(480);
    expect(snapshot.imageBase64).toBe(pngBytes(640, 480).toString("base64"));
    expect(new Date(snapshot.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("rechaza esquemas que no sean HTTP(S) y destinos internos", () => {
    expect(() => validateCameraUrl("file:///etc/passwd")).toThrow(DomoticsError);
    expect(() => validateCameraUrl("http://localhost/stream")).toThrow(/destino interno/);
    expect(() => validateCameraUrl("http://192.168.1.20/stream")).toThrow(/destino interno/);
    expect(() => validateCameraUrl("rtsp://camera.example.test/stream")).toThrow(/HTTP\(S\)/);
    expect(validateCameraUrl("rtsp://camera.example.test/stream", { allowRtsp: true }).protocol).toBe("rtsp:");
  });

  it("detecta loopback, IPv4 privada y nombres locales", () => {
    expect(isInternalCameraHost("127.0.0.1")).toBe(true);
    expect(isInternalCameraHost("10.0.0.1")).toBe(true);
    expect(isInternalCameraHost("::1")).toBe(true);
    expect(isInternalCameraHost("camera.local")).toBe(true);
    expect(isInternalCameraHost("camera.example.test")).toBe(false);
  });

  it("delega el análisis en el callback de visión", async () => {
    const process = new FakeCameraProcess();
    const spawner: CameraSpawner = () => {
      setImmediate(() => {
        process.stdout.write(pngBytes(10, 10));
        process.close(0);
      });
      return process;
    };
    const service = new CameraService(
      { cameras: [{ id: "front", url: "https://camera.example.test/snapshot" }], spawner },
      async () => ({ text: "puerta abierta", confidence: 0.9 }),
    );

    const snapshot = await service.snapshot("front", { analyze: true });
    expect(snapshot.analysis?.text).toBe("puerta abierta");
  });

  it("usa argumentos de ffmpeg allowlisted y no una shell", async () => {
    let args: string[] = [];
    const process = new FakeCameraProcess();
    const spawner: CameraSpawner = (_command, receivedArgs) => {
      args = receivedArgs;
      setImmediate(() => {
        process.stdout.write(pngBytes(320, 240));
        process.close(0);
      });
      return process;
    };
    const service = new CameraService({ cameras: [{ id: "front", url: "https://camera.example.test/snapshot" }], spawner });
    await service.snapshot("front");

    expect(args).toContain("-nostdin");
    expect(args).toContain("-i");
    expect(args).toContain("-f");
    expect(args).not.toContain("shell");
  });

  it("termina el proceso cuando se agota el timeout", async () => {
    const process = new FakeCameraProcess();
    const spawner: CameraSpawner = () => process;
    const service = new CameraService({
      cameras: [{ id: "front", url: "https://camera.example.test/snapshot" }],
      spawner,
      timeoutMs: 5,
    });

    await expect(service.snapshot("front")).rejects.toMatchObject({ kind: "timeout" });
    expect(process.killedWith).toBe("SIGKILL");
  });

  it("propaga la cancelación de una captura", async () => {
    const process = new FakeCameraProcess();
    const spawner: CameraSpawner = () => process;
    const service = new CameraService({ cameras: [{ id: "front", url: "https://camera.example.test/snapshot" }], spawner });
    const controller = new AbortController();
    const pending = service.snapshot("front", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(process.killedWith).toBe("SIGKILL");
  });
});
