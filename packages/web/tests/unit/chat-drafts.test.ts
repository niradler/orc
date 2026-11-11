import { expect, test } from "bun:test";
import { ChatSettingsSchema } from "@orc/core/chat";
import { parseChatDrafts } from "../../src/lib/chat-drafts";

test("should restore independent blank and started drafts with their workspace and permissions", () => {
  const first = {
    key: "50000000-0000-4000-8000-000000000001",
    threadId: null,
    draft: "Blank draft",
    config: ChatSettingsSchema.parse({ agent: "codex" }),
    workspace: { cwd: "/project", host: "build-host", worktree: true },
  };
  const second = {
    ...first,
    key: "50000000-0000-4000-8000-000000000002",
    threadId: first.key,
    draft: "Started draft",
  };
  expect(parseChatDrafts(JSON.stringify([first, second]))).toEqual([first, second]);
});

test("should ignore corrupt or oversized browser state and invalid execution hosts", () => {
  expect(parseChatDrafts("invalid")).toEqual([]);
  expect(parseChatDrafts("[] ".repeat(1_300_000))).toEqual([]);
  expect(parseChatDrafts(JSON.stringify([{ key: "bad", draft: "untrusted" }]))).toEqual([]);
  expect(
    parseChatDrafts(
      JSON.stringify([
        {
          key: "50000000-0000-4000-8000-000000000001",
          threadId: null,
          draft: "draft",
          config: {},
          workspace: { cwd: "/project", host: "host;execute" },
        },
      ]),
    ),
  ).toEqual([]);
});
