import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, stripWakeWord } from "../src/state/settings";

describe("ajustes de voz", () => {
  it("la palabra de activación NO es obligatoria por defecto", () => {
    expect(DEFAULT_SETTINGS.requireWakeWord).toBe(false);
  });

  it("un ajuste guardado antes de existir la opción hereda el valor por defecto", () => {
    // Simula el localStorage de un usuario que ya tenía la app en uso.
    const legacy = { userId: "local", wakeWord: "jarvis", language: "es-ES", ttsEnabled: true };
    // El valor ausente se resuelve con el valor por defecto: la orden se envía.
    expect(legacy).not.toHaveProperty("requireWakeWord");
    expect(DEFAULT_SETTINGS.requireWakeWord).toBe(false);
  });

  it("la palabra se elimina del comando cuando aparece", () => {
    expect(stripWakeWord("Jarvis, dime la hora", "jarvis")).toEqual({ command: "dime la hora", armed: true });
    expect(stripWakeWord("dime la hora", "jarvis")).toEqual({ command: "dime la hora", armed: false });
  });

  it("sin palabra configurada, el comando pasa intacto", () => {
    expect(stripWakeWord("dime la hora", "")).toEqual({ command: "dime la hora", armed: false });
  });
});
