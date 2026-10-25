import { describe, expect, it } from "vitest";
import { OuraBridge } from "./oura.js";
import { MemoryTokenStore } from "./common.js";
import type { FetchLike, OAuthToken } from "../types.js";

function tokenStore(token?: OAuthToken): MemoryTokenStore {
  const store = new MemoryTokenStore();
  if (token !== undefined) store.set("oura", token);
  return store;
}

function validToken(): OAuthToken {
  return { accessToken: "oura-access", expiresAt: Date.now() + 60_000 };
}

function ouraResponse(pathname: string): Response {
  const common = {
    id: "record-1",
    day: "2024-01-02",
    timestamp: "2024-01-02T00:00:00.000Z",
  };
  if (pathname.endsWith("/daily_heart_rate")) {
    return new Response(JSON.stringify({
      data: [{ ...common, contributors: { resting_heart_rate: 52, average_heart_rate: 61 } }],
    }));
  }
  if (pathname.endsWith("/daily_hrv")) {
    return new Response(JSON.stringify({
      data: [{ ...common, contributors: { hrv: { rmssd: 31.2, sdnn: 44.1, pnn50: 18 } } }],
    }));
  }
  if (pathname.endsWith("/daily_spo2")) {
    return new Response(JSON.stringify({
      data: [{ ...common, contributors: { spo2: { average: 97.4, lowest: 94 } } }],
    }));
  }
  if (pathname.endsWith("/daily_sleep")) {
    return new Response(JSON.stringify({
      data: [{ ...common, contributors: { sleep_score: 86 } }],
    }));
  }
  return new Response(JSON.stringify({
    data: [{ ...common, contributors: { recovery_index: 30 } }],
  }));
}

describe("Oura bridge", () => {
  it("mapea las colecciones reales de Oura API v2", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = new URL(input.toString());
      return ouraResponse(url.pathname);
    };
    const bridge = new OuraBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://oura.test",
    });

    const samples = await bridge.fetchSamples(
      Date.UTC(2024, 0, 1),
      Date.UTC(2024, 0, 3),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      ts: Date.UTC(2024, 0, 2),
      heartRate: 52,
      hrvMs: 31.2,
      spo2: 97.4,
      sleepScore: 86,
      stressScore: 70,
      source: "oura",
    });
  });

  it("consulta las colecciones v2 con fechas y Bearer", async () => {
    const paths: string[] = [];
    let authorization: string | null = null;
    const fetchMock: FetchLike = async (input, init) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      authorization = new Headers(init?.headers).get("Authorization");
      expect(url.searchParams.get("start_date")).toBe("2024-01-01");
      expect(url.searchParams.get("end_date")).toBe("2024-01-03");
      return ouraResponse(url.pathname);
    };
    const bridge = new OuraBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://oura.test",
    });

    await bridge.fetchSamples(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 3));

    expect(paths).toEqual([
      "/v2/usercollection/daily_heart_rate",
      "/v2/usercollection/daily_hrv",
      "/v2/usercollection/daily_spo2",
      "/v2/usercollection/daily_sleep",
      "/v2/usercollection/daily_stress",
    ]);
    expect(authorization).toBe("Bearer oura-access");
  });

  it("construye la URL de autorización con client ID y scopes", () => {
    const bridge = new OuraBridge({
      clientId: "client-id",
      clientSecret: "secret",
      tokenStore: tokenStore(),
      fetch: async () => new Response("{}"),
      redirectUri: "https://jarvis.test/callback",
    });

    const url = new URL(bridge.getAuthorizationUrl("state-1"));

    expect(url.origin + url.pathname).toBe("https://api.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://jarvis.test/callback");
    expect(url.searchParams.get("scope")).toContain("daily");
  });

  it("canjea el código con autenticación Basic y persiste el token", async () => {
    const store = tokenStore();
    let authorization: string | null = null;
    const fetchMock: FetchLike = async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect((init?.body as URLSearchParams).get("grant_type")).toBe("authorization_code");
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3_600,
        token_type: "Bearer",
      }));
    };
    const bridge = new OuraBridge({
      clientId: "client-id",
      clientSecret: "secret",
      tokenStore: store,
      fetch: fetchMock,
      tokenUrl: "https://oura.test/token",
    });

    const token = await bridge.exchangeAuthorizationCode("code-1");

    expect(authorization).toBe(`Basic ${Buffer.from("client-id:secret").toString("base64")}`);
    expect(token.accessToken).toBe("new-access");
    expect(store.get("oura")?.refreshToken).toBe("new-refresh");
  });

  it("clasifica un HTTP 429 como rate limit", async () => {
    const fetchMock: FetchLike = async () => new Response("slow down", { status: 429 });
    const bridge = new OuraBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://oura.test",
    });

    await expect(bridge.fetchSamples(0, 1_000)).rejects.toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryable: true,
      provider: "oura",
    });
  });
});
