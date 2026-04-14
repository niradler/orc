import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function osPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function getFreePort(preferred: number): Promise<number> {
  const httpUp = await fetch(`http://127.0.0.1:${preferred}`, {
    signal: AbortSignal.timeout(300),
  })
    .then(() => true)
    .catch(() => false);
  if (httpUp) return osPort();

  const canBind = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("listening", () => server.close(() => resolve(true)));
    server.once("error", () => resolve(false));
    server.listen(preferred, "127.0.0.1");
  });
  return canBind ? preferred : osPort();
}

async function run(cmd: string[], env: Record<string, string>, timeoutMs: number): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd: import.meta.dir + "/..",
    env,
    stdout: "inherit",
    stderr: "inherit",
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited with code ${exitCode}`);
  }
}

const pwApiPort = process.env.PW_API_PORT ?? String(await getFreePort(19871));
const pwDbPath = process.env.PW_DB_PATH ?? join(tmpdir(), `orc-pw-${process.pid}-${Date.now()}.db`);
const env = {
  ...process.env,
  ORC_API_HOST: "127.0.0.1",
  PW_API_PORT: pwApiPort,
  PW_DB_PATH: pwDbPath,
  ORC_API_PORT: pwApiPort,
  ORC_DB_PATH: pwDbPath,
  ORC_API_SECRET: "",
  ORC_E2E_CHAT_MOCK: "1",
} satisfies Record<string, string>;

await run(["bun", "x", "vite", "build"], env, 5 * 60_000);
await run(["bun", "x", "playwright", "test", ...process.argv.slice(2)], env, 25 * 60_000);
