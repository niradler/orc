import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { globalConfigPath, loadConfig } from "@orc/core/config";
import {
  activeDaemonPid,
  canonicalPath,
  type DaemonRuntime,
  daemonHome,
  readDaemonRuntime,
} from "@orc/core/daemon-runtime";
import { ORC_VERSION } from "@orc/core/version";

export type Daemon = {
  url: string;
  owned: boolean;
  stop: () => void | Promise<void>;
  onExit: (cb: () => void) => void;
};

type Health = { status: "ok"; version: string; instance_id: string };

async function readJson(url: string, secret?: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readHealth(url: string): Promise<Health | null> {
  const body = await readJson(`${url}/api/health`);
  if (
    body?.status !== "ok" ||
    typeof body.version !== "string" ||
    typeof body.instance_id !== "string" ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.instance_id) ||
    typeof body.uptime !== "number" ||
    typeof body.restart_supported !== "boolean" ||
    !body.agent_loop ||
    typeof body.agent_loop !== "object"
  )
    return null;
  return { status: "ok", version: body.version, instance_id: body.instance_id };
}

export async function isHealthy(url: string): Promise<boolean> {
  return (await readHealth(url)) !== null;
}

function compatibleVersion(server: string, desktop: string): boolean {
  return (
    /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(server) &&
    server.split(".").slice(0, 2).join(".") === desktop.split(".").slice(0, 2).join(".")
  );
}

async function availablePort(port: number): Promise<number> {
  if (port === 0) return 0;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(0);
      else reject(error);
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not select a local ORC port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

const unowned = (url: string): Daemon => ({ url, owned: false, stop: () => {}, onExit: () => {} });

export async function ensureDaemon(opts: {
  port: number;
  bin: string;
  binArgs?: string[];
  secret?: string;
  logFile?: string;
  timeoutMs?: number;
  directory?: string;
  dbPath?: string;
  configPath?: string;
  version?: string;
}): Promise<Daemon> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
    throw new Error("ORC API port must be an integer between 1 and 65535");
  const directory = opts.directory ?? daemonHome();
  const dbPath = opts.dbPath ?? loadConfig().db.path;
  const configPath = canonicalPath(opts.configPath ?? globalConfigPath());
  const expectedDb = dbPath === ":memory:" ? dbPath : canonicalPath(dbPath);
  const version = opts.version ?? ORC_VERSION;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const preferredUrl = `http://127.0.0.1:${opts.port}`;

  async function verify(record: DaemonRuntime): Promise<string | null> {
    if (
      record.db_path !== expectedDb ||
      record.config_path !== configPath ||
      expectedDb === ":memory:"
    )
      throw new Error(
        "A running ORC daemon uses different data or configuration. Select the matching ORC configuration before retrying.",
      );
    if (!compatibleVersion(record.version, version))
      throw new Error(
        `Running ORC ${record.version} is incompatible with desktop ${version}. Update ORC before retrying.`,
      );
    const url = `http://127.0.0.1:${record.port}`;
    const health = await readHealth(url);
    if (!health) return null;
    if (health.instance_id !== record.instance_id || health.version !== record.version)
      throw new Error(
        "The ORC port belongs to a different server than its runtime record. Retry when the configured daemon is available.",
      );
    const about = await readJson(`${url}/api/system/about`, opts.secret);
    if (!about)
      throw new Error(
        "Cannot authenticate with the running ORC daemon. Check the configured API secret, then retry.",
      );
    if (
      about.instance_id !== record.instance_id ||
      about.version !== record.version ||
      typeof about.data_dir !== "string" ||
      canonicalPath(about.data_dir) !== dirname(configPath)
    )
      throw new Error("The running ORC server does not match the desktop configuration.");
    return url;
  }

  while (activeDaemonPid(directory)) {
    const record = readDaemonRuntime(directory);
    const url = record ? await verify(record) : null;
    if (url) return unowned(url);
    if (Date.now() >= deadline)
      throw new Error(
        record
          ? "An ORC daemon is already running but is not ready. Check its port and desktop-daemon.log, then retry. A second daemon was not started."
          : "An ORC daemon is already running but did not publish a runtime identity. Restart it with the updated ORC, then retry. A second daemon was not started.",
      );
    await sleep(250);
  }
  if (await readHealth(preferredUrl))
    throw new Error(
      "An ORC server is already using the configured port but its daemon identity cannot be verified. Check its configuration, then retry.",
    );
  if (!existsSync(opts.bin)) throw new Error(`orc binary not found: ${opts.bin}`);
  let port = await availablePort(opts.port);
  for (let attempt = 0; attempt < 3; attempt++) {
    const launchId = randomUUID();
    if (opts.logFile) mkdirSync(dirname(opts.logFile), { recursive: true });
    const logFd = opts.logFile ? openSync(opts.logFile, "a") : null;
    const child = spawn(
      opts.bin,
      [...(opts.binArgs ?? []), "--host", "127.0.0.1", "--port", String(port), "daemon", "start"],
      {
        stdio:
          logFd === null
            ? ["ignore", "inherit", "inherit", "ipc"]
            : ["ignore", logFd, logFd, "ipc"],
        env: {
          ...process.env,
          ORC_HOME: directory,
          ORC_DESKTOP_LAUNCH_ID: launchId,
          ...(opts.secret !== undefined ? { ORC_API_SECRET: opts.secret } : {}),
        },
        windowsHide: true,
      },
    );
    if (logFd !== null) closeSync(logFd);
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    async function stopChild(): Promise<void> {
      if (child.connected)
        child.send({ type: "orc-shutdown" }, (error) => {
          if (error) child.kill();
        });
      else child.kill();
      const force = setTimeout(
        () => child.kill("SIGKILL"),
        Math.min(opts.timeoutMs ?? 10000, 10000),
      );
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
    let retry = false;
    try {
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        const record = readDaemonRuntime(directory);
        if (record) {
          const url = await verify(record);
          if (url) {
            if (record.launch_id !== launchId) {
              await stopChild();
              return unowned(url);
            }
            return {
              url,
              owned: true,
              stop: stopChild,
              onExit: (cb) => {
                if (child.exitCode !== null || child.signalCode !== null) queueMicrotask(cb);
                else child.once("exit", cb);
              },
            };
          }
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          if (activeDaemonPid(directory)) {
            await sleep(250);
            continue;
          }
          const nextPort = await availablePort(port);
          if (nextPort !== port) {
            port = nextPort;
            retry = true;
            break;
          }
          throw new Error(
            `ORC daemon exited with code ${child.exitCode}. Check ${opts.logFile ?? "the daemon log"}, then retry.`,
          );
        }
        await sleep(100);
      }
      if (!retry)
        throw new Error(
          `ORC daemon did not become ready within ${(opts.timeoutMs ?? 30_000) / 1000}s. Check ${opts.logFile ?? "the daemon log"}, then retry.`,
        );
    } catch (error) {
      await stopChild();
      throw error;
    }
  }
  throw new Error(
    "The local ORC port was repeatedly claimed during startup. Retry to select another port.",
  );
}
