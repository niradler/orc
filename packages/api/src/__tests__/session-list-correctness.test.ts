import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { writeRegistration } from "@orc/core/live-session";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { runSync, tokensSettled } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { codexAdapter } from "../sessions/codex.js";
import { promptText } from "../sessions/common.js";
import { cursorAdapter } from "../sessions/cursor.js";
import { withLifecycle } from "../sessions/lifecycle.js";
import { piAdapter } from "../sessions/pi.js";
import type { SessionAdapter } from "../sessions/types.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Row = { id: string; session_id: string; name: string; summary: string | null };

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-session-list-"));
const DEAD_PID = 2_000_000_000;
const OLD = 1_790_000_000;
const jsonl = (lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

async function listed(agent: string): Promise<Row[]> {
  const res = await req(app, "GET", `/sessions/live?active=false&agent=${agent}&limit=1000`);
  expect(res.status).toBe(200);
  return (await res.json()).sessions;
}

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

test("shared prompt text drops terminal escapes and agent wrapper messages", () => {
  expect(promptText("\u001b[1m# daily-health\u001b[0m")).toBe("# daily-health");
  expect(
    promptText(
      "<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>",
    ),
  ).toBe("");
  expect(
    promptText(
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 15</command-args>",
    ),
  ).toBe("/review PR 15");
  expect(
    promptText("<ide_opened_file>The user opened a.ts</ide_opened_file>\n\nfix the build"),
  ).toBe("fix the build");
  expect(promptText("<local-command-caveat>Caveat: local</local-command-caveat>")).toBe("");
});

test("a rotated Codex rollout stays listed and opens; threads with no rollout or internal runs are not listed", async () => {
  const home = join(root, "codex");
  mkdirSync(home);
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
    preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
    created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
    archived INTEGER, source TEXT)`);
  const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const rollout = (id: string) => join(home, `rollout-${id}.jsonl`);
  const threads = [
    ["rotated", "\u001b[1m# daily-health\u001b[0m", "", "/tmp/repo"],
    ["cleared", "<command-name>/clear</command-name>", "", "/tmp/agentops"],
    [
      "review",
      null,
      "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 15</command-args>",
      "/tmp/repo",
    ],
    [
      "opened",
      null,
      "<ide_opened_file>The user opened a.ts</ide_opened_file>\n\nfix the build",
      "/tmp/repo",
    ],
    ["gone", "Lost thread", "", "/tmp/repo"],
    ["guardian", "Guardian review", "", "/tmp/repo"],
  ] as const;
  for (const [id, name, prompt, cwd] of threads)
    insert.run(
      id,
      "",
      name,
      cwd,
      "",
      prompt,
      10,
      rollout(id),
      OLD * 1000,
      OLD,
      OLD * 1000,
      OLD,
      0,
      id === "guardian" ? JSON.stringify({ subagent: { other: "guardian" } }) : "cli",
    );
  insert.finalize();
  db.close();
  const userTurn = {
    type: "response_item",
    timestamp: "2026-11-01T00:00:00Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "check the deploy" }],
    },
  };
  writeFileSync(`${rollout("rotated")}.zst`, zstdCompressSync(Buffer.from(jsonl([userTurn]))));
  utimesSync(`${rollout("rotated")}.zst`, OLD, OLD);
  for (const id of ["cleared", "review", "opened", "guardian"]) {
    writeFileSync(rollout(id), jsonl([userTurn]));
    utimesSync(rollout(id), OLD, OLD);
  }

  await runSync([codexAdapter(join(home, "state_5.sqlite"), { writer: () => false })], {
    force: true,
  });
  const rows = await listed("codex");
  expect(Object.fromEntries(rows.map((row) => [row.session_id, row.name]))).toEqual({
    rotated: "# daily-health",
    cleared: "agentops",
    review: "/review PR 15",
    opened: "fix the build",
  });
  const rotated = rows.find((row) => row.session_id === "rotated");
  const transcript = await req(app, "GET", `/sessions/live/${rotated?.id}/transcript`);
  expect(transcript.status).toBe(200);
  expect(JSON.stringify(await transcript.json())).toContain("check the deploy");
});

test("a Claude session leaves the list when its transcript is deleted and returns with it", async () => {
  const registry = join(root, "claude-registry");
  const projects = join(root, "claude-projects");
  const folder = join(projects, "-tmp-repo");
  mkdirSync(registry);
  mkdirSync(folder, { recursive: true });
  const register = (sessionId: string, name?: string) =>
    writeFileSync(
      join(registry, `${sessionId}.json`),
      JSON.stringify({
        pid: DEAD_PID,
        sessionId,
        cwd: "/tmp/repo",
        ...(name ? { name } : {}),
        status: "idle",
        startedAt: OLD * 1000,
        updatedAt: OLD * 1000,
      }),
    );
  const kept = "aaaaaaaa-0000-4000-8000-00000000c001";
  const empty = "aaaaaaaa-0000-4000-8000-00000000c002";
  const wrapped = "aaaaaaaa-0000-4000-8000-00000000c003";
  const placeholder = "aaaaaaaa-0000-4000-8000-00000000c004";
  const transcript = join(folder, `${kept}.jsonl`);
  const shipIt = jsonl([
    { type: "user", timestamp: "2026-11-01T00:00:00Z", message: { content: "ship it" } },
    {
      type: "assistant",
      timestamp: "2026-11-01T00:00:01Z",
      message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ]);
  register(kept, "Ship it");
  register(empty);
  register(wrapped);
  register(placeholder);
  writeFileSync(transcript, shipIt);
  writeFileSync(
    join(folder, `${wrapped}.jsonl`),
    jsonl([
      {
        type: "user",
        message: {
          content:
            "<command-message>ponytail-help</command-message>\n<command-name>/ponytail-help</command-name>",
        },
      },
      {
        type: "user",
        isMeta: true,
        message: { content: [{ type: "text", text: "Base directory for this skill: /x" }] },
      },
      { type: "user", message: { content: "really fix it" } },
    ]),
  );
  const adapters = () => [claudeAdapter({ registry, desktop: null, projects })];
  await runSync(adapters(), { force: true });
  await tokensSettled();
  const names = async () =>
    Object.fromEntries((await listed("claude")).map((row) => [row.session_id, row.name]));
  expect(await names()).toMatchObject({ [kept]: "Ship it", [wrapped]: "really fix it" });
  expect(Object.keys(await names())).not.toContain(empty);
  expect(Object.keys(await names())).not.toContain(placeholder);

  unlinkSync(join(registry, `${wrapped}.json`));
  getSqlite()
    .query("UPDATE gateway_sessions SET title = 'New session' WHERE runtime_session_id = ?")
    .run(wrapped);
  await runSync(adapters(), { force: true });
  expect((await names())[wrapped]).toBe("really fix it");

  writeFileSync(
    join(folder, `${placeholder}.jsonl`),
    jsonl([{ type: "user", timestamp: "2026-11-02T00:00:00Z", message: { content: "say hi" } }]),
  );
  await runSync(adapters(), { force: true });
  expect((await names())[placeholder]).toBe("say hi");

  unlinkSync(join(registry, `${kept}.json`));
  unlinkSync(transcript);
  await runSync(adapters(), { force: true });
  expect(Object.keys(await names())).not.toContain(kept);
  expect(
    getSqlite()
      .query<{ transcript_path: string | null }, [string]>(
        "SELECT transcript_path FROM gateway_sessions WHERE runtime_session_id = ?",
      )
      .get(kept),
  ).toEqual({ transcript_path: null });

  writeFileSync(transcript, shipIt);
  await runSync(adapters(), { force: true });
  expect((await names())[kept]).toBe("Ship it");
});

test("a Pi session leaves the list when its session file is deleted", async () => {
  const sessions = join(root, "pi");
  mkdirSync(sessions);
  const id = "bbbbbbbb-0000-4000-8000-00000000b001";
  const file = join(sessions, `2026-11-01_${id}.jsonl`);
  const timestamp = "2026-11-01T00:00:00.000Z";
  writeFileSync(
    file,
    jsonl([
      { type: "session", version: 3, id, timestamp, cwd: "/tmp/repo" },
      {
        id: "u",
        parentId: null,
        timestamp,
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "plan the release" }] },
      },
    ]),
  );
  await runSync([piAdapter(sessions)], { force: true });
  expect((await listed("pi")).map((row) => row.name)).toEqual(["plan the release"]);
  unlinkSync(file);
  await runSync([piAdapter(sessions)], { force: true });
  expect(await listed("pi")).toEqual([]);
});

test("a Cursor chat whose title was never generated is named from its content", async () => {
  const stateDb = join(root, "cursor-state.vscdb");
  const db = new Database(stateDb);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  for (const [id, preview] of [
    ["unnamed-with-preview", "fix the login form"],
    ["unnamed-bare", null],
  ] as const)
    insert.run(
      `composerData:${id}`,
      JSON.stringify({
        name: "Generate a name for the chat",
        createdAt: OLD * 1000,
        lastUpdatedAt: OLD * 1000,
        contextTokensUsed: 500,
        fullConversationHeadersOnly: [{ grouping: { textPreview: preview } }],
      }),
    );
  insert.finalize();
  db.close();
  await runSync([cursorAdapter({ projects: null, stateDb })], { force: true });
  expect(
    Object.fromEntries((await listed("cursor")).map((row) => [row.session_id, row.name])),
  ).toEqual({ "unnamed-with-preview": "fix the login form", "unnamed-bare": "Cursor session" });
});

test("a registered session keeps the transcript path its agent moved it to", async () => {
  const registry = join(root, "lifecycle");
  writeRegistration(
    {
      backend: "codex",
      externalId: "moved",
      pid: DEAD_PID,
      title: "Moved",
      transcriptPath: "/sessions/rollout-moved.jsonl",
      status: "stopped",
      createdAt: OLD * 1000,
      updatedAt: OLD * 1000,
    },
    registry,
  );
  const native: SessionAdapter = {
    backend: "codex",
    minIntervalMs: 0,
    list: async () => [
      {
        backend: "codex",
        externalId: "moved",
        title: "Moved",
        status: "stopped",
        createdAt: new Date(OLD * 1000),
        lastActivityAt: new Date(OLD * 1000),
        transcriptPath: "/sessions/rollout-moved.jsonl.zst",
      },
    ],
  };
  const [record] = await withLifecycle(native, registry).list(new Map());
  expect(record?.transcriptPath).toBe("/sessions/rollout-moved.jsonl.zst");
});
