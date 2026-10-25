import { describe, expect, it } from "vitest";
import { PolarBridge } from "./polar.js";
import { MemoryTokenStore } from "./common.js";
import { BiometricsError } from "../errors.js";
import type { FetchLike, OAuthToken } from "../types.js";

function polarStore(): MemoryTokenStore {
  const store = new MemoryTokenStore();
  const token: OAuthToken = { accessToken: "polar-access", expiresAt: Date.now() + 60_000 };
  store.set("polar", token);
  return store;
}

function polarResponse(pathname: string): Response {
  if (pathname.endsWith("/continuous-heart-rate")) {
    return new Response(JSON.stringify({
      date: "2024-01-02",
      heart_rate_samples: [
        { heart_rate: 63, sample_time: "00:02:08" },
        { heart_rate: 66, sample_time: "00:07:08" },
      ],
    }));
  }
  if (pathname.endsWith("/v3/users/sleep")) {
    return new Response(JSON.stringify({
      nights: [{
        date: "2024-01-02",
        sleep_end_time: "2024-01-02T08:00:00Z",
        sleep_score: 84,
        heart_rate_samples: { "00:41": 58 },
      }],
    }));
  }
  if (pathname.endsWith("/biosensing/spo2")) {
    return new Response(JSON.stringify([{
      test_time: 1_704_153_600,
      blood_oxygen_percent: 96,
      average_heart_rate_bpm: 61,
      heart_rate_variability_ms: 44,
    }]));
  }
  return new Response(JSON.stringify([{
    start_time: "2024-01-02T07:00:00",
    samples: [{
      temperature_celsius: 36.4,
      recording_time_delta_milliseconds: 250,
    }],
  }]));
}

describe("Polar bridge", () => {
  it("mapea los recursos reales de AccessLink v3", async () => {
    const fetchMock: FetchLike = async (input) => {
      const url = new URL(input.toString());
      return polarResponse(url.pathname);
    };
    const bridge = new PolarBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: polarStore(),
      fetch: fetchMock,
      baseUrl: "https://polar.test",
    });

    const samples = await bridge.fetchSamples(
      Date.UTC(2024, 0, 2),
      Date.UTC(2024, 0, 3),
    );

    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(samples).toContainEqual({
      ts: Date.UTC(2024, 0, 2, 0, 2, 8),
      heartRate: 63,
      source: "polar",
    });
    expect(samples).toContainEqual({
      ts: Date.UTC(2024, 0, 2, 8),
      sleepScore: 84,
      source: "polar",
    });
    expect(samples.some((sample) => sample.spo2 === 96 && sample.hrvMs === 44)).toBe(true);
    expect(samples.some((sample) => sample.temperatureC === 36.4)).toBe(true);
  });

  it("impide rangos superiores al límite de AccessLink", async () => {
    const bridge = new PolarBridge({
      clientId: "client",
      clientSecret: "secret",
      tokenStore: polarStore(),
      fetch: async () => new Response("{}"),
      baseUrl: "https://polar.test",
    });
    const start = Date.UTC(2024, 0, 1);

    await expect(
      bridge.fetchSamples(start, start + 29 * 24 * 60 * 60 * 1_000),
    ).rejects.toMatchObject({ kind: "invalid_input" });
  });
});