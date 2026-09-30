import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync, tokensSettled } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { findRg } from "../sessions/search.js";
import { readTranscript } from "../sessions/transcript.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-transcripts-"));
const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");

const CLAUDE_ID = "22222222-aaaa-bbbb-cccc-000000000001";
const claudeLines = [
  { type: "summary", summary: "ignored" },
  { type: "user", isMeta: true, message: { content: "meta ignored" } },
  {
    type: "user",
    timestamp: "2026-09-30T10:00:00Z",
    message: { content: "<system-reminder>be terse</system-reminder>" },
  },
  {
    type: "user",
    timestamp: "2026-09-30T10:00:01Z",
    message: { content: [{ type: "text", text: "why does the needle-abc test flake?" }] },
  },
  {
    type: "assistant",
    timestamp: "2026-09-30T10:00:02Z",
    message: {
      id: "m1",
      content: [{ type: "text", text: "Let me look." }],
      usage: { output_tokens: 5 },
    },
  },
  {
    type: "assistant",
    message: {
      id: "m1",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }],
      usage: { output_tokens: 5 },
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "3 pass 1 fail" }] },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "orphan output" }] },
  },
  {
    type: "assistant",
    message: { id: "m2", content: [{ type: "text", text: "A race in the watcher." }] },
  },
];

