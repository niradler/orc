import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import type { RuleRevision } from "@orc/core/rule-types";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-api-"));
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});
const policy = {
  workspace: root,
  project_id: null,
  rules: [{ id: "guard", kind: "deny_delete", reason: "No deletion" }],
};
test("rules endpoints authenticate and reject malformed policies", async () => {
  const file = join(root, "not-a-directory.ts");
  writeFileSync(file, "export const x=1;");
  expect((await app.request("/api/rules")).status).toBe(401);
  expect(
    (
      await req(app, "POST", "/rules/activate", {
        policy: { ...policy, workspace: "relative" },
        expected_id: null,
        reason: "Test",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/rules/activate", {
        policy: { ...policy, workspace: file },
        expected_id: null,
        reason: "Workspace must be a directory",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/rules/activate", {
        policy: { ...policy, workspace: join(root, "missing") },
        expected_id: null,
        reason: "Missing workspace",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/rules/activate", {
        policy: { ...policy, rules: [{ id: "x", kind: "script", command: "anything" }] },
        expected_id: null,
        reason: "Test",
      })
    ).status,
  ).toBe(400);
});
test("real API activation, dry run, history and guarded revert", async () => {
  const response = await req(app, "POST", "/rules/activate", {
    policy,
    expected_id: null,
    reason: "First policy",
  });
  expect(response.status).toBe(201);
  const first = await response.json<RuleRevision>();
  const stale = await req(app, "POST", "/rules/activate", {
    policy,
    expected_id: null,
    reason: "Stale",
  });
  expect(stale.status).toBe(409);
  const check = await req(app, "POST", "/rules/check", {
    id: "event",
    session_id: "session",
    backend: "test",
    cwd: root,
    phase: "pre_tool",
    tool: "Bash",
    input: { command: "remove anything" },
  });
  expect((await check.json()).decision).toBe("deny");
  expect(getSqlite().query("SELECT id FROM rule_decisions").all()).toHaveLength(0);
  const reverted = await req(app, "POST", "/rules/revert", {
    id: first.id,
    reason: "Restore previous",
  });
  expect(reverted.status).toBe(200);
  expect((await reverted.json()).policy).toBeNull();
  expect(
    (await req(app, "POST", "/rules/revert", { id: first.id, reason: "Stale revert" })).status,
  ).toBe(409);
  const history = await (await req(app, "GET", "/rules")).json();
  expect(history.history).toHaveLength(2);
  expect(history.history.filter((r: RuleRevision) => r.current)).toHaveLength(1);
});
test("open local APIs cannot administer enforcement policies", async () => {
  loadConfig({ api: { host: "127.0.0.1", port: 7700, secret: "" } });
  expect(
    (await req(app, "POST", "/rules/activate", { policy, expected_id: null, reason: "No secret" }))
      .status,
  ).toBe(403);
  loadConfig({ api: { host: "127.0.0.1", port: 7700, secret: "test-secret" } });
});

test("protected chat refuses an unverified backend before launching it", async () => {
  const store = new RuleStore(getSqlite());
  const revision = store.activate(
    { ...policy, workspace: process.cwd() },
    null,
    "Protect chat process workspace",
  );
  loadConfig({ rules: { enabled: true } });
  try {
    const response = await req(app, "POST", "/chat/stream", {
      agent: "codex",
      messages: [{ role: "user", content: "A backend must not start" }],
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("fallback is refused");
  } finally {
    store.revert(revision.id, "End isolated chat fixture");
    loadConfig({ rules: { enabled: false } });
  }
});
