import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { runMigrations } from "./postgres-store.js";

/**
 * Cliente de postgres de mentira: registra las consultas y falla cuando se le
 * pide. Sirve para comprobar la ORDEN y la ATOMICIDAD del gestor, que es lo
 * que importa, sin levantar una base de datos.
 */
class FakeClient {
  readonly queries: string[] = [];
  private applied = new Set<string>();
  failOn = "";

  async query(text: string, values?: unknown[]): Promise<unknown> {
    this.queries.push(text);
    if (this.failOn && text.includes(this.failOn)) {
      throw new Error(`fallo simulado en: ${this.failOn}`);
    }
    if (text.startsWith("SELECT id FROM")) {
      return { rows: [...this.applied].map((id) => ({ id })) };
    }
    if (text.startsWith("INSERT INTO") && values?.[0]) {
      this.applied.add(String(values[0]));
    }
    return { rows: [] };
  }
}

describe("ARCH-002 · gestor de migraciones", () => {
  it("las migraciones están ordenadas y con identificador estable", () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual([
      "001_init",
      "002_semantic",
      "003_tool_call_ids",
      "004_response_cache",
      "005_vector_ann_index",
    ]);
    for (const migration of MIGRATIONS) {
      expect(migration.id).toMatch(/^\d{3}_[a-z0-9_]+$/);
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it("aplica las migraciones dentro de una transacción y confirma", async () => {
    const client = new FakeClient();
    const applied = await runMigrations(client);
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries.at(-1)).toBe("COMMIT");
    expect(client.queries).not.toContain("ROLLBACK");
  });

  it("es idempotente: la segunda pasada no aplica nada", async () => {
    const client = new FakeClient();
    await runMigrations(client);
    const second = await runMigrations(client);
    expect(second).toEqual([]);
  });

  it("ante un DDL con error hace ROLLBACK y no deja el esquema a medias", async () => {
    const client = new FakeClient();
    client.failOn = "ALTER TABLE jarvis_tool_calls";
    await expect(runMigrations(client)).rejects.toThrow(/fallo simulado/);
    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(client.queries).not.toContain("COMMIT");
  });
});
