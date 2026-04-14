import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PW_API_PORT = process.env.PW_API_PORT ?? "9871";
const PW_WEB_PORT = process.env.PW_WEB_PORT ?? "9872";
const PW_DB = join(tmpdir(), `orc-pw-${process.pid}-${Date.now()}.db`);

// Make isolated ports visible to the test process (helpers.ts reads ORC_API_PORT)
process.env.ORC_API_PORT = PW_API_PORT;
process.env.ORC_WEB_PORT = PW_WEB_PORT;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PW_WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
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
        webServer: [
          {
            // Run bun directly — avoids "bun --env-file ../../.env" in the dev
            // script overriding the isolated ORC_API_PORT we pass here.
            command: `bun run --hot packages/api/src/index.ts`,
            cwd: "../..",
            url: `http://localhost:${PW_API_PORT}/health`,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: "pipe" as const,
            stderr: "pipe" as const,
            env: {
              ORC_API_PORT: PW_API_PORT,
              ORC_DB_PATH: PW_DB,
            },
          },
          {
            command: `bun vite`,
            cwd: ".",
            url: `http://localhost:${PW_WEB_PORT}`,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: "pipe" as const,
            stderr: "pipe" as const,
            env: {
              ORC_API_PORT: PW_API_PORT,
              ORC_WEB_PORT: PW_WEB_PORT,
            },
          },
        ],
      }),
});
