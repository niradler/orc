import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// PW_API_PORT and PW_DB_PATH are always set by run-e2e.ts before playwright
// is spawned. Worker processes re-evaluate this file but inherit the env, so
// they read the same values. No freePort() call needed here.
const PW_API_PORT = process.env.PW_API_PORT ?? "7799";
const PW_DB = process.env.PW_DB_PATH ?? join(tmpdir(), "orc-pw-fallback.db");

// Expose to test helpers that call the API directly.
process.env.ORC_API_PORT = PW_API_PORT;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts$/,
  globalTimeout: 20 * 60_000,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PW_API_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  // webServer is intentionally absent: run-e2e.ts owns the server lifecycle.
  // PW_NO_SERVER is set by run-e2e.ts. If you run `playwright test` directly
  // without going through run-e2e.ts, start the API server manually first:
  //   ORC_API_PORT=7799 ORC_DB_PATH=/tmp/test.db bun packages/api/src/index.ts
  //   PW_API_PORT=7799 PW_NO_SERVER=1 bun x playwright test
  ...(process.env.PW_NO_SERVER
    ? {}
    : {
        webServer: {
          command: "bun packages/api/src/index.ts",
          cwd: "../..",
          url: `http://127.0.0.1:${PW_API_PORT}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
          env: {
            ORC_API_HOST: "127.0.0.1",
            ORC_API_PORT: PW_API_PORT,
            ORC_API_SECRET: "",
            ORC_DB_PATH: PW_DB,
            ORC_E2E_CHAT_MOCK: "1",
          },
        },
      }),
});
