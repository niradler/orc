import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function sshScenario(body: string): Promise<void> {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "orc-ssh-lifecycle-"));
  const fake = join(dir, "ssh");
  writeFileSync(
    fake,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const root = process.env.HOME;
const args = process.argv.slice(2);
const state = root + "/master";
const log = (event) => appendFileSync(root + "/events", event + "\\n");
if (args.includes("-O")) {
  const op = args[args.indexOf("-O") + 1];
  if (op === "check") {
    const socket = existsSync(root + "/socket-path") ? (await Bun.file(root + "/socket-path").text()).trim() : "";
    if (socket && existsSync(socket)) {
      console.error("Control socket connect(" + socket + "): Connection refused"); process.exit(255);
    }
    process.exit(existsSync(state) && await Bun.file(state).text() === "up" ? 0 : 1);
  }
  if (op === "exit") { writeFileSync(state, "down"); log("close"); process.exit(0); }
}
if (args.includes("-N")) {
  if (existsSync(root + "/fail-master")) {
    log("master-failed");
    const failure = (await Bun.file(root + "/fail-master").text()).trim();
    console.error(failure === "auth" ? "Permission denied (publickey)." : "kex_exchange_identification: read: Connection reset by peer");
    if (failure === "once") writeFileSync(root + "/fail-master", "recovered");
    if (failure !== "recovered") process.exit(255);
  }
  if (existsSync(root + "/delay-master")) {
    log("master-start");
    while (!existsSync(root + "/release-master")) await Bun.sleep(5);
  }
  writeFileSync(state, "up"); log("master"); process.exit(0);
}
if (args.at(-1).includes("curl")) process.exit(0);
const command = args.at(-1);
if (command.includes("handshake-once")) {
  if (!args.includes("ProxyCommand=false")) throw new Error("Shared fallback must be disabled");
  log("handshake-attempt");
  if (!existsSync(root + "/handshake-failed")) {
    writeFileSync(root + "/handshake-failed", "");
    console.error("Connection closed by UNKNOWN port 65535"); process.exit(255);
  }
  log("executed"); process.exit(0);
}
if (command.includes("handshake-always")) {
  log("handshake-attempt");
  console.error("kex_exchange_identification: Connection closed by remote host"); process.exit(255);
}
if (existsSync(root + "/fail-file-check") && (command.includes("test -f") || command.includes("test -d"))) {
  console.error("Connection reset by peer");
  process.exit(255);
}
if (command.includes("gate-command")) {
  log("gate-start");
  while (!existsSync(root + "/release")) await Bun.sleep(5);
  log("gate-end"); process.exit(0);
}
if (command.includes("failure-fast") || command.includes("failure-slow")) {
  const kind = command.includes("failure-fast") ? "fast" : "slow";
  log(kind + "-start");
  while (!existsSync(root + "/release-" + kind)) await Bun.sleep(5);
  console.error("mux_client_request_session: read from master failed");
  process.exit(255);
}
if (command.includes("queued-command")) { log("queued-ran"); process.exit(0); }
if (!args.at(-1).includes("hold-command") && !args.at(-1).includes("'echo'")) {
  log("start");
  const proc = Bun.spawn(["/bin/sh", "-c", args.at(-1)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const code = await proc.exited;
  log("end");
  process.exit(code);
}
log("start");
await Bun.sleep(args.at(-1).includes("hold-command") ? 500 : 35);
log("end");
console.log("ok");
`,
  );
  chmodSync(fake, 0o755);
  const scenario = join(dir, "scenario.ts");
  const modulePath = resolve(import.meta.dir, "../exec-host.ts");
  writeFileSync(
    scenario,
    `
import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { codexAdapter } from ${JSON.stringify(resolve(import.meta.dir, "../../../api/src/sessions/codex.ts"))};
import { hostExec, hostRuntime, retireSshMaster, trackHostProcess } from ${JSON.stringify(modulePath)};
const host = { kind: "ssh", alias: "fixture", remotePort: 7700,
  apiTarget: "127.0.0.1:7700", secret: undefined, connectTimeoutSecs: 1 };
const logPath = process.env.HOME + "/events";
const events = () => existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
const until = async (check) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("fixture condition timed out");
    await Bun.sleep(5);
  }
};
${body}

`,
  );
  const child = Bun.spawn([process.execPath, scenario], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${dir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toBe("");
}

test(
  "should recover a stale socket before establishing a shared master",
  () =>
    sshScenario(`
const socket = process.env.HOME + "/.orc/ssh/stale";
const { mkdirSync } = await import("node:fs");
mkdirSync(process.env.HOME + "/.orc/ssh", { recursive: true });
const child = Bun.spawn([process.execPath, "-e", 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', socket]);
expect(await child.exited).toBe(0);
expect(existsSync(socket)).toBe(true);
writeFileSync(process.env.HOME + "/socket-path", socket);
expect((await hostExec(host, ["echo", "ok"])).code).toBe(0);
expect(existsSync(socket)).toBe(false);
expect(events().trim().split("\\n").filter(e => e === "master")).toHaveLength(1);
const logs = readFileSync(process.env.HOME + "/.orc/logs/orc.log", "utf8");
expect(logs).toContain("Removed stale SSH control socket");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should share a bounded setup retry across concurrent callers",
  () =>
    sshScenario(`
writeFileSync(process.env.HOME + "/fail-master", "once");
const results = await Promise.all(Array.from({ length: 8 }, () => hostExec(host, ["echo", "ok"])));
expect(results.every(result => result.code === 0)).toBe(true);
expect(events().trim().split("\\n").filter(e => e === "master")).toHaveLength(1);
const logs = readFileSync(process.env.HOME + "/.orc/logs/orc.log", "utf8");
expect(logs).toContain("Retrying SSH connection");
expect(logs).toContain("SSH connection recovered");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should preserve non-socket files and symlinks during stale socket recovery",
  () =>
    sshScenario(`
const { mkdirSync, symlinkSync } = await import("node:fs");
const directory = process.env.HOME + "/.orc/ssh";
mkdirSync(directory, { recursive: true });
const file = directory + "/regular-file";
writeFileSync(file, "preserve");
writeFileSync(process.env.HOME + "/socket-path", file);
await expect(hostExec(host, ["echo", "ok"])).rejects.toThrow("connection sharing");
expect(readFileSync(file, "utf8")).toBe("preserve");
const link = directory + "/symlink";
symlinkSync(file, link);
writeFileSync(process.env.HOME + "/socket-path", link);
await expect(hostExec(host, ["echo", "ok"])).rejects.toThrow("connection sharing");
expect(existsSync(link)).toBe(true);
expect(readFileSync(file, "utf8")).toBe("preserve");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should preserve sockets outside ORC's SSH directory",
  () =>
    sshScenario(`
const socket = process.env.HOME + "/outside";
const child = Bun.spawn([process.execPath, "-e", 'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', socket]);
expect(await child.exited).toBe(0);
writeFileSync(process.env.HOME + "/socket-path", socket);
await expect(hostExec(host, ["echo", "ok"])).rejects.toThrow("connection sharing");
expect(existsSync(socket)).toBe(true);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should bound setup retries and fail authentication immediately",
  () =>
    sshScenario(`
writeFileSync(process.env.HOME + "/fail-master", "always");
await expect(hostExec(host, ["echo", "ok"])).rejects.toThrow("Connection reset");
expect(events().trim().split("\\n").filter(e => e === "master-failed")).toHaveLength(3);
writeFileSync(process.env.HOME + "/fail-master", "auth");
await expect(hostExec(host, ["echo", "ok"])).rejects.toThrow("rejected the login");
expect(events().trim().split("\\n").filter(e => e === "master-failed")).toHaveLength(4);
expect(events()).not.toContain("start\\n");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should reconnect a failed handshake without a second caller action",
  () =>
    sshScenario(`
const result = await hostExec(host, ["handshake-once", "private-command-argument"], { env: { PRIVATE_TOKEN: "private-value" } });
expect(result.code).toBe(0);
expect(events().trim().split("\\n").filter(e => e === "handshake-attempt")).toHaveLength(2);
expect(events().trim().split("\\n").filter(e => e === "executed")).toHaveLength(1);
const logs = readFileSync(process.env.HOME + "/.orc/logs/orc.log", "utf8");
expect(logs).toContain("SSH command connection recovered");
expect(logs).not.toContain("private-command-argument");
expect(logs).not.toContain("private-value");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "should bound command recovery and preserve the original deadline",
  () =>
    sshScenario(`
expect((await hostExec(host, ["handshake-always"])).code).toBe(255);
expect(events().trim().split("\\n").filter(e => e === "handshake-attempt")).toHaveLength(3);
await expect(hostExec(host, ["handshake-always"], { timeoutMs: 100 })).rejects.toThrow("timed out");
expect(events().trim().split("\\n").filter(e => e === "handshake-attempt")).toHaveLength(4);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "shares bounded SSH channels and discovers Codex sessions",
  () =>
    sshScenario(`
const results = await Promise.all(Array.from({length: 24}, () => hostExec(host, ["echo", "ok"])));
expect(results.every(r => r.code === 0 && r.stdout.trim() === "ok")).toBe(true);
let active = 0, peak = 0;
const initialEvents = readFileSync(logPath, "utf8").trim().split("\\n");
expect(initialEvents.filter(e => e === "master").length).toBe(1);
for (const event of initialEvents) {
  if (event === "start") peak = Math.max(peak, ++active);
  if (event === "end") active--;
}
expect(peak).toBeGreaterThan(1);
expect(peak).toBeLessThanOrEqual(8);
expect(active).toBe(0);
let finish;
trackHostProcess(host.alias, new Promise(resolve => { finish = resolve; }));
const command = hostExec(host, ["hold-command"]);
const deadline = Date.now() + 5000;
while (!readFileSync(logPath, "utf8").endsWith("start\\n")) {
  if (Date.now() > deadline) throw new Error("command did not start");
  await Bun.sleep(5);
}
await retireSshMaster(host.alias);
finish();
await Bun.sleep(50);
expect(readFileSync(process.env.HOME + "/master", "utf8")).toBe("up");
expect((await command).code).toBe(0);
await retireSshMaster(host.alias);
expect(readFileSync(process.env.HOME + "/master", "utf8")).toBe("down");
const dbPath = process.env.HOME + "/state.sqlite";
const historyPath = process.env.HOME + "/history.sqlite";
const db = new Database(dbPath);
db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT, created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER)");
const history = new Database(historyPath);
history.exec("CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER)");
for (let i = 0; i < 35; i++) {
  const path = process.env.HOME + "/rollout-" + i;
  writeFileSync(path, "{}");
  db.run("INSERT INTO threads VALUES (?, ?, NULL, ?, '', '', 1, ?, NULL, 1, NULL, 1, 0)",
    ["codex-" + i, "Session " + i, process.env.HOME, path]);
  history.run("INSERT INTO thread_turns VALUES (?, 'inProgress', 1)", ["codex-" + i]);
}
db.close();
history.close();
const sessions = await codexAdapter(dbPath, { historyDb: historyPath, runtime: hostRuntime(host) }).list();
expect(sessions).toHaveLength(35);
expect(sessions.every(session => session.status === "running")).toBe(true);
expect(new Set(sessions.map(session => session.externalId)).size).toBe(35);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "expires queued commands without executing them or leaking a channel",
  () =>
    sshScenario(`
const blockers = Array.from({ length: 8 }, () => hostExec(host, ["gate-command"]));
await until(() => events().split("gate-start").length - 1 === 8);
const queued = hostExec(host, ["queued-command"], { timeoutMs: 50 })
  .then(() => "executed", error => String(error));
const outcome = await Promise.race([queued, Bun.sleep(300).then(() => "still queued")]);
writeFileSync(process.env.HOME + "/release", "");
await Promise.all(blockers);
await queued;
expect(outcome).toContain("timed out");
expect(events()).not.toContain("queued-ran");
expect((await hostExec(host, ["echo", "ok"])).code).toBe(0);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "retirement survives commands that were already queued",
  () =>
    sshScenario(`
const commands = Array.from({ length: 9 }, () => hostExec(host, ["gate-command"]));
await until(() => events().split("gate-start").length - 1 === 8);
await retireSshMaster(host.alias);
writeFileSync(process.env.HOME + "/release", "");
await Promise.all(commands);
await until(() => readFileSync(process.env.HOME + "/master", "utf8") === "down");
expect(events().split("gate-end").length - 1).toBe(9);
`),
  20_000,
);

test(
  "a delayed old transport error cannot close its replacement",
  () =>
    sshScenario(`
const fast = hostExec(host, ["failure-fast"]);
const slow = hostExec(host, ["failure-slow"]);
await until(() => events().includes("fast-start") && events().includes("slow-start"));
writeFileSync(process.env.HOME + "/release-fast", "");
expect((await fast).code).toBe(255);
expect((await hostExec(host, ["echo", "ok"])).code).toBe(0);
expect(events().split("master").length - 1).toBe(2);
writeFileSync(process.env.HOME + "/release-slow", "");
expect((await slow).code).toBe(255);
expect(readFileSync(process.env.HOME + "/master", "utf8")).toBe("up");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "a setup timeout never launches the expired command",
  () =>
    sshScenario(`
writeFileSync(process.env.HOME + "/delay-master", "");
const command = hostExec(host, ["queued-command"], { timeoutMs: 150 })
  .then(() => "executed", error => String(error));
await until(() => events().includes("master-start"));
const outcome = await Promise.race([command, Bun.sleep(400).then(() => "still starting")]);
writeFileSync(process.env.HOME + "/release-master", "");
await until(() => existsSync(process.env.HOME + "/master"));
expect(outcome).toContain("timed out");
expect(events()).not.toContain("queued-ran");
expect((await hostExec(host, ["echo", "ok"])).code).toBe(0);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "SSH file-check failures cannot turn Codex discovery into an empty success",
  () =>
    sshScenario(`
writeFileSync(process.env.HOME + "/fail-file-check", "");
const runtime = hostRuntime(host);
await expect(codexAdapter(process.env.HOME + "/state.sqlite", { runtime }).list())
  .rejects.toThrow("Connection reset");
await expect(runtime.isDirectory(process.env.HOME)).rejects.toThrow("Connection reset");
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "genuinely missing remote files remain false",
  () =>
    sshScenario(`
const runtime = hostRuntime(host);
expect(await runtime.isFile(process.env.HOME + "/missing")).toBe(false);
expect(await runtime.isDirectory(process.env.HOME + "/missing")).toBe(false);
expect(await runtime.isFile(process.env.HOME + "/events")).toBe(true);
expect(await runtime.isDirectory(process.env.HOME)).toBe(true);
await retireSshMaster(host.alias);
`),
  20_000,
);

test(
  "retirement waits for setup after its only command times out",
  () =>
    sshScenario(`
writeFileSync(process.env.HOME + "/delay-master", "");
const command = hostExec(host, ["queued-command"], { timeoutMs: 150 })
  .then(() => "executed", error => String(error));
await until(() => events().includes("master-start"));
await retireSshMaster(host.alias);
expect(await command).toContain("timed out");
await Bun.sleep(50);
const closedDuringSetup = events().includes("close");
writeFileSync(process.env.HOME + "/release-master", "");
expect(closedDuringSetup).toBe(false);
await until(() => events().includes("master" + String.fromCharCode(10)));
await until(() => readFileSync(process.env.HOME + "/master", "utf8") === "down");
expect(events()).not.toContain("queued-ran");
`),
  20_000,
);
