import { describe, expect, it } from "vitest";
import { FakeProvider } from "@jarvis/ai-provider";
import { PerceptionError, PerceptionService } from "../src/perception-service.js";

const provider = new FakeProvider([{ content: "una taza sobre la mesa" }]);
const service = new PerceptionService(provider, {
  visionModel: "fake-vision",
  maxBytes: 1024 * 1024,
  enabled: true,
});

const validPng = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;

describe("PerceptionService", () => {
  it("parses a valid image data URL and reports byte size", () => {
    const payload = service.parseDataUrl(validPng);
    expect(payload.mime).toBe("image/png");
    expect(payload.bytes).toBeGreaterThan(0);
  });

  it("rejects non-image payloads", () => {
    expect(() => service.parseDataUrl("data:text/plain;base64,aGk=")).toThrow(PerceptionError);
  });

  it("rejects unsupported mime types", () => {
    expect(() => service.parseDataUrl("data:image/bmp;base64,AAAA")).toThrow(/Formato no soportado/);
  });

  it("rejects oversized images", () => {
    const small = new PerceptionService(provider, { visionModel: "fake", maxBytes: 4, enabled: true });
    expect(() => small.parseDataUrl(validPng)).toThrow(/supera el límite/);
  });

  it("refuses to analyze when disabled", () => {
    const disabled = new PerceptionService(provider, { visionModel: "fake", maxBytes: 1000, enabled: false });
    expect(() => disabled.parseDataUrl(validPng)).toThrow(/deshabilitado/);
  });

  it("analyzes a still image via the vision model", async () => {
    const result = await service.analyze(service.parseDataUrl(validPng));
    expect(result.text).toBe("una taza sobre la mesa");
    expect(result.oneShot).toBe(true);
  });

  it("tracks camera state per session", () => {
    service.setCameraState("s1", true);
    expect(service.isCameraActive("s1")).toBe(true);
    service.setCameraState("s1", false);
    expect(service.isCameraActive("s1")).toBe(false);
  });
});
