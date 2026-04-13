import { defineConfig, devices } from "@playwright/test";

const API_PORT = process.env.ORC_API_PORT ?? "7701";
const WEB_PORT = process.env.ORC_WEB_PORT ?? "3077";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PW_NO_SERVER
    ? undefined
    : [
        {
          command: "bun run --filter @orc/api dev",
          cwd: "../..",
          url: `http://localhost:${API_PORT}/health`,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "bun run --filter @orc/web dev",
          cwd: "../..",
          url: `http://localhost:${WEB_PORT}`,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
