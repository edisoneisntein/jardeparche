import { describe, expect, it } from "vitest";
import { GarminBridge } from "./garmin.js";
import { MemoryTokenStore } from "./common.js";
import { BiometricsError } from "../errors.js";
import type { FetchLike, OAuthToken } from "../types.js";

function tokenStore(token?: OAuthToken): MemoryTokenStore {
  const store = new MemoryTokenStore();
  if (token !== undefined) store.set("garmin", token);
  return store;
}

function validToken(): OAuthToken {
  return { accessToken: "access-token", expiresAt: Date.now() + 60_000 };
}

function garminResponse(pathname: string): Response {
  const calendarDate = { year: 2024, month: 1, day: 2 };
  if (pathname.endsWith("/heart_rates")) {
    return new Response(JSON.stringify([
      { summaryDTO: { calendarDate, restingHeartRate: 54 } },
    ]));
  }
  if (pathname.endsWith("/heart_rate_variability")) {
    return new Response(JSON.stringify({
      hrvSummaryDTO: { calendarDate, lastNightAvg: 42.5 },
    }));
  }
  if (pathname.endsWith("/stress")) {
    return new Response(JSON.stringify({
      stressSummaryDTO: { calendarDate, overallStressLevel: 73 },
    }));
  }
  if (pathname.endsWith("/sleep")) {
    return new Response(JSON.stringify({
      sleepSummaryDTO: { calendarDate, sleepScore: 81 },
    }));
  }
  return new Response(JSON.stringify({
    pulseOxSummaryDTO: { calendarDate, averageSpO2: 97 },
  }));
}

describe("Garmin bridge", () => {
  it("mapea las respuestas reales de los endpoints de Garmin", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = new URL(input.toString());
      return garminResponse(url.pathname);
    };
    const bridge = new GarminBridge({
      clientId: "client",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://garmin.test/rest",
    });

    const samples = await bridge.fetchSamples(
      Date.UTC(2024, 0, 1),
      Date.UTC(2024, 0, 3),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      ts: Date.UTC(2024, 0, 2),
      heartRate: 54,
      hrvMs: 42.5,
      stressScore: 73,
      sleepScore: 81,
      spo2: 97,
      source: "garmin",
    });
  });

  it("envía Bearer y el rango temporal en segundos", async () => {
    let observedAuthorization: string | null = null;
    let observedQuery: URLSearchParams | undefined;
    const fetchMock: FetchLike = async (input, init) => {
      const url = new URL(input.toString());
      observedAuthorization = new Headers(init?.headers).get("Authorization");
      observedQuery = url.searchParams;
      return garminResponse(url.pathname);
    };
    const bridge = new GarminBridge({
      clientId: "client",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://garmin.test/rest",
    });

    await bridge.fetchSamples(1_700_000_000_000, 1_700_086_400_000);

    expect(observedAuthorization).toBe("Bearer access-token");
    expect(observedQuery?.get("uploadStartTimeInSeconds")).toBe("1700000000");
    expect(observedQuery?.get("uploadEndTimeInSeconds")).toBe("1700086400");
  });

  it("traduce errores HTTP a BiometricsError tipado", async () => {
    const fetchMock: FetchLike = async () => new Response("unauthorized", { status: 401 });
    const bridge = new GarminBridge({
      clientId: "client",
      tokenStore: tokenStore(validToken()),
      fetch: fetchMock,
      baseUrl: "https://garmin.test/rest",
    });

    await expect(bridge.fetchSamples(0, 1_000)).rejects.toMatchObject({
      kind: "authentication",
      status: 401,
      provider: "garmin",
    });
  });

  it("renueva y persiste un token OAuth2", async () => {
    const store = tokenStore(validToken());
    const fetchMock: FetchLike = async (_input, init) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      expect((body as URLSearchParams).get("grant_type")).toBe("refresh_token");
      return new Response(JSON.stringify({
        access_token: "renewed",
        refresh_token: "next-refresh",
        expires_in: 3_600,
        token_type: "Bearer",
      }));
    };
    const bridge = new GarminBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: store,
      fetch: fetchMock,
      tokenUrl: "https://garmin.test/token",
    });

    const renewed = await bridge.refreshAccessToken("refresh");

    expect(renewed.accessToken).toBe("renewed");
    expect(store.get("garmin")?.accessToken).toBe("renewed");
    expect(store.get("garmin")?.refreshToken).toBe("next-refresh");
  });

  it("falla de forma explícita cuando no existe un token almacenado", async () => {
    const bridge = new GarminBridge({
      clientId: "client",
      tokenStore: tokenStore(),
      fetch: async () => new Response("{}"),
    });

    await expect(bridge.fetchSamples(0, 1)).rejects.toBeInstanceOf(BiometricsError);
  });
});
