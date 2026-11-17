import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatThreadSchema } from "@orc/core/chat";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { LIVE_CHAT_ID } from "../sessions/common";
import { req, setupTestApp, teardownTestApp } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "orc-subagents-"));
let app: ReturnType<typeof setupTestApp>;

function session(
  id: string,
  backend: string,
  runtime: string,
  path: string | null,
  parent: string | null,
  created: number,
) {
  getSqlite().run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, transcript_path, parent_session_id, title, status, created_at) VALUES (?, ?, ?, 'direct', ?, ?, ?, ?, 'stopped', ?)",
    [id, LIVE_CHAT_ID, backend, runtime, path, parent, `title ${id}`, created],
  );
}

beforeAll(() => {
  app = setupTestApp();
  const subagents = join(root, "claude-parent", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, "agent-a1.jsonl"), "");
  writeFileSync(join(subagents, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_1" }));
  writeFileSync(join(subagents, "agent-a2.jsonl"), "");
  session("cparent", "claude", "claude-parent", join(root, "claude-parent.jsonl"), null, 1);
  session("cchild1", "claude", "agent-a1", join(subagents, "agent-a1.jsonl"), "claude-parent", 2);
  session("cchild2", "claude", "agent-a2", join(subagents, "agent-a2.jsonl"), "claude-parent", 3);
  const rollout = join(root, "codex-parent.jsonl");
  writeFileSync(
    rollout,
    [
      { type: "session_meta", payload: { id: "codex-parent" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "SubAgentActivity",
            id: "call_9",
            kind: "started",
            agent_thread_id: "codex-child",
          },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  session("xparent", "codex", "codex-parent", rollout, null, 1);
  session("xchild", "codex", "codex-child", join(root, "codex-child.jsonl"), "codex-parent", 2);
  new ChatStore(getSqlite()).save(
    ChatThreadSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Opened subagent",
      config: { agent: "claude" },
      cwd: "/tmp",
      host: null,
      runtimeId: "agent-a1",
      backend: "claude",
      sourceId: "cchild1",
      updatedAt: 1,
      messages: [],
    }),
  );
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

test("a session lists its subagents with the tool call that started each", async () => {
  const claude = await req(app, "GET", "/sessions/live/cparent/subagents");
  expect(claude.status).toBe(200);
  expect(
    (await claude.json()).subagents.map((s: { id: string; tool_call_id: string | null }) => [
      s.id,
      s.tool_call_id,
    ]),
  ).toEqual([
    ["cchild1", "toolu_1"],
    ["cchild2", null],
  ]);
  const codex = await (await req(app, "GET", "/sessions/live/xparent/subagents")).json();
  expect(codex.subagents).toMatchObject([{ id: "xchild", tool_call_id: "call_9" }]);
  const none = await (await req(app, "GET", "/sessions/live/cchild1/subagents")).json();
  expect(none.subagents).toEqual([]);
});

test("a subagent, also opened as a chat, names the session that started it", async () => {
  for (const id of ["cchild1", "22222222-2222-4222-8222-222222222222"]) {
    const lineage = await (await req(app, "GET", `/sessions/live/${id}/lineage`)).json();
    expect(lineage.parent).toMatchObject({ id: "cparent", kind: "session" });
  }
});
