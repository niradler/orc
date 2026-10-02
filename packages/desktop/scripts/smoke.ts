#!/usr/bin/env bun
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HELP = `Usage: bun scripts/smoke.ts [--app <executable>] [--port 7798] [--cdp-port 9338] [--timeout 90]

Launches the packaged orc desktop app against an empty HOME and checks, end to end:
the bundled daemon starts, the window loads the dashboard, the generated API secret is
enforced, a shell terminal runs, and quitting the app takes the daemon with it.
Exits non-zero on the first failed check.`;

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    port: { type: "string", default: "7798" },
    "cdp-port": { type: "string", default: "9338" },
    timeout: { type: "string", default: "90" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const port = Number(values.port);
const cdpPort = Number(values["cdp-port"]);
const timeoutMs = Number(values.timeout) * 1000;
if (![port, cdpPort, timeoutMs].every((n) => Number.isInteger(n) && n > 0)) {
  console.error("--port, --cdp-port and --timeout must be positive integers");
  process.exit(2);
}

const release = resolve(import.meta.dirname, "../release");
const candidates = [
  join(release, "mac-arm64/orc.app/Contents/MacOS/orc"),
  join(release, "mac/orc.app/Contents/MacOS/orc"),
  join(release, "linux-unpacked/orc"),
  join(release, "linux-arm64-unpacked/orc"),
  join(release, "win-unpacked/orc.exe"),
];
const app = values.app ?? candidates.find((c) => existsSync(c));
if (!app || !existsSync(app)) {
  console.error(
    `packaged app not found; pass --app or build one (tried: ${candidates.join(", ")})`,
  );
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "orc-smoke-"));
mkdirSync(home, { recursive: true });
let child: ChildProcess | null = null;
const win = process.platform === "win32";

function pass(name: string): void {
  console.log(`ok    ${name}`);
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | false>,
  ms: number,
  watchExit = true,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (watchExit && child && child.exitCode !== null) {
      throw new Error(`app exited early with code ${child.exitCode} while waiting for ${label}`);
    }
    const value = await fn().catch(() => null);
    if (value) return value;
    await Bun.sleep(500);
  }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${label}`);
}

async function healthy(): Promise<boolean> {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
  return res.ok;
}

function stopApp(c: ChildProcess, force: boolean): void {
  if (force && win) spawnSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  else if (force) c.kill("SIGKILL");
  else
    spawn(app as string, ["--quit", `--user-data-dir=${join(home, "userdata")}`], {
      stdio: "ignore",
    });
}

async function run(): Promise<void> {
  const args = [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(home, "userdata")}`];
  if (process.platform === "linux") args.push("--no-sandbox");
  child = spawn(app as string, args, {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ORC_API_PORT: String(port),
      ELECTRON_ENABLE_LOGGING: "1",
      ORC_DESKTOP_NO_LOGIN_ITEM: "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  await until("daemon health", healthy, timeoutMs);
  pass(`daemon healthy on ${base}`);

  const page = await until(
    "window on the dashboard",
    async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as {
        type: string;
        url: string;
      }[];
      return targets.find((t) => t.type === "page" && t.url.startsWith(base)) ?? null;
    },
    timeoutMs,
  );
  pass(`window loaded ${page.url}`);

  const config = JSON.parse(readFileSync(join(home, ".orc", "config.json"), "utf-8")) as {
    api?: { secret?: string };
  };
  const secret = config.api?.secret;
  if (!secret || secret.length < 32) throw new Error("no generated api.secret in the config");
  pass("api.secret generated and saved");

  const cli = join(home, ".orc", "bin", win ? "orc.exe" : "orc");
  const version = spawnSync(cli, ["--version"], { encoding: "utf-8" });
  if (version.status !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout.trim())) {
    throw new Error(`installed CLI ${cli} gave status ${version.status}: ${version.stdout}`);
  }
  pass(`orc CLI installed (${version.stdout.trim()})`);
  if (!win) {
    const link = join(home, ".local", "bin", "orc");
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a symlink`);
    const linked = spawnSync(link, ["--version"], { encoding: "utf-8" });
    if (linked.stdout.trim() !== version.stdout.trim())
      throw new Error("PATH link does not run orc");
    pass("orc linked into ~/.local/bin");
  }

  const log = join(home, ".orc", "desktop-daemon.log");
  if (!existsSync(log) || statSync(log).size === 0) throw new Error("daemon log is empty");
  pass("daemon output written to ~/.orc/desktop-daemon.log");

  const anon = await fetch(`${base}/api/terminals`);
  if (anon.status !== 401) throw new Error(`unauthenticated /api/terminals gave ${anon.status}`);
  pass("unauthenticated request rejected (401)");

  const auth = { Authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const created = await fetch(`${base}/api/terminals`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ kind: "shell", name: "smoke" }),
  });
  const terminal = (await created.json()) as { id?: string; status?: string; error?: string };
  if (created.status !== 201 || terminal.status !== "running") {
    throw new Error(`terminal create gave ${created.status}: ${JSON.stringify(terminal)}`);
  }
  pass("shell terminal running");
  const removed = await fetch(`${base}/api/terminals/${terminal.id}`, {
    method: "DELETE",
    headers: auth,
  });
  if (removed.status !== 204) throw new Error(`terminal delete gave ${removed.status}`);
  pass("shell terminal removed");

  stopApp(child, false);
  await until(
    "app exit",
    async () => (child && child.exitCode !== null) || child?.signalCode != null,
    20_000,
    false,
  );
  pass("app exited on a graceful stop");
  await until("daemon to stop", async () => !(await healthy().catch(() => false)), 15_000, false);
  pass("daemon stopped with the app");
}

try {
  await run();
  console.log("smoke passed");
} catch (err) {
  console.error(`FAIL  ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) stopApp(child, true);
  rmSync(home, { recursive: true, force: true });
}
