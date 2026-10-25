import { describe, expect, it } from "vitest";
import { FALLBACK_PATTERNS } from "./runtime.js";

/**
 * El runtime reintenta con el catálogo completo de tools cuando el modelo dice
 * que no puede hacer algo. Los patrones deben reconocer la redacción real que
 * produce el modelo; si no, el agente se queda sin herramienta para siempre.
 */
const triggers = (text: string): boolean => FALLBACK_PATTERNS.some((pattern) => pattern.test(text));

describe("patrones de reintento con catálogo completo", () => {
  it("reconoce la redacción real observada en producción", () => {
    const real = "no dispongo de una herramienta que me permita consultar la agenda deportiva";
    expect(triggers(real)).toBe(true);
  });

  it("reconoce variantes equivalentes", () => {
    for (const frase of [
      "No tengo herramientas para buscar eso",
      "no hay ninguna herramienta de búsqueda disponible",
      "No dispongo de acceso a esa información",
      "no puedo buscarlo con las herramientas disponibles",
    ]) {
      expect(triggers(frase)).toBe(true);
    }
  });

  it("no dispara con respuestas normales", () => {
    for (const frase of [
      "La capital de Francia es París.",
      "El próximo partido es el 13 de noviembre en Cali.",
      "No puedo permitirlo sin más contexto.",
    ]) {
      expect(triggers(frase)).toBe(false);
    }
  });

  it("reconoce la negativa con «no tengo disponible la herramienta» (caso real)", () => {
    // Frase literal del usuario (2026-10-20). Antes de este patrón el modelo
    // se negaba a buscar y el reintento con el catálogo completo no se
    // disparaba, así que se quedaba sin poder consultar la web.
    const real =
      "(*) no tengo disponible la herramienta `web_search`. Solo puedo usar las herramientas que el sistema me ha otorgado (hora, datos del sistema, cálculos, memoria, archivos, etc.).";
    expect(triggers(real)).toBe(true);
  });

  it("reconoce las variantes de «no disponible» y de catálogo incompleto", () => {
    for (const frase of [
      "no tengo disponible la herramienta de búsqueda web",
      "no está disponible la herramienta web_search",
      "no hay disponible una herramienta para buscar en internet",
      "Solo puedo usar las herramientas que el sistema me ha otorgado",
    ]) {
      expect(triggers(frase)).toBe(true);
    }
  });

  it("reconoce la negativa real del 2026-10-23: «no puedo activar web_search»", () => {
    // Frase literal del usuario. El catálogo SÍ tenía web_search: el modelo
    // lo deactivate por su cuenta («las herramientas solo están disponibles si
    // el entorno las ha concedido»). Sin este patrón el reintento no se
    // disparaba y el usuario se quedaba sin búsqueda web.
    const real =
      "No puedo activar `web_search`. Según las directrices del sistema, las herramientas solo están disponibles si el entorno las ha concedido, y en esta sesión no están habilitadas.";
    expect(triggers(real)).toBe(true);
  });

  it("reconoce el plural y las variantes de «habilitadas»", () => {
    for (const frase of [
      "en esta sesión no están habilitadas",
      "las herramientas no están activadas",
      "no me dejan usar la herramienta de búsqueda",
      "no se me permite invocar web_search",
    ]) {
      expect(triggers(frase)).toBe(true);
    }
  });
});
