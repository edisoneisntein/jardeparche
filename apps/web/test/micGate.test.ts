import { describe, expect, it } from "vitest";
import { evaluateMicGate, localEquivalentUrl, type MicEnvironment } from "../src/lib/micGate";

const READY: MicEnvironment = {
  isSecureContext: true,
  hasMediaDevices: true,
  hasSpeechRecognition: true,
  permission: "granted",
  origin: "http://localhost:5173",
};

describe("localEquivalentUrl", () => {
  it("mapea una IP de red local al mismo puerto en localhost", () => {
    expect(localEquivalentUrl("http://192.168.1.8:5173")).toBe("http://localhost:5173/");
    expect(localEquivalentUrl("http://10.0.0.4:5173")).toBe("http://localhost:5173/");
  });

  it("conserva ruta, query y hash", () => {
    expect(localEquivalentUrl("http://192.168.1.8:5173/hud?x=1#top")).toBe("http://localhost:5173/hud?x=1#top");
  });

  it("devuelve null para orígenes ya confiables o inválidos", () => {
    expect(localEquivalentUrl("http://localhost:5173")).toBeNull();
    expect(localEquivalentUrl("http://127.0.0.1:5173")).toBeNull();
    expect(localEquivalentUrl("no-es-una-url")).toBeNull();
    expect(localEquivalentUrl("ftp://192.168.1.8")).toBeNull();
  });
});

describe("evaluateMicGate", () => {
  it("deja el micrófono operativo en un contexto seguro", () => {
    const gate = evaluateMicGate(READY);
    expect(gate.state).toBe("ready");
    expect(gate.remedy).toBe("none");
  });

  it("detecta el origen no seguro y ofrece el equivalente local", () => {
    const gate = evaluateMicGate({
      ...READY,
      isSecureContext: false,
      hasMediaDevices: false,
      origin: "http://192.168.1.8:5173",
    });
    expect(gate.state).toBe("insecure-origin");
    expect(gate.remedy).toBe("use-localhost");
    expect(gate.localUrl).toBe("http://localhost:5173/");
    expect(gate.guidance).toContain("localhost");
  });

  it("distingue el bloqueo persistente del navegador", () => {
    const gate = evaluateMicGate({ ...READY, permission: "denied" });
    expect(gate.state).toBe("permission-blocked");
    expect(gate.remedy).toBe("site-settings");
    expect(gate.localUrl).toBeNull();
  });

  it("detecta la ausencia de la Web Speech API", () => {
    const gate = evaluateMicGate({ ...READY, hasSpeechRecognition: false });
    expect(gate.state).toBe("no-speech-api");
    expect(gate.remedy).toBe("none");
  });

  it("no confunde un permiso por asking con un bloqueo", () => {
    const gate = evaluateMicGate({ ...READY, permission: "prompt" });
    expect(gate.state).toBe("ready");
  });
});
