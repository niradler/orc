import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stopOwnedProcess } from "./stop-process";

const commands = new Set<Bun.Subprocess>();

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
  const exitCode = await runExit(cmd, env, timeoutMs);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited with code ${exitCode}`);
  }
}

const playwrightArgs = process.argv.slice(2);

function shardCount(playwrightArguments: string[]): number {
  if (
    playwrightArguments.includes("--ui") ||
    playwrightArguments.some((argument) => argument.startsWith("--shard"))
  ) {
    return 1;
  }
  if (process.env.PW_SHARDS) {
    const count = Number(process.env.PW_SHARDS);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`PW_SHARDS must be a positive integer, got ${process.env.PW_SHARDS}`);
    }
    return count;
  }
  if (
    playwrightArguments.some((argument) => argument === "--grep" || argument.startsWith("--grep="))
  ) {
    return 1;
  }
  return 4;
}

// Isolate ORC state without hiding the browser installed before this process starts.
const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")),
    "ms-playwright",
  );

type Shard = {
  port: string;
  dbPath: string;
  home: string;
  env: Record<string, string>;
  api: Bun.Subprocess | undefined;
};

async function createShard(index: number): Promise<Shard> {
  const port = process.env.PW_API_PORT ?? String(await freePort());
  await assertPortFree(Number(port));
  const home = mkdtempSync(join(tmpdir(), "orc-pw-home-"));
  const dbPath = process.env.PW_DB_PATH ?? join(home, "state.db");
  if (process.env.PW_DB_PATH && existsSync(dbPath)) {
    rmSync(home, { recursive: true, force: true });
    throw new Error("PW_DB_PATH must name a new test database; existing paths are never adopted");
  }
  return {
    port,
    dbPath,
    home,
    api: undefined,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      PLAYWRIGHT_BROWSERS_PATH: browserCache,
      ORC_API_HOST: "127.0.0.1",
      PW_API_PORT: port,
      PW_DB_PATH: dbPath,
      ORC_API_PORT: port,
      ORC_DB_PATH: dbPath,
      ORC_KNOWLEDGE_ROOT: join(home, "knowledge"),
      ORC_API_SECRET: "dev",
      ORC_E2E_CHAT_MOCK: "1",
      ORC_TERMINALS_ENABLED: "1",
      ORC_TERMINALS_ALLOW_WITHOUT_SECRET: "1",
      PW_NO_SERVER: "1",
      PW_OUTPUT_DIR: join(import.meta.dir, "../test-results", `shard-${index + 1}`),
    },
  };
}

async function runExit(
  cmd: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<number> {
  const proc = Bun.spawn({
    cmd,
    cwd: `${import.meta.dir}/..`,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  commands.add(proc);
  const timeout = setTimeout(() => void stopOwnedProcess(proc), timeoutMs);
  try {
    return await proc.exited;
  } finally {
    clearTimeout(timeout);
    commands.delete(proc);
  }
}

const count = shardCount(playwrightArgs);
const explicitPort = process.env.PW_API_PORT;
const explicitDb = process.env.PW_DB_PATH;
if (count > 1 && (explicitPort || explicitDb)) {
  throw new Error("PW_SHARDS greater than 1 cannot share PW_API_PORT or PW_DB_PATH");
}
if (count > 1 && playwrightArgs.some((argument) => argument.startsWith("--output"))) {
  throw new Error(
    "Parallel shards need separate output directories; omit --output or use PW_SHARDS=1",
  );
}
const shards: Shard[] = [];

async function cleanup(): Promise<void> {
  const failures: unknown[] = [];
  const stops = await Promise.allSettled([
    ...[...commands].map((command) => stopOwnedProcess(command)),
    ...shards.flatMap((shard) => (shard.api ? [stopOwnedProcess(shard.api)] : [])),
  ]);
  for (const result of stops) if (result.status === "rejected") failures.push(result.reason);
  for (const shard of shards) {
    try {
      if (shard.api) await shard.api.exited;
      if (explicitDb)
        rmSync(shard.dbPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(shard.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Browser fixture cleanup failed");
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)
  process.once(signal, async () => {
    await cleanup();
    process.exit(code);
  });

const repoRoot = join(import.meta.dir, "../../..");
let exitCode = 0;
try {
  for (let index = 0; index < count; index += 1) shards.push(await createShard(index));
  const buildShard = shards[0];
  if (!buildShard) throw new Error("No browser shard was created");
  // One production build is shared. Each shard then gets its own API and database
  // so browser workers do not write one SQLite file at the same time.
  await run(["bun", "x", "vite", "build"], buildShard.env, 5 * 60_000);
  for (const shard of shards) {
    shard.api = Bun.spawn({
      cmd: ["bun", "packages/api/src/index.ts"],
      cwd: repoRoot,
      env: shard.env,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
  }
  await Promise.all(
    shards.map((shard) => waitForReady(`http://127.0.0.1:${shard.port}/api/health`, 30_000)),
  );
  console.log(`Browser shards: ${shards.length} (${shards.map((shard) => shard.port).join(", ")})`);
  const results = await Promise.all(
    shards.map((shard, index) => {
      const shardArgs =
        shards.length === 1
          ? playwrightArgs
          : [...playwrightArgs, `--shard=${index + 1}/${shards.length}`];
      return runExit(["bun", "x", "playwright", "test", ...shardArgs], shard.env, 25 * 60_000);
    }),
  );
  if (results.some((code) => code !== 0)) exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await cleanup();
}

process.exit(exitCode);
