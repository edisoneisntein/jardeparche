import { defineConfig, devices } from "@playwright/test";

/**
 * JARVIS E2E.
 *
 * IMPORTANTE: `webServer` está desactivado a propósito. Se asume que el stack
 * de desarrollo ya está corriendo:
 *
 *   docker compose up -d db && pnpm dev
 *
 * Los tests con etiqueta @live requieren una NVIDIA_API_KEY real exportada en
 * el entorno (ver e2e/README.md).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // No `webServer`: el stack (db + server + web) debe estar levantado antes.
});
