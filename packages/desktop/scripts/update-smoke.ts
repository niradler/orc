import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { root: { type: "string" }, installer: { type: "string" }, feed: { type: "string" } },
});
if (!values.root || !values.installer || !values.feed)
  throw new Error(
    "Pass --root <owned fixture root> --installer <old payload> --feed <update directory>",
  );
if (process.platform !== "win32" && process.platform !== "linux")
  throw new Error("Installed update smoke supports Windows and Linux only");
const root = resolve(values.root);
const meta = JSON.parse(readFileSync(join(root, "fixture-owned.json"), "utf8")) as {
  identity: string;
  oldVersion: string;
  newVersion: string;
};
assert(basename(dirname(root)).startsWith("orc-update-e2e-"));
assert(/^orc-update-fixture-[a-f0-9]+$/.test(meta.identity));
assert(/^\d+\.\d+\.\d+$/.test(meta.oldVersion));
assert(/^\d+\.\d+\.\d+$/.test(meta.newVersion));
const installer = resolve(values.installer);
const feed = resolve(values.feed);
function owned(path: string): boolean {
  const child = relative(dirname(root), path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
assert(owned(installer));
assert(owned(feed));
const home = join(root, "home");
const fixtureEnv = { ...process.env };
for (const key of Object.keys(fixtureEnv)) {
  if (/^(ORC_|CLAUDE_|CODEX_|OPENAI_|ANTHROPIC_)|(?:TOKEN|SECRET|API_KEY)$/i.test(key))
    delete fixtureEnv[key];
}
Object.assign(fixtureEnv, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  TEMP: join(home, "tmp"),
  TMP: join(home, "tmp"),
  TMPDIR: join(home, "tmp"),
  ORC_HOME: join(home, ".orc"),
});
for (const key of [
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TEMP",
])
  mkdirSync(fixtureEnv[key] as string, { recursive: true });
const configPath = join(home, ".orc", "config.json");
const privateConfig = JSON.parse(readFileSync(configPath, "utf8"));
const secret: unknown = privateConfig.api?.secret;
assert(typeof secret === "string" && secret.length > 0, "Development authentication is required");

function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const server = createPortProbe();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => accept(address.port));
    });
  });
}

const commands = new Map<string, string[]>();
const requests: string[] = [];
let inventoryActive = 0;
let controlDuringInventory = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/fixture-control") {
    if (request.headers["x-fixture-id"] !== meta.identity) {
      response.writeHead(403).end();
      return;
    }
    if (inventoryActive > 0) controlDuringInventory++;
    response.end(commands.get(url.searchParams.get("version") ?? "")?.shift() ?? "");
    return;
  }
  const name = basename(url.pathname);
  const path = join(feed, name);
  if (
    !/\.(?:exe|AppImage|blockmap|yml)$/.test(name) ||
    !existsSync(path) ||
    !statSync(path).isFile()
  ) {
    response.writeHead(404).end();
    return;
  }
  requests.push(name);
  const size = statSync(path).size;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : size - 1;
  if (start > end || start < 0 || end >= size) {
    response.writeHead(416).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    "content-type": name.endsWith(".yml") ? "application/yaml" : "application/octet-stream",
    "content-length": end - start + 1,
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  createReadStream(path, { start, end }).pipe(response);
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
assert(address && typeof address !== "string" && address.address === "127.0.0.1");
const apiPort = await freePort();
const runId = randomUUID();
const resultPath = join(root, "result.json");
writeFileSync(resultPath, JSON.stringify({ passed: false, runId }));
writeFileSync(
  join(root, "fixture-owned.json"),
  JSON.stringify({ ...meta, apiPort, feedPort: address.port, runId }),
);
const base = `http://127.0.0.1:${apiPort}`;
const eventsPath = join(root, "events.jsonl");
const events = (): Record<string, unknown>[] =>
  existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.runId === runId)
    : [];
const queue = (version: string, command: string) =>
  commands.set(version, [...(commands.get(version) ?? []), command]);
