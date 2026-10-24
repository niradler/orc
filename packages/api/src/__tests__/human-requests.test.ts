import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import type { HumanRequest } from "@orc/core/human-requests";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);
const input = {
  kind: "question",
  prompt: "Which color?",
  choices: ["Blue", "Green"],
  origin: { backend: "codex", session_id: "origin-a", request_id: "request-a" },
};

test("should authenticate every human request operation", async () => {
  for (const [method, path] of [
    ["GET", ""],
    ["POST", ""],
    ["GET", "/missing"],
    ["POST", "/missing/respond"],
    ["POST", "/missing/acknowledge"],
    ["POST", "/missing/cancel"],
  ] as const) {
    expect((await app.request(`/api/human-requests${path}`, { method })).status).toBe(401);
  }
});

test("should retain a disconnected question, accept one answer, and require delivery acknowledgement", async () => {
  const created = await req(app, "POST", "/human-requests", input);
  expect(created.status).toBe(200);
  const request = await created.json<HumanRequest>();
  expect((await req(app, "GET", "/human-requests")).status).toBe(200);
  expect((await (await req(app, "POST", "/human-requests", input)).json<HumanRequest>()).id).toBe(
    request.id,
  );
  const response = { version: 1, response: { kind: "question" as const, answer: "Blue" } };
  const replies = await Promise.all([
    req(app, "POST", `/human-requests/${request.id}/respond`, response),
    req(app, "POST", `/human-requests/${request.id}/respond`, response),
  ]);
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  const answered = await (
    await req(app, "GET", `/human-requests/${request.id}`)
  ).json<HumanRequest>();
  expect(answered.status).toBe("answered");
  expect(answered.response).toEqual(response.response);
  expect(
    (await req(app, "POST", `/human-requests/${request.id}/acknowledge`, { version: 2 })).status,
  ).toBe(200);
  expect(
    (await req(app, "POST", `/human-requests/${request.id}/acknowledge`, { version: 2 })).status,
  ).toBe(409);
});

test("should reject credentials and incomplete approvals at the boundary", async () => {
  expect(
    (await req(app, "POST", "/human-requests", { ...input, password: "must-not-be-accepted" }))
      .status,
  ).toBe(400);
  expect(
    (await req(app, "POST", "/human-requests", { ...input, kind: "approval", choices: [] })).status,
  ).toBe(400);
});

test("should invalidate an unanswered request when its reviewed rule revision changes", async () => {
  const previous = process.env.ORC_RULES_ENABLED;
  process.env.ORC_RULES_ENABLED = "true";
  resetConfig();
  try {
    const workspace = mkdtempSync(join(tmpdir(), "orc-human-revision-"));
    const rules = new RuleStore(getSqlite());
    const policy = {
      workspace,
      project_id: null,
      rules: [
        {
          id: "review",
          kind: "event",
          enabled: true,
          reason: "Review",
          scope: { agents: ["claude"], events: ["pre_tool"] },
          filter: { match: "all", conditions: [] },
          target: { type: "ask_user", kind: "approval", prompt: "Review this command" },
        },
      ],
    };
    const revision = rules.activate(policy, null, "Initial");
    const response = await req(app, "POST", "/human-requests", {
      ...input,
      origin: { ...input.origin, request_id: "revision-bound" },
      rule_binding: { workspace, rule_id: "review", revision_id: revision.id },
    });
    const request = await response.json<HumanRequest>();
    rules.activate(policy, revision.id, "New revision invalidates old review");
    const current = await (
      await req(app, "GET", `/human-requests/${request.id}`)
    ).json<HumanRequest>();
    expect(current.status).toBe("cancelled");
    expect(
      (
        await req(app, "POST", `/human-requests/${request.id}/respond`, {
          version: 1,
          response: { kind: "question", answer: "Too late" },
        })
      ).status,
    ).toBe(409);
  } finally {
    if (previous === undefined) delete process.env.ORC_RULES_ENABLED;
    else process.env.ORC_RULES_ENABLED = previous;
    resetConfig();
  }
});
