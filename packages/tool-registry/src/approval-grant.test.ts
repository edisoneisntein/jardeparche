import { describe, expect, it } from "vitest";
import {
  ApprovalGrantError,
  canonicalJson,
  hashArguments,
  signApprovalGrant,
  verifyApprovalGrant,
} from "../src/registry.js";

const SECRET = "secreto-de-prueba";

const claims = {
  toolName: "task.delete",
  userId: "alice",
  sessionId: "11111111-1111-1111-1111-111111111111",
  taskId: "t1",
  toolCallId: "c1",
  argsHash: hashArguments({ id: "abc" }),
  mode: "user" as const,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

const expectation = {
  toolName: "task.delete",
  argsHash: claims.argsHash,
  userId: "alice",
  sessionId: claims.sessionId,
};

describe("SEC-002 · tokens de aprobación", () => {
  it("un token bien firmado se verifica", () => {
    const token = signApprovalGrant(claims, SECRET);
    const verified = verifyApprovalGrant(token, SECRET, expectation);
    expect(verified.toolName).toBe("task.delete");
    expect(verified.mode).toBe("user");
  });

  it("el hash de argumentos no depende del orden de las claves", () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("el hash cambia si cambia un argumento", () => {
    expect(hashArguments({ id: "abc" })).not.toBe(hashArguments({ id: "xyz" }));
  });

  it("rechaza un token firmado con otro secreto", () => {
    const token = signApprovalGrant(claims, "otro-secreto");
    expect(() => verifyApprovalGrant(token, SECRET, expectation)).toThrow(/ACCESO DENEGADO/);
  });

  it("rechaza un token manipulado", () => {
    const token = signApprovalGrant(claims, SECRET);
    const [payload] = token.split(".");
    const forjado = `${payload}.${"A".repeat(43)}`;
    expect(() => verifyApprovalGrant(forjado, SECRET, expectation)).toThrow(ApprovalGrantError);
  });

  it("rechaza un token caducado", () => {
    const token = signApprovalGrant({ ...claims, expiresAt: Date.now() - 1 }, SECRET);
    expect(() => verifyApprovalGrant(token, SECRET, expectation)).toThrow(/caducado/);
  });

  it("rechaza un token de otra herramienta", () => {
    const token = signApprovalGrant(claims, SECRET);
    expect(() => verifyApprovalGrant(token, SECRET, { ...expectation, toolName: "memory.forget" })).toThrow(
      /otra herramienta/,
    );
  });

  it("rechaza un token de otros argumentos (no se puede cambiar la carga)", () => {
    const token = signApprovalGrant(claims, SECRET);
    expect(() => verifyApprovalGrant(token, SECRET, { ...expectation, argsHash: hashArguments({ id: "otro" }) })).toThrow(
      /argumentos no coinciden/,
    );
  });

  it("rechaza un token de otro usuario o de otra sesión", () => {
    const token = signApprovalGrant(claims, SECRET);
    expect(() => verifyApprovalGrant(token, SECRET, { ...expectation, userId: "mallory" })).toThrow(/otro usuario/);
    expect(() => verifyApprovalGrant(token, SECRET, { ...expectation, sessionId: "otra" })).toThrow(/otra sesión/);
  });

  it("un token malformado se rechaza, no se interpreta", () => {
    expect(() => verifyApprovalGrant("basura", SECRET, expectation)).toThrow(/malformado/);
    expect(() => verifyApprovalGrant("a.b.c", SECRET, expectation)).toThrow(/malformado/);
  });
});
