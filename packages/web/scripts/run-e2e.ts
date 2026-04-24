import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** Throws immediately if something is already listening on the port. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use - kill the process holding it and retry`));
      } else {
        reject(err);
      }
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await Bun.sleep(200);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function run(cmd: string[], env: Record<string, string>, timeoutMs: number): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd: `${import.meta.dir}/..`,
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

const pwApiPort = process.env.PW_API_PORT ?? String(await freePort());
await assertPortFree(Number(pwApiPort));
const pwDbPath = process.env.PW_DB_PATH ?? join(tmpdir(), `orc-pw-${process.pid}.db`);
const pwKnowledgeDbPath =
  process.env.PW_KNOWLEDGE_DB_PATH ?? join(tmpdir(), `orc-pw-knowledge-${process.pid}.db`);

const env = {
  ...process.env,
  ORC_API_HOST: "127.0.0.1",
  PW_API_PORT: pwApiPort,
  PW_DB_PATH: pwDbPath,
  ORC_API_PORT: pwApiPort,
  ORC_DB_PATH: pwDbPath,
  ORC_KNOWLEDGE_DB_PATH: pwKnowledgeDbPath,
  ORC_API_SECRET: "",
  ORC_E2E_CHAT_MOCK: "1",
  // We manage the server ourselves so playwright does not spawn a second one.
  // This is the only reliable way to guarantee the port is freed on all
  // platforms: keep the process handle in scope and kill it in finally.
  PW_NO_SERVER: "1",
} satisfies Record<string, string>;

// Start the API server before playwright so we own the process handle.
// Playwright's webServer cannot be relied on to kill its child on Windows
// when playwright itself is killed or times out.
// import.meta.dir = packages/web/scripts  →  ../../.. = repo root
const repoRoot = join(import.meta.dir, "../../..");
const apiProc = Bun.spawn({
  cmd: ["bun", "packages/api/src/index.ts"],
  cwd: repoRoot,
  env,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});

function killApiServer(): void {
  if (apiProc.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // proc.kill() only kills the direct child on Windows; /T terminates
      // the entire tree so the inner bun runtime does not become an orphan.
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(apiProc.pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      process.kill(-apiProc.pid, "SIGKILL");
    }
  } catch {
    /* already dead */
  }
}

// SIGINT (Ctrl+C) and SIGTERM bypass finally blocks in Bun - register explicit
// handlers so the port is freed even when the run is interrupted.
process.once("SIGINT", () => {
  killApiServer();
  process.exit(130);
});
process.once("SIGTERM", () => {
  killApiServer();
  process.exit(143);
});

let exitCode = 0;
try {
  await waitForReady(`http://127.0.0.1:${pwApiPort}/api/health`, 30_000);
  await run(["bun", "x", "vite", "build"], env, 5 * 60_000);
  await run(["bun", "x", "playwright", "test", ...process.argv.slice(2)], env, 25 * 60_000);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  killApiServer();
  try {
    await apiProc.exited;
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(pwDbPath);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(pwKnowledgeDbPath);
  } catch {
    /* already gone */
  }
}

process.exit(exitCode);
