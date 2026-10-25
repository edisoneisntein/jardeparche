import { describe, expect, it } from "vitest";
import { createComputerUseTool } from "./builtin/computer-use.js";

/**
 * El modelo escribe los argumentos de las tools a su aire: los números llegan
 * como texto ("500" en vez de 500) y la acción con un alias ("click" en vez de
 * "mouse_click"). Si el esquema es estricto, una llamada perfectamente válida
 * se convierte en un error y la acción nunca se ejecuta.
 */
const tool = createComputerUseTool({ computerUseDriver: "infra/computer-use/driver.py" });
const parse = (raw: unknown) => tool.parse(raw);

describe("computer.use · argumentos tolerantes", () => {
  it("acepta coordenadas numéricas", () => {
    expect(parse({ action: "move_cursor", coords: { x: 500, y: 250 } })).toMatchObject({
      action: "move_cursor",
      coords: { x: 500, y: 250 },
    });
  });

  it("convierte coordenadas que llegan como texto", () => {
    expect(parse({ action: "move_cursor", coords: { x: "500", y: "250" } })).toMatchObject({
      coords: { x: 500, y: 250 },
    });
  });

  it("acepta coordenadas en formato 'x,y'", () => {
    expect(parse({ action: "mouse_click", coords: "500,250" })).toMatchObject({
      coords: { x: 500, y: 250 },
    });
  });

  it("acepta alias de la acción", () => {
    expect(parse({ action: "click", coords: { x: 1, y: 2 } }).action).toBe("mouse_click");
    expect(parse({ action: "move", coords: { x: 1, y: 2 } }).action).toBe("move_cursor");
    expect(parse({ action: "type", text: "hola" }).action).toBe("type_text");
    expect(parse({ action: "press", key: "return" }).action).toBe("press_key");
  });

  it("convierte duración y texto numéricos", () => {
    expect(parse({ action: "wait", duration: "1500" }).duration).toBe(1500);
    expect(parse({ action: "type_text", text: 42 }).text).toBe("42");
  });

  it("sigue exigiendo los argumentos propios de cada acción", () => {
    expect(() => parse({ action: "move_cursor" })).toThrow();
    expect(() => parse({ action: "type_text" })).toThrow();
    expect(() => parse({ action: "press_key" })).toThrow();
    expect(() => parse({ action: "wait" })).toThrow();
  });

  it("sigue rechazando valores fuera de rango", () => {
    expect(() => parse({ action: "move_cursor", coords: { x: 5000, y: 2 } })).toThrow();
    expect(() => parse({ action: "move_cursor", coords: { x: -1, y: 2 } })).toThrow();
  });
});
