/**
 * run-real-agent-demo.ts
 *
 * Self-contained runner for the real-agent lifecycle E2E demo.
 *
 * Boots a temporary ORC daemon (API + task loop) against an isolated temp DB,
 * creates a scope directory whose .mcp.json points at the test daemon (so
 * worker agents call the right API), builds the web UI, runs Playwright, then
 * tears everything down.
 *
 * Requirements
 * ────────────
 *   - claude CLI on PATH, authenticated (Claude Code OAuth or ANTHROPIC_API_KEY)
 *
 * Usage
 * ─────
 *   cd packages/web
 *   bun run scripts/run-real-agent-demo.ts
 *
 *   # Extra playwright args
 *   bun run scripts/run-real-agent-demo.ts -- --headed
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── helpers ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((res) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await Bun.sleep(300);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

// ── layout ───────────────────────────────────────────────────────────────────

// scripts/ lives two levels below repo root (packages/web/scripts)
const repoRoot = resolve(import.meta.dir, "../../..");
const webRoot  = resolve(import.meta.dir, "..");

// ── preflight: claude CLI ─────────────────────────────────────────────────────

const claudePath = Bun.which("claude");
if (!claudePath) {
  console.error("\n  claude CLI not found on PATH. Install Claude Code first.\n");
  process.exit(1);
}
console.log(`  claude CLI: ${claudePath}`);

try {
  const probe = Bun.spawn({
    cmd: ["claude", "-p", "Reply with: ok", "--output-format", "text"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(probe.stdout).text();
  const code = await probe.exited;
  if (code !== 0 || !out.trim()) throw new Error("empty");
  console.log("  claude auth: ok");
} catch {
  console.error("\n  claude CLI not authenticated. Run `claude` to log in first.\n");
  process.exit(1);
}

// ── allocate temp resources ───────────────────────────────────────────────────

const port    = await freePort();
const dbPath  = join(tmpdir(), `orc-demo-${process.pid}.db`);

// Scope directory: worker agents use this as their cwd.
// We write a .mcp.json here that points at the test daemon port so the ORC
// MCP server talks to the right API (not the hardcoded 7700 in the repo root
// .mcp.json that would otherwise be picked up).
const scopeDir = join(tmpdir(), `orc-demo-scope-${process.pid}`);
mkdirSync(scopeDir, { recursive: true });
writeFileSync(
  join(scopeDir, ".mcp.json"),
  JSON.stringify({
    mcpServers: {
      orc: {
        command: "bun",
        args: ["run", join(repoRoot, "packages/cli/dist/index.js"), "mcp"],
        env: {
          ORC_API_BASE: `http://127.0.0.1:${port}`,
        },
      },
    },
  }, null, 2),
);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ORC_API_HOST:                  "127.0.0.1",
  ORC_API_PORT:                  String(port),
  ORC_DB_PATH:                   dbPath,
  ORC_API_SECRET:                "",
  ORC_AGENT_LOOP_ENABLED:        "true",
  ORC_AGENT_LOOP_MAX_WORKERS:    "2",
  ORC_AGENT_LOOP_AUTO_APPROVE:   "true",
  ORC_AGENT_LOOP_POLL_INTERVAL:  "1",
  ORC_AGENT_LOOP_IDLE_TIMEOUT:   "30",
  ORC_GATEWAY_ENABLED:           "0",
  ORC_E2E_CHAT_MOCK:             "0",
  // Playwright helpers
  PW_API_PORT:                   String(port),
  PW_NO_SERVER:                  "1",
  ORC_RUN_DEMOS:                 "1",
  // Passed to the Playwright test so it can set project.scope
  ORC_DEMO_SCOPE_DIR:            scopeDir,
};

// ── start test daemon ─────────────────────────────────────────────────────────

console.log(`\n  Starting test daemon on port ${port}…`);
console.log(`  DB:    ${dbPath}`);
console.log(`  Scope: ${scopeDir}`);

const daemonScript = resolve(import.meta.dir, "test-daemon.ts");
const daemonProc = Bun.spawn({
  cmd: ["bun", daemonScript],
  cwd: repoRoot,
  env,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "ignore",
});

function killDaemon(): void {
  if (daemonProc.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(daemonProc.pid)], {
        stdout: "ignore", stderr: "ignore",
      });
    } else {
      process.kill(-daemonProc.pid, "SIGKILL");
    }
  } catch { /* already dead */ }
}

process.once("SIGINT",  () => { killDaemon(); process.exit(130); });
process.once("SIGTERM", () => { killDaemon(); process.exit(143); });

// ── build + run tests ─────────────────────────────────────────────────────────

let exitCode = 0;
try {
  await waitReady(`http://127.0.0.1:${port}/api/health`, 30_000);
  console.log("  Daemon ready.\n");

  console.log("  Building web UI…");
  const buildProc = Bun.spawn({
    cmd: ["bun", "x", "vite", "build"],
    cwd: webRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await buildProc.exited) !== 0) throw new Error("vite build failed");

  const pwArgs = [
    "bun", "x", "playwright", "test",
    "--grep", "Real Agent",
    ...process.argv.slice(2),
  ];
  console.log(`\n  Running: ${pwArgs.join(" ")}\n`);

  const pwProc = Bun.spawn({
    cmd: pwArgs,
    cwd: webRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await pwProc.exited;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  killDaemon();
  try { await daemonProc.exited; } catch { /* ignore */ }
  try { unlinkSync(dbPath); }        catch { /* gone */ }
  try {
    // scope dir cleanup
    const { rmSync } = await import("node:fs");
    rmSync(scopeDir, { recursive: true, force: true });
  } catch { /* gone */ }
  console.log("\n  Cleanup complete.");
}

process.exit(exitCode);
