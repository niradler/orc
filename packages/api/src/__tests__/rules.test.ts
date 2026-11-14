import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    { ...policy, workspace: homedir() },
    null,
    "Protect the default chat workspace",
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

test("should scope hook-client history by cwd and flag truncation", async () => {
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  const before = await req(app, "GET", "/rules");
  const heads = (await before.json<{ history: RuleRevision[] }>()).history;
  const head = heads.find((r) => r.current && norm(r.workspace) === norm(root));
  const activated = await req(app, "POST", "/rules/activate", {
    policy,
    expected_id: head?.id ?? null,
    reason: "Scoped history",
  });
  expect(activated.status).toBe(201);
  const sub = join(root, "sub");
  mkdirSync(sub, { recursive: true });
  const scoped = await req(app, "GET", `/rules?cwd=${encodeURIComponent(sub)}`);
  expect(scoped.status).toBe(200);
  const body = await scoped.json<{ history: RuleRevision[]; history_truncated: boolean }>();
  expect(body.history_truncated).toBe(false);
  expect(body.history).toHaveLength(1);
  expect(body.history[0]?.current).toBe(true);
  const other = mkdtempSync(join(tmpdir(), "orc-rules-other-"));
  try {
    const elsewhere = await req(app, "GET", `/rules?cwd=${encodeURIComponent(other)}`);
    expect((await elsewhere.json<{ history: unknown[] }>()).history).toHaveLength(0);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
  expect((await req(app, "GET", "/rules?cwd=relative")).status).toBe(400);
  const legacy = await req(app, "GET", "/rules");
  expect((await legacy.json<{ history_truncated: boolean }>()).history_truncated).toBe(false);
});
