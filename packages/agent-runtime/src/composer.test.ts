import { describe, expect, it } from "vitest";
import { ResponseComposer } from "./composer.js";

/**
 * Caracterización del COMPOSITOR de respuestas.
 *
 * Dos garantías incompatibles conviven aquí:
 *   1. La negativa del modelo («no dispongo de una herramienta…») NO puede
 *      llegar al usuario ni a su voz.
 *   2. El texto NO puede esperar a que el modelo acumule 90 caracteres: si el
 *      modelo va lento, el usuario espera en silencio.
 *
 * El compositor resuelve el conflicto con un techo de tiempo.
 */
describe("ResponseComposer", () => {
  it("retiene la negativa y no la emite", () => {
    const emitted: string[] = [];
    const composer = new ResponseComposer({ onDelta: (text) => emitted.push(text) });
    composer.accept("No dispongo de una herramienta que me ");
    composer.accept("permita buscar eso ahora mismo.");
    composer.release();
    expect(emitted).toEqual([]);
  });

  it("suelta el texto en cuanto deja de ser una negativa", () => {
    const emitted: string[] = [];
    const composer = new ResponseComposer({ onDelta: (text) => emitted.push(text) });
    composer.accept("Un índice vectorial guarda ");
    composer.accept("embeddings y permite buscar por significado.");
    composer.release();
    expect(emitted.join("")).toMatch(/índice vectorial/i);
  });

  it("el techo de tiempo impide esperar indefinidamente a los 90 caracteres", () => {
    const emitted: string[] = [];
    let now = 0;
    const composer = new ResponseComposer({
      onDelta: (text) => emitted.push(text),
      now: () => now,
      holdMs: 150,
    });
    // El modelo emite despacio: dos palabras en 200 ms.
    composer.accept("Hola ");
    expect(emitted).toEqual([]);
    now = 200;
    composer.accept("mundo");
    // Sin el techo de tiempo, el texto seguiría retenido (11 < 90). Con el
    // techo, sale ya: la latencia perceptual no depende del ritmo del modelo.
    expect(emitted.join("")).toBe("Hola mundo");
  });

  it("sin techo de tiempo, el texto sigue retenido hasta el final del turno", () => {
    const emitted: string[] = [];
    let now = 0;
    const composer = new ResponseComposer({
      onDelta: (text) => emitted.push(text),
      now: () => now,
      holdMs: 10_000,
    });
    composer.accept("Hola ");
    now = 200;
    composer.accept("mundo");
    expect(emitted).toEqual([]);
    composer.release();
    expect(emitted.join("")).toBe("Hola mundo");
  });

  it("no suelta un fragmento que empieza como una negativa aunque se agote el tiempo", () => {
    const emitted: string[] = [];
    let now = 0;
    const composer = new ResponseComposer({
      onDelta: (text) => emitted.push(text),
      now: () => now,
      holdMs: 10,
    });
    composer.accept("No puedo");
    now = 1_000;
    composer.accept(" hacerlo ahora.");
    expect(emitted).toEqual([]);
  });

  it("una vez liberado, cada fragmento pasa directo", () => {
    const emitted: string[] = [];
    const composer = new ResponseComposer({ onDelta: (text) => emitted.push(text) });
    composer.accept("Primera parte suficientemente larga para liberar el buffer de texto. ");
    composer.release();
    composer.accept("Segunda");
    expect(emitted.join("")).toMatch(/Primera parte.*Segunda/s);
  });

  it("el primer fragmento liberado dispara el aviso de locución una sola vez", () => {
    let releases = 0;
    const composer = new ResponseComposer({
      onDelta: () => {},
      onFirstRelease: () => {
        releases += 1;
      },
    });
    composer.accept("Texto lo bastante largo como para liberar el compositor de inmediato. ");
    composer.release();
    expect(releases).toBe(1);
  });
});
