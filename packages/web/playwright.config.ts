import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(preferred, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", () => {
      // preferred is taken — ask OS for any free port
      const s2 = createServer();
      s2.listen(0, "127.0.0.1", () => {
        const port = (s2.address() as { port: number }).port;
        s2.close(() => resolve(port));
      });
    });
  });
}

// Compute once in the main process and write back to process.env so that
// Playwright worker processes (which re-evaluate this file) inherit the same
// value rather than calling freePort() again and potentially getting a
// different port (the preferred one is now occupied by the webServer).
if (!process.env.PW_API_PORT) {
  process.env.PW_API_PORT = String(await freePort(19871));
}
if (!process.env.PW_DB_PATH) {
  process.env.PW_DB_PATH = join(tmpdir(), `orc-pw-${Date.now()}.db`);
}

const PW_API_PORT = process.env.PW_API_PORT;
const PW_DB = process.env.PW_DB_PATH;

// Expose to test workers (helpers.ts reads ORC_API_PORT for direct API calls)
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
