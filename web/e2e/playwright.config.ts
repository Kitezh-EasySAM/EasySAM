import { defineConfig } from "@playwright/test";

// e2e-обход собранного фронта на своём сервере (порт 8190, временная демо-база): npm run e2e (сначала npm run build).
// Сервер и пользователей готовит global-setup.ts, гасит global-teardown.ts.
export const BASE = "http://127.0.0.1:8190";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  outputDir: "../test-results",
  use: {
    baseURL: BASE,
    storageState: "e2e/.auth/admin.json",
    trace: "retain-on-failure",
    // локально — установленный Google Chrome; в CI — Chromium из `npx playwright install chromium`
    channel: process.env.CI ? undefined : "chrome",
  },
});
