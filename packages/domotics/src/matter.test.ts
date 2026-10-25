import { describe, expect, it } from "vitest";
import { DomoticsError } from "./errors.js";
import { CliMatterClient, HttpMatterClient, InMemoryMatterClient, createMatterClient } from "./matter.js";
import type { MatterFetch } from "./types.js";

describe("Matter", () => {
  it("permite pairar, comisionar, escribir y leer en memoria", async () => {
    const client = new InMemoryMatterClient();
    expect((await client.pair("device-1")).paired).toBe(true);
    expect((await client.commission("device-1")).commissioned).toBe(true);
    expect((await client.set("device-1", "OnOff", "onOff", true)).value).toBe(true);
    expect(await client.read("device-1", "OnOff", "onOff")).toBe(true);
    expect((await client.status("device-1")).connected).toBe(true);
  });

  it("rechaza escritura y comisión en un dispositivo inexistente", async () => {
    const client = new InMemoryMatterClient();
    await expect(client.commission("missing")).rejects.toBeInstanceOf(DomoticsError);
    await expect(client.set("missing", "OnOff", "onOff", true)).rejects.toBeInstanceOf(DomoticsError);
  });

  it("usa el transporte HTTP configurable y conserva el payload", async () => {
    const requests: Array<{ url: string; init: Parameters<MatterFetch>[1] }> = [];
    const fetchImpl: MatterFetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ paired: true, commissioned: true, value: 42 }),
      };
    };
    const client = new HttpMatterClient({ endpoint: "http://border-router.local/api/", token: "secret", fetch: fetchImpl });

    await client.pair("device-2");
    await client.commission("device-2", { network: "thread" });
    expect(await client.read("device-2", "OnOff", "onOff")).toBe(42);

    expect(requests[0]?.url).toBe("http://border-router.local/api/pair");
    expect(requests[0]?.init?.headers?.authorization).toBe("Bearer secret");
    expect(requests[1]?.init?.body).toContain("device-2");
  });

  it("convierte errores HTTP en DomoticsError", async () => {
    const fetchImpl: MatterFetch = async () => ({ ok: false, status: 503, text: async () => "no disponible" });
    const client = new HttpMatterClient({ endpoint: "http://border-router.local", fetch: fetchImpl });
    await expect(client.status()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("selecciona memoria, HTTP o CLI según la configuración", () => {
    expect(createMatterClient()).toBeInstanceOf(InMemoryMatterClient);
    expect(createMatterClient({ transport: "http", endpoint: "http://example.test" })).toBeInstanceOf(HttpMatterClient);
    expect(createMatterClient({ transport: "cli", cliCommand: "matter-cli" })).toBeInstanceOf(CliMatterClient);
  });

  it("valida identificadores y clusters antes de operar", async () => {
    const client = new InMemoryMatterClient();
    await expect(client.pair("bad\nid")).rejects.toMatchObject({ kind: "configuration" });
    await expect(client.set("device-1", "OnOff", "bad attribute", true)).rejects.toMatchObject({ kind: "configuration" });
  });
});
