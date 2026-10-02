import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type Daemon = {
  url: string;
  owned: boolean;
  stop: () => void;
  onExit: (cb: () => void) => void;
};

export async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

export async function ensureDaemon(opts: {
  port: number;
  bin: string;
  secret?: string;
  logFile?: string;
  timeoutMs?: number;
}): Promise<Daemon> {
  const url = `http://127.0.0.1:${opts.port}`;
  if (await isHealthy(url)) return { url, owned: false, stop: () => {}, onExit: () => {} };

  if (!existsSync(opts.bin)) throw new Error(`orc binary not found: ${opts.bin}`);

  if (opts.logFile) mkdirSync(dirname(opts.logFile), { recursive: true });
  const logFd = opts.logFile ? openSync(opts.logFile, "a") : null;
  const child = spawn(opts.bin, ["--port", String(opts.port), "daemon", "start"], {
    stdio: logFd === null ? ["ignore", "inherit", "inherit"] : ["ignore", logFd, logFd],
    env: opts.secret ? { ...process.env, ORC_API_SECRET: opts.secret } : process.env,
    windowsHide: true,
  });
  if (logFd !== null) closeSync(logFd);
  const state: { error: Error | null; exited: boolean } = { error: null, exited: false };
  child.once("error", (err) => {
    state.error = err;
  });
  child.once("exit", () => {
    state.exited = true;
  });

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (state.error) throw state.error;
    if (state.exited) {
      throw new Error(
        `orc daemon exited with code ${child.exitCode} - another orc daemon may already be running on a different port`,
      );
    }
    if (await isHealthy(url)) {
      return {
        url,
        owned: true,
        stop: () => child.kill(),
        onExit: (cb) => {
          child.once("exit", cb);
        },
      };
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`orc daemon not healthy on ${url} after ${(opts.timeoutMs ?? 30_000) / 1000}s`);
}