const delay = (ms: number) => new Promise((accept) => setTimeout(accept, ms));
async function until<T>(
  name: string,
  read: () => T | false | null | Promise<T | false | null>,
  timeout = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result) return result;
    } catch {
      // A process transition can temporarily leave no runtime record or API listener.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${name}`);
}
async function api(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${method} ${path} returned ${response.status}`);
  return response.json();
}
const normalize = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const daemonPids = new Set<number>();
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function inventory(command: string, args: string[]): Promise<string> {
  inventoryActive++;
  return new Promise((accept, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        inventoryActive--;
        if (error) reject(error);
        else accept(stdout);
      },
    );
  });
}
async function listenerAddresses(): Promise<string[]> {
  const probe =
    process.platform === "win32"
      ? await inventory("powershell.exe", [
          "-NoProfile",
          "-Command",
          `ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ${apiPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress)`,
        ])
      : await inventory("ss", ["-H", "-ltn", "sport", "=", `:${apiPort}`]);
  return process.platform === "win32"
    ? JSON.parse(probe || "[]")
    : probe
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (line.split(/\s+/)[3] ?? "").replace(/:\d+$/, ""));
}
function withinRoot(path: string): boolean {
  const child = relative(root, resolve(path));
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function verifiedProcess(pid: number): Promise<boolean> {
  assert(Number.isSafeInteger(pid) && pid > 0);
  if (!alive(pid)) return false;
  try {
    if (process.platform === "win32") {
      const probe = await inventory("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`,
      ]);
      return !!probe.trim() && withinRoot(probe.trim());
    }
    const executable = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
    if (withinRoot(executable)) return true;
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return (
      (basename(executable) === meta.identity || basename(executable) === "orc") &&
      environment.includes(`ORC_HOME=${join(home, ".orc")}`) &&
      environment.some((entry) => entry.startsWith(`APPIMAGE=${join(root, "install")}${sep}`))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function identity(version: string): Promise<Record<string, unknown>> {
  const about = await api("/system/about");
  assert.equal(about.version, version);
  assert.equal(normalize(String(about.data_dir)), normalize(join(home, ".orc")));
  const runtime = JSON.parse(readFileSync(join(home, ".orc", "daemon.json"), "utf8"));
  assert.equal(runtime.version, version);
  assert.equal(normalize(runtime.db_path), normalize(join(home, ".orc", "orc.db")));
  assert.equal(normalize(runtime.config_path), normalize(configPath));
  assert.equal(runtime.auth_enabled, true);
  assert(
    Number.isSafeInteger(runtime.pid) && runtime.pid > 0 && alive(runtime.pid),
    "Private daemon PID is not alive",
  );
  assert(await verifiedProcess(runtime.pid), "Daemon executable is outside the private fixture");
  assert.equal(about.instance_id, runtime.instance_id);
  const listeners = await listenerAddresses();
  assert(
    listeners.length > 0 && listeners.every((address) => address === "127.0.0.1"),
    "Private API is not loopback-only",
  );
  daemonPids.add(runtime.pid);
  assert.equal(
    (await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(2000) })).status,
    401,
  );
  return runtime;
}

