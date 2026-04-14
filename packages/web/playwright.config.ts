import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PW_API_PORT = process.env.PW_API_PORT ?? "19871";
const PW_DB = process.env.PW_DB_PATH ?? join(tmpdir(), "orc-pw-e2e.db");

// Make isolated ports visible to the test process (helpers.ts reads ORC_API_PORT)
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
  ...(process.env.PW_NO_SERVER
    ? {}
    : {
        webServer: {
          // E2E runs against the built dashboard served by the API itself.
          // This avoids Vite + Bun hot child-process trees on Windows, which
          // are the main source of orphaned listeners and stuck ports.
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
