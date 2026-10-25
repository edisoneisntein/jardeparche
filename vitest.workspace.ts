import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: [
        "packages/**/test/**/*.test.ts",
        "packages/**/src/**/*.test.ts",
        "apps/**/test/**/*.test.ts",
        "packages/**/src/**/*.stress.test.ts",
        "apps/**/src/**/*.vad.test.ts",
      ],
      exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
      environment: "node",
    },
  },
  {
    test: {
      name: "integration",
      include: ["**/*.integration.test.ts", "tests/**/*.integration.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "node",
      testTimeout: 120000,
      hookTimeout: 60000,
    },
  },
  {
    test: {
      name: "voice-stress",
      include: ["packages/voice/src/streamer.stress.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "node",
      testTimeout: 60000,
      hookTimeout: 30000,
    },
  },
  {
    test: {
      name: "voice-vad",
      include: ["apps/web/src/lib/micCapture.vad.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "jsdom",
      testTimeout: 30000,
      hookTimeout: 15000,
    },
  },
  {
    test: {
      name: "voice-backpressure",
      include: ["apps/server/src/voice-backpressure.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "node",
      testTimeout: 30000,
      hookTimeout: 15000,
    },
  },
]);
