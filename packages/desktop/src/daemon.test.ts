import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, type DaemonRuntime, writeDaemonRuntime } from "@orc/core/daemon-runtime";
import { ORC_VERSION } from "@orc/core/version";
import { type Daemon, ensureDaemon, isHealthy } from "./daemon.js";

const directories: string[] = [];
const servers: { stop: () => void }[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  for (const daemon of daemons) {
    if (!daemon.owned) continue;
    const exited = new Promise<void>((resolve) => daemon.onExit(resolve));
    daemon.stop();
    await exited;
  }
  daemons.length = 0;
  for (const s of servers) s.stop();
  servers.length = 0;
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  directories.length = 0;
});

function fixture(): {
  directory: string;
  dbPath: string;
  configPath: string;
  version: string;
  bin: string;
  timeoutMs: number;
  secret: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "orc-desktop-"));
  directories.push(directory);
  return {
    directory,
    dbPath: join(directory, "orc.db"),
    configPath: join(directory, "config.json"),
    version: ORC_VERSION,
    bin: join(directory, "missing"),
    timeoutMs: 2000,
    secret: "",
  };
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function health(instanceId: string): object {
  return {
    status: "ok",
    version: ORC_VERSION,
    instance_id: instanceId,
    uptime: 1,
    restart_supported: true,
    agent_loop: { enabled: false, poll_interval_minutes: 5, max_workers: 1 },
  };
}

function runningServer(
  options: ReturnType<typeof fixture>,
  overrides: Partial<DaemonRuntime> = {},
  secret?: string,
): { port: number; record: DaemonRuntime; credentials: string[] } {
  const instanceId = randomUUID();
  const credentials: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const credential = request.headers.get("authorization");
      if (credential) credentials.push(credential);
      if (new URL(request.url).pathname === "/api/health") return Response.json(health(instanceId));
      if (secret && credential !== `Bearer ${secret}`)
        return new Response("Unauthorized", { status: 401 });
      return Response.json({
        version: ORC_VERSION,
        instance_id: instanceId,
        data_dir: options.directory,
      });
    },
  });
  servers.push(server);
  const record = {
    pid: process.pid,
    port: server.port as number,
    version: ORC_VERSION,
    instance_id: instanceId,
    db_path: canonicalPath(options.dbPath),
    config_path: canonicalPath(options.configPath),
    auth_enabled: Boolean(secret),
    started_at: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(join(options.directory, "daemon.pid"), String(record.pid));
  writeDaemonRuntime(record, options.directory);
  return { port: server.port as number, record, credentials };
}

function fakeBin(
  options: ReturnType<typeof fixture>,
  body?: string,
): { bin: string; binArgs: string[] } {
  const path = join(options.directory, "serve.ts");
  const runtimeModule = join(import.meta.dir, "../../core/src/daemon-runtime.ts");
  writeFileSync(
    path,
    body ??
      `
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {canonicalPath,writeDaemonRuntime,clearDaemonRuntime} from ${JSON.stringify(runtimeModule)};
const instanceId=crypto.randomUUID();
const port=Number(process.argv[process.argv.indexOf("--port")+1]);
const secret=process.env.ORC_API_SECRET;
const server=Bun.serve({port,hostname:"127.0.0.1",fetch(req){
 if(new URL(req.url).pathname==="/api/health") return Response.json({...${JSON.stringify(health("INSTANCE"))},instance_id:instanceId});
 if(secret && req.headers.get("authorization")!=="Bearer "+secret) return new Response("Unauthorized",{status:401});
 return Response.json({version:${JSON.stringify(ORC_VERSION)},instance_id:instanceId,data_dir:${JSON.stringify(options.directory)}});
}});
writeFileSync(join(process.env.ORC_HOME,"daemon.pid"),String(process.pid));
writeDaemonRuntime({pid:process.pid,port:server.port,instance_id:instanceId,version:${JSON.stringify(ORC_VERSION)},
db_path:canonicalPath(${JSON.stringify(options.dbPath)}),config_path:canonicalPath(${JSON.stringify(options.configPath)}),
auth_enabled:Boolean(secret),started_at:new Date().toISOString(),launch_id:process.env.ORC_DESKTOP_LAUNCH_ID},process.env.ORC_HOME);
const stop=()=>{clearDaemonRuntime(instanceId,process.env.ORC_HOME);server.stop(true);process.exit(0)};
process.on("SIGTERM",stop);
process.on("message",message=>{if(message?.type==="orc-shutdown")stop()});
`,
  );
  return { bin: process.execPath, binArgs: [path] };
}