let app: ReturnType<typeof spawn> | undefined;
let result: Record<string, unknown> | undefined;
const installDirectory = join(root, "install");
try {
  mkdirSync(installDirectory, { recursive: true });
  if (process.platform === "win32") {
    const installed = spawnSync(installer, ["/S", `/D=${installDirectory}`], {
      env: fixtureEnv,
      timeout: 120_000,
      windowsHide: true,
    });
    assert.equal(installed.status, 0, "Initial fixture installation failed");
    const executable = join(installDirectory, `${meta.identity}.exe`);
    assert(existsSync(executable));
    app = spawn(executable, [], { env: fixtureEnv, stdio: "inherit", windowsHide: true });
  } else {
    const installed = join(installDirectory, basename(installer));
    copyFileSync(installer, installed);
    chmodSync(installed, 0o755);
    app = spawn(installed, ["--no-sandbox"], {
      env: { ...fixtureEnv, APPIMAGE_EXTRACT_AND_RUN: "1", ELECTRON_DISABLE_SANDBOX: "1" },
      stdio: "inherit",
    });
  }
  await until("old packaged window", () =>
    events().find((e) => e.event === "window-ready" && e.version === meta.oldVersion),
  );
  const previous = await identity(meta.oldVersion);
  const task = await api("/tasks", "POST", {
    title: "Update fixture task",
    body: "Task data must survive replacement",
    status: "todo",
  });
  const streamed = await fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      agent: "codex",
      messages: [{ role: "user", content: "Reply with exactly: UPDATE-MARKER." }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(streamed.status, 200);
  assert((await streamed.text()).includes("UPDATE-MARKER"));
  const list = await api("/chat/threads");
  const thread = (list.threads as { id: string }[])[0];
  assert(thread);
  const beforeTask = await api(`/tasks/${task.id}`);
  const beforeThread = await api(`/chat/threads/${thread.id}`);
  const configBefore = readFileSync(configPath, "utf8");
  queue(meta.oldVersion, "check");
  await until(
    "real update download",
    () => events().find((e) => e.event === "downloaded" && e.version === meta.oldVersion),
    180_000,
  );
  queue(meta.oldVersion, "install");
  await until(
    "new packaged window",
    () => events().find((e) => e.event === "window-ready" && e.version === meta.newVersion),
    180_000,
  );
  const next = await identity(meta.newVersion);
  assert(
    !events().some((event) =>
      ["startup-error", "recovery-dialog", "update-error", "control-error"].includes(
        String(event.event),
      ),
    ),
    "The update triggered an error or recovery dialog",
  );
  assert.notEqual(next.pid, previous.pid, "Owned daemon did not restart");
  assert.throws(() => process.kill(Number(previous.pid), 0), "Previous owned daemon remains alive");
  assert.deepEqual(await api(`/tasks/${task.id}`), beforeTask);
  assert.deepEqual(await api(`/chat/threads/${thread.id}`), beforeThread);
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  if (process.platform === "win32")
    assert(controlDuringInventory > 0, "Fixture control was not served during OS inventory");
  assert(
    requests.some((name) => /\.(exe|AppImage)$/.test(name)),
    "No update payload was served",
  );
  result = {
    passed: true,
    runId,
    platform: process.platform,
    from: meta.oldVersion,
    to: meta.newVersion,
    realPackagedInstaller: true,
    oldDaemonStopped: true,
    newDaemonStarted: true,
    taskPreserved: true,
    sessionPreserved: true,
    anonymous401: true,
    authenticated200: true,
    configPreserved: true,
    controlRequestsDuringInventory: controlDuringInventory,
    previousDaemonPid: previous.pid,
    nextDaemonPid: next.pid,
    requests,
    taskId: task.id,
    threadId: thread.id,
    limitation: "Loopback generic feed replaces GitHub discovery only in the fixture bootstrap",
  };
} finally {
  queue(meta.oldVersion, "quit");
  queue(meta.newVersion, "quit");
  const ownedPids = () =>
    new Set([
      ...daemonPids,
      ...(app?.pid && app.exitCode === null && app.signalCode === null ? [app.pid] : []),
      ...events()
        .filter((event) => event.event === "started")
        .map((event) => Number(event.pid)),
    ]);
  const stopped = async () =>
    [...ownedPids()].every((pid) => !alive(pid)) && (await listenerAddresses()).length === 0;
  try {
    try {
      await until("fixture apps, daemons and listener shutdown", stopped, 20_000);
    } catch {
      const runtimePath = join(home, ".orc", "daemon.json");
      if (existsSync(runtimePath)) {
        const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
        assert.equal(normalize(runtime.db_path), normalize(join(home, ".orc", "orc.db")));
        assert.equal(normalize(runtime.config_path), normalize(configPath));
        assert(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
        if (alive(runtime.pid)) {
          assert(await verifiedProcess(runtime.pid), "Refusing to stop an unverified daemon");
          daemonPids.add(runtime.pid);
        }
      }
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const pid of ownedPids()) {
          if (!alive(pid)) continue;
          assert(
            (pid === app?.pid && app.exitCode === null && app.signalCode === null) ||
              (await verifiedProcess(pid)),
            "Refusing to stop an unverified fixture process",
          );
          process.kill(pid, signal);
        }
        try {
          await until("verified fixture process exit", stopped, 10_000);
          break;
        } catch {
          // A final assertion below reports a process that survived both bounded stops.
        }
      }
    }
    assert(await stopped(), "Fixture processes or listener survived teardown");
    if (result) result.teardownVerified = true;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
}
if (result) {
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(
    `PASS ${process.platform}: packaged ${meta.oldVersion} -> ${meta.newVersion}; daemon, tasks, session and auth preserved`,
  );
}
