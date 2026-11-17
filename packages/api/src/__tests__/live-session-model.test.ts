import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Row = { id: string; session_id: string; model: string | null; permission_mode: string | null };

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-live-session-model-"));
const native = "bbbbbbbb-0000-4000-8000-000000000001";

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  Bun.gc(true);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

async function row(): Promise<Row | undefined> {
  const res = await req(app, "GET", "/sessions/live?active=false&agent=claude");
  expect(res.status).toBe(200);
  return ((await res.json()).sessions as Row[]).find((s) => s.session_id === native);
}

test("live sessions report the transcript model and permission mode", async () => {
  const registry = join(root, "registry");
  const projects = join(root, "projects");
  mkdirSync(registry, { recursive: true });
  mkdirSync(join(projects, "-tmp-orc"), { recursive: true });
  writeFileSync(
    join(registry, "1.json"),
    JSON.stringify({
      pid: 2_000_000_000,
      sessionId: native,
      cwd: "/tmp/orc",
      startedAt: Date.parse("2026-11-12T12:00:00Z"),
      updatedAt: Date.parse("2026-11-12T12:01:00Z"),
    }),
  );
  writeFileSync(
    join(projects, "-tmp-orc", `${native}.jsonl`),
    [
      { type: "permission-mode", permissionMode: "default" },
      {
        type: "user",
        timestamp: "2026-11-12T12:00:00Z",
        permissionMode: "acceptEdits",
        message: { content: "hi" },
      },
      {
        type: "assistant",
        timestamp: "2026-11-12T12:00:05Z",
        message: {
          id: "msg-1",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  await runSync([claudeAdapter({ registry, desktop: null, projects })], { force: true });

  let found = await row();
  for (let i = 0; i < 100 && !found?.model; i++) {
    await Bun.sleep(20);
    found = await row();
  }
  expect(found).toMatchObject({ model: "claude-opus-5-5", permission_mode: "acceptEdits" });
  const one = await req(app, "GET", `/sessions/live/${found?.id}`);
  expect(await one.json()).toMatchObject({
    model: "claude-opus-5-5",
    permission_mode: "acceptEdits",
  });
});
