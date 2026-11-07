import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { activeDaemonPid, readDaemonRuntime } from "@orc/core/daemon-runtime";
import { ORC_VERSION } from "@orc/core/version";
import { type Daemon, ensureDaemon } from "./daemon.js";

test("should start the actual CLI daemon on an OS-selected port and reuse it securely", async () => {
  const home = mkdtempSync(join(tmpdir(), "orc-desktop-integration-"));
  const directory = join(home, ".orc");
  mkdirSync(directory);
  const configPath = join(directory, "config.json");
  const dbPath = join(directory, "orc.db");
  writeFileSync(
    configPath,
    JSON.stringify({ db: { path: dbPath }, agent_loop: { enabled: false } }),
  );
  const entry = join(home, "launch.ts");
  const cli = join(import.meta.dir, "../../cli/src/index.ts");
  writeFileSync(
    entry,
    `
const keep=new Set(["ORC_HOME","ORC_API_SECRET","ORC_DESKTOP_LAUNCH_ID","ORC_SUPERVISED_SERVER"]);
for(const key of Object.keys(process.env)) if(key.startsWith("ORC_")&&!keep.has(key)) delete process.env[key];
process.env.HOME=${JSON.stringify(home)};
process.env.USERPROFILE=${JSON.stringify(home)};
process.env.ORC_DB_PATH=${JSON.stringify(dbPath)};
process.chdir(${JSON.stringify(home)});
await import(${JSON.stringify(cli)});
`,
  );
  const occupied = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("unrelated"),
  });
  let daemon: Daemon | undefined;
  try {
    const options = {
      directory,
      configPath,
      dbPath,
      version: ORC_VERSION,
      port: occupied.port as number,
      bin: process.execPath,
      binArgs: [entry],
      secret: "isolated-desktop-test-secret",
      timeoutMs: 20000,
      logFile: join(home, "daemon.log"),
    };
    try {
      daemon = await ensureDaemon(options);
    } catch (error) {
      throw new Error(`${String(error)}\n${readFileSync(options.logFile, "utf8")}`);
    }
    expect(daemon.owned).toBe(true);
    expect(new URL(daemon.url).hostname).toBe("127.0.0.1");
    expect(new URL(daemon.url).port).not.toBe(String(occupied.port));
    expect(readDaemonRuntime(directory)?.port).toBe(Number(new URL(daemon.url).port));
    expect((await fetch(`${daemon.url}/api/system/about`)).status).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/api/system/about`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/api/system/about`, {
          headers: { Authorization: `Bearer ${options.secret}` },
        })
      ).status,
    ).toBe(200);
    const reused = await ensureDaemon({ ...options, bin: join(home, "missing") });
    expect(reused.owned).toBe(false);
    expect(reused.url).toBe(daemon.url);
    reused.stop();
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
  } finally {
    if (daemon) {
      const exited = new Promise<void>((resolve) => daemon?.onExit(resolve));
      daemon.stop();
      await exited;
    }
    const deadline = Date.now() + 15000;
    while (activeDaemonPid(directory) && Date.now() < deadline) await sleep(100);
    occupied.stop(true);
    try {
      expect(activeDaemonPid(directory)).toBeNull();
      expect(readDaemonRuntime(directory)).toBeNull();
      expect(existsSync(join(directory, "daemon.json"))).toBe(false);
    } finally {
      if (!activeDaemonPid(directory))
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}, 45000);
