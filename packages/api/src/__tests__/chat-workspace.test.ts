import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatThread } from "@orc/core/chat";
import { resetConfig } from "@orc/core/config";
import { req, setupTestApp, teardownTestApp } from "./helpers";

let app: ReturnType<typeof setupTestApp>;
const previous = { mock: process.env.ORC_E2E_CHAT_MOCK, host: process.env.ORC_SSH_HOST };
beforeAll(() => {
  process.env.ORC_E2E_CHAT_MOCK = "1";
  process.env.ORC_SSH_HOST = "";
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  for (const [key, value] of [
    ["ORC_E2E_CHAT_MOCK", previous.mock],
    ["ORC_SSH_HOST", previous.host],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});
test("should validate messages, host and Git repository before allocating a chat worktree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-chat-workspace-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", cwd, ...args], { timeout: 10000 });
    expect(result.exitCode).toBe(0);
  };
  git(["init"]);
  git([
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-m",
    "Seed",
  ]);
  const workspace = { cwd, host: null, worktree: true };
  expect(
    (
      await req(app, "POST", "/chat/stream", {
        messages: [{ role: "assistant", content: "Invalid" }],
        workspace,
      })
    ).status,
  ).toBe(400);
  expect(existsSync(join(cwd, ".orc", "worktrees"))).toBe(false);
  expect(
    (
      await req(app, "POST", "/chat/stream", {
        messages: [{ role: "user", content: "Hi" }],
        workspace: { ...workspace, host: "unknown-host" },
      })
    ).status,
  ).toBe(400);
  const nonrepo = mkdtempSync(join(tmpdir(), "orc-chat-nonrepo-"));
  expect(
    (
      await req(app, "POST", "/chat/stream", {
        messages: [{ role: "user", content: "Hi" }],
        workspace: { ...workspace, cwd: nonrepo },
      })
    ).status,
  ).toBe(400);
  const response = await req(app, "POST", "/chat/stream", {
    messages: [{ role: "user", content: "Hi" }],
    workspace,
  });
  expect(response.status).toBe(200);
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  const thread = events.find((event) => event.type === "thread").thread as ChatThread;
  expect(thread.cwd.startsWith(join(cwd, ".orc", "worktrees"))).toBe(true);
  expect(thread.host).toBeNull();
  const loaded = await (await req(app, "GET", `/chat/threads/${thread.id}`)).json<ChatThread>();
  expect(loaded.cwd).toBe(thread.cwd);
  expect(
    (
      await req(app, "POST", "/chat/stream", {
        threadId: thread.id,
        messages: [{ role: "user", content: "Next" }],
        workspace: { host: null, cwd },
      })
    ).status,
  ).toBe(400);
});
