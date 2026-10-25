import { describe, expect, it, vi, afterEach } from "vitest";
import { assertPublicUrl, createWebFetchTool, extractReadableText, extractTitle, isPrivateAddress, resolvePublicTarget } from "./builtin/web-fetch.js";
import { MemoryService } from "@jarvis/memory";
import { MemoryStore } from "@jarvis/memory";
import type { ToolContext } from "@jarvis/shared";
import type { WebFetchHttpClient } from "./builtin/web-fetch.js";

const ctx: ToolContext = {
  userId: "local",
  sessionId: "00000000-0000-4000-8000-000000000000",
  taskId: "task",
  correlationId: "corr",
  now: () => new Date(),
};

const services = {
  memory: new MemoryService({ store: new MemoryStore() }),
  config: { documentsRoots: [], webSearch: {}, maxResultBytes: 1024 },
};

/** Cliente HTTP falso: registra lo que la tool le pasa y devuelve una respuesta fija. */
function fakeClient(response: {
  status: number;
  contentType?: string;
  body?: string;
  location?: string;
}): WebFetchHttpClient & { calls: Array<{ url: string; addresses: Array<{ address: string; family: number }> }> } {
  const calls: Array<{ url: string; addresses: Array<{ address: string; family: number }> }> = [];
  return {
    calls,
    get: async (url, options) => {
      calls.push({ url: url.toString(), addresses: options.addresses });
      return {
        status: response.status,
        location: response.location,
        contentType: response.contentType ?? "text/html; charset=utf-8",
        body: Buffer.from(response.body ?? "", "utf8"),
        truncated: false,
      };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPrivateAddress", () => {
  it("reconoce los rangos no públicos", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1"]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  it("deja pasar las direcciones públicas", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it("cierra las variantes IPv6 que traducen o embeben un IPv4 privado", () => {
    const bypass = [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:0001::",
      "2002:a9fe:a9fe::",
      "::127.0.0.1",
      "fc00::1",
      "fd12:3456::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "198.18.0.1",
      "203.0.113.7",
    ];
    for (const address of bypass) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("no confunde una IPv6 pública con una privada", () => {
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("2a00:1450:4001:80f::200e")).toBe(false);
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
  });

  it("rechaza una dirección no clasificable", () => {
    expect(isPrivateAddress("no-es-una-ip")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("rechaza esquemas no http(s)", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/esquema/);
    await expect(assertPublicUrl("ftp://example.com")).rejects.toThrow(/esquema/);
  });

  it("rechaza destinos internos (SSRF)", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8787/api/health")).rejects.toThrow(/no público|resuelve/);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/no público/);
    await expect(assertPublicUrl("http://[::1]:8787/")).rejects.toThrow(/no público/);
  });
});

describe("extracción de texto", () => {
  it("descarta script, style y navegación", () => {
    const html = `<html><head><title>Título</title><style>b{}</style><script>mal()</script></head>
      <body><nav>menu</nav><article><h1>Encabezado</h1><p>Cuerpo del <b>artículo</b>.</p></article><footer>pie</footer></body></html>`;
    const text = extractReadableText(html);
    expect(text).toContain("Cuerpo del artículo");
    expect(text).not.toContain("mal()");
    expect(text).not.toContain("menu");
    expect(extractTitle(html)).toBe("Título");
  });

  it("decodifica entidades y no pega las palabras entre etiquetas", () => {
    const text = extractReadableText("<article><p>Caf&eacute;? no: a&b</p><p>Hola<b>mundo</b></p></article>");
    expect(text).toContain("a&b");
    expect(text).toContain("Hola mundo");
  });

  it("prefiere article sobre body", () => {
    const html = "<body><div>ruido del cuerpo</div><article><p>contenido útil</p></article></body>";
    const text = extractReadableText(html);
    expect(text).toContain("contenido útil");
    expect(text).not.toContain("ruido del cuerpo");
  });
});

describe("web.fetch", () => {
  it("devuelve el texto de la página y su título", async () => {
    const client = fakeClient({
      status: 200,
      body: "<html><head><title>Noticia</title></head><body><article><p>El contenido real de la página.</p></article></body></html>",
    });
    const tool = createWebFetchTool(services, client);
    const result = await tool.execute({ url: "https://example.com/noticia", max_chars: 6000 }, ctx);
    expect(result.ok).toBe(true);
    const data = result.data as { text: string; title?: string };
    expect(data.text).toContain("El contenido real de la página");
    expect(data.title).toBe("Noticia");
  });

  it("fijala dirección validada en la conexión (anti DNS-rebinding)", async () => {
    const client = fakeClient({ status: 200, body: "<html><body><p>ok</p></body></html>" });
    const tool = createWebFetchTool(services, client);
    await tool.execute({ url: "http://93.184.216.34/x", max_chars: 6000 }, ctx);
    expect(client.calls[0]?.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("propaga unAbortSignal con presupuesto de tiempo al transporte", async () => {
    let received: AbortSignal | undefined;
    const client: WebFetchHttpClient = {
      get: async (_url, options) => {
        received = options.signal;
        return { status: 200, contentType: "text/html", body: Buffer.from("<p>x</p>"), truncated: false };
      },
    };
    const tool = createWebFetchTool(services, client);
    await tool.execute({ url: "http://93.184.216.34/x", max_chars: 6000 }, ctx);
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(false);
  });

  it("rechaza contenido no textual", async () => {
    const client = fakeClient({ status: 200, contentType: "application/pdf", body: "binary" });
    const tool = createWebFetchTool(services, client);
    const result = await tool.execute({ url: "https://example.com/x.pdf", max_chars: 6000 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch_failed");
  });

  it("informa del error HTTP sin inventar contenido", async () => {
    const client = fakeClient({ status: 404, body: "nope" });
    const tool = createWebFetchTool(services, client);
    const result = await tool.execute({ url: "https://example.com/missing", max_chars: 6000 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("404");
  });

  it("sigue una redirección revalidando el destino", async () => {
    const client = fakeClient({ status: 302, location: "https://example.com/final" });
    const tool = createWebFetchTool(services, client);
    const result = await tool.execute({ url: "https://example.com/inicio", max_chars: 6000 }, ctx);
    expect(result.ok).toBe(false);
    expect(client.calls[0]?.url).toBe("https://example.com/inicio");
  });
});

describe("resolvePublicTarget", () => {
  it("devuelve todas las direcciones resueltas y validadas", async () => {
    const target = await resolvePublicTarget("http://93.184.216.34/pagina");
    expect(target.addresses).toHaveLength(1);
    expect(target.addresses[0]?.family).toBe(4);
  });
});
