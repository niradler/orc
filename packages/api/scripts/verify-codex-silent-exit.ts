import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// Bun caches homedir() at startup; fixtures need their home before Bun starts.
const fixtureHome = process.env.ORC_CODEX_OWNERSHIP_FIXTURE_HOME;
if (!fixtureHome) {
  const home = mkdtempSync(join(tmpdir(), "orc-codex-ownership-"));
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ORC_CODEX_OWNERSHIP_FIXTURE_HOME: home },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    timeout: 45000,
  });
  process.exit(await child.exited);
}
assert.equal(homedir(), fixtureHome, "Ownership fixtures must start with their isolated home");
const home = fixtureHome;
const resumeOnly = process.argv.includes("--resume-only");
Object.assign(process.env, {
  ORC_DB_PATH: ":memory:",
  ORC_SSH_HOST: "",
  ORC_ACTIVE_PROJECT: "",
  ORC_RULES_ENABLED: "false",
  ORC_API_SECRET: "silent-exit-fixture-secret",
  ORC_E2E_CHAT_MOCK: "",
});
const codex = join(home, ".codex");
mkdirSync(join(codex, "thread-writer-locks"), { recursive: true });
const transcript = join(codex, "rollout.jsonl");
writeFileSync(
  transcript,
  `${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: "silent-question" } })}\n`,
);
utimesSync(transcript, 1, 1);
const db = new Database(join(codex, "state_5.sqlite"));
db.exec(
  "CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT, created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER)",
);
db.query("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
  "silent-exit",
  "Silent exit fixture",
  null,
  home,
  "",
  "",
  0,
  transcript,
  1000,
  1,
  1000,
  1,
  0,
);
db.close();
const history = new Database(join(codex, "thread_history_1.sqlite"));
history.exec(
  "CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES ('silent-exit', 'completed', 1)",
);
history.close();
const lock = join(codex, "thread-writer-locks", "silent-exit.lock");
writeFileSync(lock, "");
const command =
  process.platform === "win32"
    ? [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "$f=[System.IO.File]::Open($env:ORC_TEST_LOCK,'Open','ReadWrite','ReadWrite'); $f.Lock(0,1); [Console]::WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()",
      ]
    : [
        "python3",
        "-u",
        "-c",
        "import fcntl,os,sys; f=open(os.environ['ORC_TEST_LOCK'],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.readline(); f.close()",
      ];
const startWriter = () =>
  Bun.spawn(command, {
    env: { ...process.env, ORC_TEST_LOCK: lock },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 50000,
  });
const keeper = startWriter();
const reader = keeper.stdout.getReader();
assert(new TextDecoder().decode((await reader.read()).value).includes("locked"));
reader.releaseLock();
const { resetConfig } = await import("../../core/src/config.js");
resetConfig();
const { createTestDb, closeDb, getDb } = await import("../../db/src/client.js");
createTestDb();
const { createApp } = await import("../src/server.js");
const { startSessionWatcher, LIVE_CHAT_ID } = await import("../src/session-watcher.js");
const app = createApp();
const stop = resumeOnly
  ? () => {}
  : startSessionWatcher({ liveRegistryDir: null, registryDir: null });
async function state() {
  const response = await app.request("/api/sessions/live?agent=codex&active=false", {
    headers: { Authorization: "Bearer silent-exit-fixture-secret" },
  });
  assert(response.ok);
  const data = z
    .object({
      sessions: z.array(
        z.object({
          session_id: z.string().nullable(),
          status: z.string(),
          waiting_for_human: z.boolean(),
        }),
      ),
    })
    .parse(await response.json());
  return data.sessions.find((row) => row.session_id === "silent-exit");
}
async function waitFor(
  predicate: (value: { status: string; waiting_for_human: boolean } | undefined) => boolean,
  duration: number,
) {
  const deadline = Date.now() + duration;
  while (true) {
    const value = await state();
    if (predicate(value)) return value;
    assert(Date.now() < deadline, `Silent-exit state never refreshed: ${JSON.stringify(value)}`);
    await Bun.sleep(100);
  }
}
try {
  if (resumeOnly) {
    const { bridge_chats, gateway_sessions } = await import("../../db/src/schema.js");
    getDb()
      .insert(bridge_chats)
      .values({
        id: LIVE_CHAT_ID,
        platform: "telegram",
        chat_id: "chat-fixture",
      })
      .onConflictDoNothing()
      .run();
    getDb()
      .insert(gateway_sessions)
      .values({
        id: "source-race",
        backend: "codex",
        mode: "direct",
        status: "stopped",
        chat_id: LIVE_CHAT_ID,
        runtime_session_id: "silent-exit",
        cwd: home,
      })
      .run();
    const resume = () =>
      app.request("/api/chat/threads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer silent-exit-fixture-secret",
        },
        body: JSON.stringify({ sourceSessionId: "source-race" }),
      });
    assert.equal(
      (await resume()).status,
      409,
      "A stopped DB record must not override a held native writer lock",
    );
    keeper.stdin.write("release\n");
    keeper.stdin.end();
    assert.equal(await keeper.exited, 0);
    const preparedResponse = await resume();
    assert.equal(
      preparedResponse.status,
      200,
      "Resume must become available when the native writer releases its lock",
    );
    const prepared = z.object({ id: z.string() }).parse(await preparedResponse.json());
    let backendCalls = 0;
    const unexpectedSession = async () => {
      backendCalls++;
      throw new Error("A held native writer must never start another agent");
    };
    const { registerBackend } = await import("@orc/agent-runtime");
    registerBackend("codex-cli", () => ({
      name: "codex-cli",
      preflight: async () => ({ ok: true }),
      stop: async () => {},
      startSession: unexpectedSession,
      resumeSession: unexpectedSession,
    }));
    const resumed = startWriter();
    try {
      const reader = resumed.stdout.getReader();
      assert(new TextDecoder().decode((await reader.read()).value).includes("locked"));
      reader.releaseLock();
      const result = await app.request("/api/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer silent-exit-fixture-secret",
        },
        body: JSON.stringify({
          threadId: prepared.id,
          messages: [{ role: "user", content: "continue" }],
        }),
      });
      assert.equal(result.status, 200);
      const events = (await result.text())
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)));
      assert(
        events.some(
          (event) =>
            event.type === "error" &&
            event.message === "End the original agent session before resuming it in chat.",
        ),
      );
      assert.equal(backendCalls, 0, "Writer re-acquisition must prevent native agent startup");
    } finally {
      resumed.stdin.write("release\n");
      resumed.stdin.end();
      assert.equal(await resumed.exited, 0);
    }
    console.log(
      "PASS stopped Codex record rejects a held writer, resumes after release and blocks re-acquisition",
    );
  } else {
    await waitFor((value) => value?.status === "idle" && value.waiting_for_human, 5000);
    console.log(
      "PASS held idle Codex lock remains active with pending question despite old file time",
    );
    const started = Date.now();
    keeper.stdin.write("release\n");
    keeper.stdin.end();
    assert.equal(await keeper.exited, 0);
    await waitFor((value) => value?.status === "stopped" && !value.waiting_for_human, 32500);
    console.log(
      `PASS silent local writer exit clears status and Attention without new file writes (${Date.now() - started}ms)`,
    );
  }
} finally {
  stop();
  keeper.kill();
  closeDb();
}
