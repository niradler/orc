import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

function osPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function getFreePort(preferred: number): Promise<number> {
  // Playwright checks HTTP, not just TCP bind — skip ports with an HTTP server already
  const httpUp = await fetch(`http://127.0.0.1:${preferred}`, {
    signal: AbortSignal.timeout(300),
  })
    .then(() => true)
    .catch(() => false);
  if (httpUp) return osPort();

  // Also check TCP bind
  const canBind = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.once("error", () => resolve(false));
    srv.listen(preferred, "127.0.0.1");
  });
  return canBind ? preferred : osPort();
}

const PW_API_PORT =
  process.env.PW_API_PORT ?? String(await getFreePort(Number(process.env.PW_API_PORT ?? 19871)));
const PW_DB = join(tmpdir(), `orc-pw-${process.pid}-${Date.now()}.db`);

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
