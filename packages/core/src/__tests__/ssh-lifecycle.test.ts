import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("shares bounded SSH channels and waits for commands before retiring a master", async () => {
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
  if (op === "check") process.exit(existsSync(state) && await Bun.file(state).text() === "up" ? 0 : 1);
  if (op === "exit") { writeFileSync(state, "down"); log("close"); process.exit(0); }
}
if (args.includes("-N")) { writeFileSync(state, "up"); log("master"); process.exit(0); }
if (args.at(-1).includes("curl")) process.exit(0);
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
import { readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { codexAdapter } from ${JSON.stringify(resolve(import.meta.dir, "../../../api/src/sessions/codex.ts"))};
import { hostExec, hostRuntime, retireSshMaster, trackHostProcess } from ${JSON.stringify(modulePath)};
const host = { kind: "ssh", alias: "fixture", remotePort: 7700,
  apiTarget: "127.0.0.1:7700", secret: undefined, connectTimeoutSecs: 1 };
const logPath = process.env.HOME + "/events";
const results = await Promise.all(Array.from({length: 24}, () => hostExec(host, ["echo", "ok"])));
expect(results.every(r => r.code === 0 && r.stdout.trim() === "ok")).toBe(true);
let active = 0, peak = 0;
const events = readFileSync(logPath, "utf8").trim().split("\\n");
expect(events.filter(e => e === "master").length).toBe(1);
for (const event of events) {
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
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}, 20_000);