beforeAll(async () => {
  app = setupTestApp();
  const projects = join(root, "projects", "-tmp-repo");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${CLAUDE_ID}.jsonl`), jsonl(claudeLines));
  const desktop = join(root, "desktop", "o", "u");
  mkdirSync(desktop, { recursive: true });
  writeFileSync(
    join(desktop, "local_a.json"),
    JSON.stringify({
      cliSessionId: CLAUDE_ID,
      cwd: "/tmp/repo",
      title: "Flaky needle-abc investigation",
      createdAt: 1_780_000_000_000,
      lastActivityAt: 1_780_000_100_000,
    }),
  );
  writeFileSync(
    join(desktop, "local_b.json"),
    JSON.stringify({
      cliSessionId: "no-transcript-session",
      cwd: "/tmp/elsewhere",
      title: "No transcript here",
      createdAt: 1_780_000_000_000,
      lastActivityAt: 1_780_000_000_000,
    }),
  );
  await runSync(
    [
      claudeAdapter({
        registry: join(root, "none"),
        desktop: join(root, "desktop"),
        projects: join(root, "projects"),
      }),
    ],
    { force: true },
  );
  await tokensSettled();
  process.env.ORC_SESSION_SEARCH_ROOTS = join(root, "projects");
});

afterAll(() => {
  delete process.env.ORC_SESSION_SEARCH_ROOTS;
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

describe("transcript readers", () => {
  test("claude: merges one response across lines, drops meta, marks reminders and tool results", async () => {
    const page = await readTranscript(
      join(root, "projects", "-tmp-repo", `${CLAUDE_ID}.jsonl`),
      "claude",
      {
        q: "race",
      },
    );
    expect(page.turns.map((t) => t.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const assistant = page.turns[2];
    expect(assistant?.blocks.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(assistant?.blocks[1]).toMatchObject({
      type: "tool_use",
      name: "Bash",
      result: "3 pass 1 fail",
    });
    expect(page.turns[3]?.blocks[0]).toMatchObject({ type: "tool_result", text: "orphan output" });
    expect(page.matches).toEqual([4]);
  });

  test("claude: pages with offset and limit", async () => {
    const path = join(root, "projects", "-tmp-repo", `${CLAUDE_ID}.jsonl`);
    const page = await readTranscript(path, "claude", { offset: 2, limit: 2 });
    expect(page).toMatchObject({ total: 5, offset: 2 });
    expect(page.turns.map((t) => t.index)).toEqual([2, 3]);
  });

  test("codex: skips developer messages, keeps calls, outputs and summaries", async () => {
    const path = join(root, "rollout.jsonl");
    writeFileSync(
      path,
      jsonl([
        { type: "session_meta", payload: { id: "x" } },
        {
          timestamp: "t1",
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "sys" }],
          },
        },
        {
          timestamp: "t2",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "review the diff" }],
          },
        },
        {
          timestamp: "t3",
          type: "response_item",
          payload: { type: "reasoning", summary: [{ text: "thinking about it" }] },
        },
        {
          timestamp: "t4",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "c1",
            name: "shell",
            arguments: '{"cmd":"git diff"}',
          },
        },
        {
          timestamp: "t5",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "c1", output: "diff --git a b" },
        },
        {
          timestamp: "t6",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "found a bug" }],
          },
        },
      ]),
    );
    const page = await readTranscript(path, "codex", { q: "bug" });
    expect(page.turns.map((t) => [t.role, t.blocks[0]?.type])).toEqual([
      ["user", "text"],
      ["assistant", "thinking"],
      ["assistant", "tool_use"],
      ["assistant", "text"],
    ]);
    expect(page.turns[2]?.blocks[0]).toMatchObject({ type: "tool_use", result: "diff --git a b" });
    expect(page.matches).toEqual([3]);
  });

  test("codex: a wrapped injected block is a system turn, plain user text is not", async () => {
    const path = join(root, "rollout-system.jsonl");
    writeFileSync(
      path,
      jsonl([
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<recommended_plugins>\nBox\n</recommended_plugins>" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "use a < b and c > d" }],
          },
        },
      ]),
    );
    const page = await readTranscript(path, "codex");
    expect(page.turns.map((t) => t.role)).toEqual(["system", "user"]);
  });

  test("cursor: strips the query and timestamp wrappers", async () => {
    const path = join(root, "cursor.jsonl");
    writeFileSync(
      path,
      jsonl([
        {
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<timestamp>Mon</timestamp>\n<user_query>\nbuild it\n</user_query>",
              },
            ],
          },
        },
        { role: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      ]),
    );
    const page = await readTranscript(path, "cursor");
    expect(page.turns[0]?.blocks[0]).toEqual({ type: "text", text: "build it" });
    expect(page.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });
});

describe("ripgrep lookup", () => {
  test("falls back to known install locations when PATH has no rg", () => {
    const fake = join(root, "fake-rg");
    writeFileSync(fake, "#!/bin/sh\n");
    const path = process.env.PATH;
    process.env.PATH = join(root, "empty-bin");
    try {
      expect(findRg([fake])).toBe(fake);
      expect(findRg([join(root, "missing-rg")])).toBeNull();
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("transcript and search routes", () => {
  const rowFor = async (sessionId: string) => {
    const res = await req(app, "GET", "/sessions/live?active=false&limit=100");
    const sessions = (await res.json()).sessions as { id: string; session_id: string }[];
    return sessions.find((s) => s.session_id === sessionId);
  };

  test("GET /sessions/live/{id}/transcript returns turns", async () => {
    const row = await rowFor(CLAUDE_ID);
    const res = await req(app, "GET", `/sessions/live/${row?.id}/transcript?q=needle`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.matches).toEqual([1]);
    expect(body.turns[1].blocks[0].text).toContain("needle-abc");
  });

  test("a session with no transcript is a 404", async () => {
    const row = await rowFor("no-transcript-session");
    expect((await req(app, "GET", `/sessions/live/${row?.id}/transcript`)).status).toBe(404);
    expect((await req(app, "GET", "/sessions/live/nope/transcript")).status).toBe(404);
  });

  test("search merges title hits with transcript hits and ranks them", async () => {
    const res = await req(app, "GET", "/sessions/live/search?q=needle-abc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      session_id: CLAUDE_ID,
      name: "Flaky needle-abc investigation",
    });
    expect(body.hits[0].matched).toContain("title");
    if (Bun.which("rg")) {
      expect(body.rg).toBe(true);
      expect(body.hits[0].matched).toContain("transcript");
      expect(body.hits[0].snippets[0]).toContain("needle-abc");
    }
  });

  test("a transcript-only match still finds the session", async () => {
    if (!Bun.which("rg")) return;
    const body = await (
      await req(app, "GET", "/sessions/live/search?q=race in the watcher")
    ).json();
    expect(body.hits.map((h: { session_id: string }) => h.session_id)).toEqual([CLAUDE_ID]);
    expect(body.hits[0].matched).toEqual(["transcript"]);
  });

  test("a one-character query is rejected", async () => {
    expect((await req(app, "GET", "/sessions/live/search?q=a")).status).toBe(400);
  });
});