describe("ensureDaemon", () => {
  test("should not attach to an unrelated service that reports status ok", async () => {
    const options = fixture();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ status: "ok" }),
    });
    servers.push(server);
    await expect(ensureDaemon({ ...options, port: server.port as number })).rejects.toThrow(
      "orc binary not found",
    );
  });
  test("attaches to a healthy daemon without spawning", async () => {
    const options = fixture();
    const server = runningServer(options);
    const daemon = await ensureDaemon({
      ...options,
      port: server.port,
    });
    expect(daemon.owned).toBe(false);
    expect(daemon.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("spawns the binary with --port when nothing is listening, and stop() kills it", async () => {
    const options = fixture();
    const port = freePort();
    const daemon = await ensureDaemon({
      ...options,
      ...fakeBin(options),
      port,
      secret: "s3cret",
      timeoutMs: 10_000,
    });
    daemons.push(daemon);
    expect(daemon.owned).toBe(true);
    expect((await fetch(`${daemon.url}/api/system/about`)).status).toBe(401);
    expect(
      (
        await fetch(`${daemon.url}/api/system/about`, {
          headers: { Authorization: "Bearer s3cret" },
        })
      ).status,
    ).toBe(200);
    expect(await isHealthy(daemon.url)).toBe(true);
    const exited = new Promise<void>((resolve) => daemon.onExit(resolve));
    daemon.stop();
    await exited;
    daemons.length = 0;
    for (let i = 0; i < 20 && (await isHealthy(daemon.url)); i++) await Bun.sleep(100);
    expect(await isHealthy(daemon.url)).toBe(false);
  });

  test("throws when the binary exits before becoming healthy", async () => {
    const options = fixture();
    await expect(
      ensureDaemon({
        ...options,
        ...fakeBin(options, "process.exit(3);"),
        port: freePort(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("exited with code 3");
  });

  test("throws when the binary is missing", async () => {
    const options = fixture();
    await expect(
      ensureDaemon({
        ...options,
        port: freePort(),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("orc binary not found");
  });

  test("should select another port without sending credentials to an unrelated listener", async () => {
    const options = fixture();
    const credentials: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (request.headers.has("authorization"))
          credentials.push(request.headers.get("authorization") ?? "");
        return Response.json({ status: "ok" });
      },
    });
    servers.push(server);
    const daemon = await ensureDaemon({
      ...options,
      ...fakeBin(options),
      port: server.port as number,
      secret: "test-secret",
    });
    daemons.push(daemon);
    expect(daemon.owned).toBe(true);
    expect(new URL(daemon.url).port).not.toBe(String(server.port));
    expect(await isHealthy(daemon.url)).toBe(true);
    expect(credentials).toEqual([]);
    const reused = await ensureDaemon({
      ...options,
      port: server.port as number,
      secret: "test-secret",
    });
    expect(reused.url).toBe(daemon.url);
    expect(reused.owned).toBe(false);
    reused.stop();
    expect(await isHealthy(daemon.url)).toBe(true);
  });

  test("should reject a different database before sending credentials", async () => {
    const options = fixture();
    const server = runningServer(options, {
      db_path: canonicalPath(join(options.directory, "other.db")),
    });
    await expect(
      ensureDaemon({ ...options, port: server.port, secret: "test-secret" }),
    ).rejects.toThrow("different data");
    expect(server.credentials).toEqual([]);
  });

  test("should reject an incompatible version before sending credentials", async () => {
    const options = fixture();
    const server = runningServer(options, { version: "99.0.0" });
    await expect(
      ensureDaemon({ ...options, port: server.port, secret: "test-secret" }),
    ).rejects.toThrow("incompatible");
    expect(server.credentials).toEqual([]);
  });

  test("should select a free port for a non-HTTP listener", async () => {
    const options = fixture();
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end("not-http");
        },
      },
    });
    servers.push(listener);
    const daemon = await ensureDaemon({ ...options, ...fakeBin(options), port: listener.port });
    daemons.push(daemon);
    expect(new URL(daemon.url).port).not.toBe(String(listener.port));
    expect(daemon.owned).toBe(true);
  });

  test("should recover when another application claims the port during startup", async () => {
    const options = fixture();
    const command = fakeBin(options);
    const path = command.binArgs[0] as string;
    const marker = join(options.directory, "attempt");
    const release = join(options.directory, "release");
    writeFileSync(
      path,
      `
import {existsSync as exists,readFileSync as read,writeFileSync as write} from "node:fs";
const marker=${JSON.stringify(marker)},release=${JSON.stringify(release)};
const attempt=exists(marker)?Number(read(marker,"utf8")):0;write(marker,String(attempt+1));
if(attempt===0) while(!exists(release)) await Bun.sleep(10);
${readFileSync(path, "utf8")}`,
    );
    const port = freePort();
    const logFile = join(options.directory, "startup.log");
    const startup = ensureDaemon({ ...options, ...command, port, timeoutMs: 5000, logFile });
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    const competitor = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response("other application"),
    });
    servers.push(competitor);
    writeFileSync(release, "ready");
    const daemon = await startup;
    daemons.push(daemon);
    expect(daemon.owned).toBe(true);
    expect(new URL(daemon.url).port).not.toBe(String(port));
    expect(readFileSync(marker, "utf8")).toBe("2");
    expect(readFileSync(logFile, "utf8")).toContain("EADDRINUSE");
  });

  test("should reject changed endpoint identity before sending credentials", async () => {
    const options = fixture();
    const server = runningServer(options, { instance_id: randomUUID() });
    await expect(
      ensureDaemon({ ...options, port: server.port, secret: "test-secret" }),
    ).rejects.toThrow("different server");
    expect(server.credentials).toEqual([]);
  });

  test("should reject wrong credentials without starting a second daemon", async () => {
    const options = fixture();
    const server = runningServer(options, {}, "required");
    await expect(ensureDaemon({ ...options, port: server.port, secret: "wrong" })).rejects.toThrow(
      "Cannot authenticate",
    );
    expect(await isHealthy(`http://127.0.0.1:${server.port}`)).toBe(true);
  });

  test("should wait for an existing daemon to publish its runtime record", async () => {
    const options = fixture();
    writeFileSync(join(options.directory, "daemon.pid"), String(process.pid));
    const port = freePort();
    let readyPort = 0;
    const timer = setTimeout(() => {
      readyPort = runningServer(options).port;
    }, 100);
    try {
      const daemon = await ensureDaemon({ ...options, port });
      expect(daemon.owned).toBe(false);
      expect(daemon.url).toBe(`http://127.0.0.1:${readyPort}`);
    } finally {
      clearTimeout(timer);
    }
  });

  test("should report a live unready daemon without starting another", async () => {
    const options = fixture();
    writeFileSync(join(options.directory, "daemon.pid"), String(process.pid));
    await expect(ensureDaemon({ ...options, port: freePort(), timeoutMs: 100 })).rejects.toThrow(
      "second daemon was not started",
    );
  });

  test("should ignore stale PID and metadata", async () => {
    const options = fixture();
    runningServer(options, { pid: 2147483647 });
    const daemon = await ensureDaemon({ ...options, ...fakeBin(options), port: freePort() });
    daemons.push(daemon);
    expect(daemon.owned).toBe(true);
  });

  test("should require a restart for older daemons without sending credentials", async () => {
    const options = fixture();
    const server = runningServer(options, {}, "legacy-secret");
    writeFileSync(join(options.directory, "daemon.json"), "{}");
    await expect(
      ensureDaemon({ ...options, port: server.port, secret: "legacy-secret", timeoutMs: 100 }),
    ).rejects.toThrow("Restart it with the updated ORC");
    expect(server.credentials).toEqual([]);
  });

  test("should bound a child startup timeout and stop the child", async () => {
    const options = fixture();
    await expect(
      ensureDaemon({
        ...options,
        ...fakeBin(options, "setInterval(()=>{},1000);"),
        port: freePort(),
        timeoutMs: 100,
      }),
    ).rejects.toThrow("did not become ready");
  });
});
