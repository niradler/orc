import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig } from "@orc/core/config";
import type { RuleRevision } from "@orc/core/rule-types";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { z } from "zod";
import { createApp } from "../server.js";
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
  rules: [
    {
      id: "guard",
      kind: "event",
      enabled: true,
      reason: "No deletion",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [{ predicate: { field: "tool", operator: "in", value: ["Bash"] } }],
      },
      target: { type: "block" },
    },
  ],
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
        policy: {
          ...policy,
          rules: [{ id: "x", kind: "script", command: "anything" }],
        },
        expected_id: null,
        reason: "Test",
      })
    ).status,
  ).toBe(400);
});

test("should preserve typed null filter values and publish generic processor contracts in OpenAPI", async () => {
  const response = await app.request("/openapi.json", {
    headers: { Authorization: "Bearer test-secret" },
  });
  expect(response.status).toBe(200);
  const serialized = JSON.stringify(await response.json());
  expect(serialized.includes('"enum":["rewrite_command"]')).toBe(true);
  expect(serialized.includes('"type":"null"')).toBe(true);
  expect(serialized.includes('"command_processors"')).toBe(true);
});

test("should expose reusable templates through authenticated read-only catalog access", async () => {
  expect((await app.request("/api/rules/catalog")).status).toBe(401);
  const response = await req(app, "GET", "/rules/catalog");
  expect(response.status).toBe(200);
  const catalog = await response.json<{ templates: { id: string }[] }>();
  expect(catalog.templates.some((entry) => entry.id === "rtk-git")).toBe(true);
  expect(getSqlite().query("SELECT id FROM rule_decisions").all()).toHaveLength(0);
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
    backend: "claude",
    cwd: root,
    phase: "pre_tool",
    tool: "Bash",
    input: { command: "remove anything" },
  });
  expect(z.object({ decision: z.string() }).parse(await check.json()).decision).toBe("deny");
  expect(getSqlite().query("SELECT id FROM rule_decisions").all()).toHaveLength(0);
  const reverted = await req(app, "POST", "/rules/revert", {
    id: first.id,
    reason: "Restore previous",
  });
  expect(reverted.status).toBe(200);
  expect((await reverted.json()).policy).toBeNull();
  expect(
    (
      await req(app, "POST", "/rules/revert", {
        id: first.id,
        reason: "Stale revert",
      })
    ).status,
  ).toBe(409);
  const history = await (await req(app, "GET", "/rules")).json();
  expect(history.history).toHaveLength(2);
  expect(history.history.filter((r: RuleRevision) => r.current)).toHaveLength(1);
});
test("should administer and evaluate policies without a token in open mode", async () => {
  try {
    process.env.ORC_API_SECRET = "";
    resetConfig();
    const openApp = createApp();
    const workspace = mkdtempSync(join(root, "open-"));
    const activated = await openApp.request("/api/rules/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        policy: { ...policy, workspace },
        expected_id: null,
        reason: "Open mode",
      }),
    });
    expect(activated.status).toBe(201);
    expect((await openApp.request("/api/rules")).status).toBe(200);
    const check = await openApp.request("/api/rules/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "open-event",
        session_id: "open-session",
        backend: "claude",
        cwd: workspace,
        phase: "pre_tool",
        tool: "Bash",
        input: { command: "remove anything" },
      }),
    });
    expect(check.status).toBe(200);
    expect(z.object({ decision: z.string() }).parse(await check.json()).decision).toBe("deny");
  } finally {
    process.env.ORC_API_SECRET = "test-secret";
    resetConfig();
  }
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
    expect((await response.json()).error).toContain("no verified ORC rule interception");
  } finally {
    store.revert(revision.id, "End isolated chat fixture");
    loadConfig({ rules: { enabled: false } });
  }
});
