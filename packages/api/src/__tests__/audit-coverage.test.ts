import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Entry = {
  action: string;
  actor: string | null;
  session_id: string | null;
  note: string | null;
  snapshot: Record<string, unknown> | null;
};
const root = mkdtempSync(join(tmpdir(), "orc-audit-coverage-"));
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

async function audit(entityType: string): Promise<Entry[]> {
  const response = await req(app, "GET", `/audit?entity_type=${entityType}&scope=all`);
  expect(response.status).toBe(200);
  return (await response.json<{ entries: Entry[] }>()).entries;
}

test("should audit job create, update and delete with the acting agent session and no command text", async () => {
  const agent = { "X-Orc-Actor-Name": "claude", "X-Orc-Session-Id": "session-1" };
  const created = await req(
    app,
    "POST",
    "/jobs",
    { name: "audited", command: "echo SECRET_COMMAND", trigger_type: "manual", enabled: true },
    agent,
  );
  expect(created.status).toBe(201);
  const job = await created.json<{ id: string }>();
  expect(
    (
      await req(
        app,
        "PATCH",
        `/jobs/${job.id}`,
        { enabled: false, command: "echo CHANGED_SECRET" },
        { "X-Orc-Source": "ui" },
      )
    ).status,
  ).toBe(200);
  expect((await req(app, "PATCH", `/jobs/${job.id}`, { enabled: false })).status).toBe(200);
  expect((await req(app, "DELETE", `/jobs/${job.id}`)).status).toBe(204);

  const entries = await audit("job");
  expect(entries.map((entry) => entry.action)).toEqual([
    "job.deleted",
    "job.updated",
    "job.created",
  ]);
  expect(entries[2]).toMatchObject({ actor: "claude", session_id: "session-1" });
  expect(entries[1]?.actor).toBe("web-ui");
  expect(entries[1]?.snapshot).toMatchObject({
    values: { enabled: { before: true, after: false } },
  });
  expect(((entries[1]?.snapshot?.changed ?? []) as string[]).sort()).toEqual([
    "command",
    "enabled",
  ]);
  expect(entries[0]?.actor).toBe("api");
  expect(JSON.stringify(entries)).not.toContain("SECRET_COMMAND");
  expect(JSON.stringify(entries)).not.toContain("CHANGED_SECRET");
});

test("should audit rule activation with its reason and actor", async () => {
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
  const response = await req(
    app,
    "POST",
    "/rules/activate",
    { policy, expected_id: null, reason: "Protect workspace" },
    { "X-Orc-Actor-Name": "cli" },
  );
  expect(response.status).toBe(201);
  const entries = await audit("rule");
  expect(entries[0]).toMatchObject({
    action: "rule.activated",
    actor: "cli",
    note: "Protect workspace",
  });
});

test("should audit sign-ins and sample failed attempts so guessing cannot flood the log", async () => {
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await req(app, "POST", "/auth/session", { secret: "wrong" })).status).toBe(401);
  expect((await req(app, "POST", "/auth/session", { secret: "test-secret" })).status).toBe(200);
  expect((await req(app, "POST", "/auth/token", { secret: "test-secret" })).status).toBe(200);
  const actions = (await audit("auth")).map((entry) => entry.action);
  expect(actions.filter((action) => action === "auth.sign_in_failed")).toHaveLength(1);
  expect(actions).toContain("auth.signed_in");
  expect(actions).toContain("auth.token_issued");
  expect(JSON.stringify(getSqlite().query("SELECT snapshot FROM audit_log").all())).not.toContain(
    "wrong",
  );
});
