import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync, tokensSettled } from "../session-watcher.js";
import { claudeAdapter, transcriptMeta } from "../sessions/claude.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Row = {
  session_id: string;
  status: string;
  waiting_for_human: boolean;
  waiting_for: { reason: string; tool: string | null } | null;
  background_work: boolean;
};

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-live-run-state-"));
const registry = join(root, "registry");
const projects = join(root, "projects");
const waiting = "cccccccc-0000-4000-8000-000000000001";
const shell = "cccccccc-0000-4000-8000-000000000002";
const adapters = [claudeAdapter({ registry, desktop: null, projects })];

beforeAll(() => {
  app = setupTestApp();
  mkdirSync(registry, { recursive: true });
  mkdirSync(join(projects, "-tmp-orc"), { recursive: true });
});

afterAll(() => {
  teardownTestApp();
  Bun.gc(true);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

function register(
  file: string,
  sessionId: string,
  status: string,
  waitingFor?: string,
  updatedAt = Date.parse("2026-11-17T12:01:00Z"),
) {
  writeFileSync(
    join(registry, file),
    JSON.stringify({
      pid: sessionId === shell ? process.ppid : process.pid,
      sessionId,
      cwd: "/tmp/orc",
      status,
      waitingFor: waitingFor ?? null,
      startedAt: Date.parse("2026-11-17T12:00:00Z"),
      updatedAt,
    }),
  );
}

const toolUse = (id: string, name: string) => ({
  type: "assistant",
  timestamp: "2026-11-17T12:00:05Z",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string) => ({
  type: "user",
  timestamp: "2026-11-17T12:00:06Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n");

async function rows(): Promise<Map<string, Row>> {
  const res = await req(app, "GET", "/sessions/live?active=false&agent=claude");
  expect(res.status).toBe(200);
  return new Map(((await res.json()).sessions as Row[]).map((row) => [row.session_id, row]));
}

test("the pending tool is the last tool call without a result", () => {
  expect(transcriptMeta(jsonl([toolUse("t1", "Read"), toolResult("t1")])).pendingTool).toBeNull();
  expect(
    transcriptMeta(jsonl([toolUse("t1", "Read"), toolResult("t1"), toolUse("t2", "Bash")]))
      .pendingTool,
  ).toBe("Bash");
});

test("Claude's registry reports a permission wait with its tool and idle background work", async () => {
  register("1.json", waiting, "waiting", "permission prompt");
  register("2.json", shell, "shell");
  writeFileSync(
    join(projects, "-tmp-orc", `${waiting}.jsonl`),
    jsonl([
      { type: "user", timestamp: "2026-11-17T12:00:00Z", message: { content: "touch a file" } },
      toolUse("t1", "Bash"),
    ]),
  );
  await runSync(adapters, { force: true });
  const live = await rows();
  expect(live.get(waiting)).toMatchObject({
    status: "running",
    waiting_for_human: true,
    waiting_for: { reason: "permission", tool: "Bash" },
    background_work: false,
  });
  expect(live.get(shell)).toMatchObject({
    status: "idle",
    waiting_for_human: false,
    waiting_for: null,
    background_work: true,
  });

  register("1.json", waiting, "busy");
  register("2.json", shell, "idle");
  await runSync(adapters, { force: true });
  const settled = await rows();
  expect(settled.get(waiting)).toMatchObject({
    status: "running",
    waiting_for_human: false,
    waiting_for: null,
  });
  expect(settled.get(shell)).toMatchObject({ status: "idle", background_work: false });
});

test("an elicitation reads as a question without a tool", async () => {
  register("1.json", waiting, "waiting", "input needed");
  writeFileSync(
    join(projects, "-tmp-orc", `${waiting}.jsonl`),
    jsonl([
      { type: "user", timestamp: "2026-11-17T12:00:00Z", message: { content: "ask me" } },
      toolUse("t1", "Bash"),
      toolResult("t1"),
    ]),
  );
  await runSync(adapters, { force: true });
  expect((await rows()).get(waiting)?.waiting_for).toEqual({ reason: "question", tool: null });
});

test("a restarted watcher still names the tool of a wait already open", async () => {
  const later = Date.now() + 60_000;
  register("1.json", waiting, "busy", undefined, later);
  writeFileSync(
    join(projects, "-tmp-orc", `${waiting}.jsonl`),
    jsonl([
      { type: "user", timestamp: "2026-11-17T12:00:00Z", message: { content: "edit it" } },
      toolUse("t2", "Edit"),
    ]),
  );
  await runSync(adapters, { force: true });
  await tokensSettled();
  register("1.json", waiting, "waiting", "permission prompt", later);
  await runSync([claudeAdapter({ registry, desktop: null, projects })], { force: true });
  expect((await rows()).get(waiting)?.waiting_for).toEqual({ reason: "permission", tool: "Edit" });
});
