import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import type { HumanRequest } from "@orc/core/human-requests";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
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
    ["POST", "/missing/run"],
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

test("should reject stale and running commands before checking their execution host", async () => {
  const store = new HumanRequestStore(getSqlite());
  const request = store.create({
    kind: "command",
    prompt: "Do not run stale commands",
    origin: { backend: "external", session_id: "stale-command", request_id: "stale-command" },
    command: { host: "unconfigured-command-host", cwd: "/missing", script: "true" },
  });
  const run = (version: number) =>
    req(app, "POST", `/human-requests/${request.id}/run`, {
      version,
      script: "true",
      values: {},
    });
  expect((await run(request.version + 1)).status).toBe(409);
  expect(store.get(request.id).status).toBe("pending");
  const claimed = store.claimCommand(request.id, request.version);
  expect((await run(claimed.version)).status).toBe(409);
  expect(store.get(request.id).status).toBe("running");
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

test("should run once with the host shell, redact values and retain only the result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-command-"));
  const secret = "p@ss'\"$()do-not-expand";
  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      prompt: "Run a credential check",
      origin: { backend: "external", session_id: "command-origin", request_id: "command-once" },
      command: {
        host: null,
        cwd,
        script: "printf original",
        arguments: [{ name: "PASSWORD", label: "Password" }],
      },
    })
  ).json<HumanRequest>();
  expect(entry.status).toBe("pending");
  expect(
    (
      await req(app, "POST", `/human-requests/${entry.id}/run`, {
        version: 1,
        script: "true",
        values: {},
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", `/human-requests/${entry.id}/respond`, {
        version: 1,
        response: { kind: "command", exit_code: 0, stdout: "forged", stderr: "", truncated: false },
      })
    ).status,
  ).toBe(400);
  const input = {
    version: 1,
    script:
      process.platform === "win32"
        ? '[Console]::Out.Write("edited:" + $env:ORC_INPUT_PASSWORD); [Console]::Error.Write($env:ORC_INPUT_PASSWORD); (Get-Location).Path'
        : 'printf "edited:"; printf "%s" "$ORC_INPUT_PASSWORD"; printf "%s" "$ORC_INPUT_PASSWORD" >&2; pwd',
    values: { PASSWORD: secret },
  };
  const responses = await Promise.all([
    req(app, "POST", `/human-requests/${entry.id}/run`, input),
    req(app, "POST", `/human-requests/${entry.id}/run`, input),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const result = await responses.find((r) => r.status === 200)?.json<HumanRequest>();
  expect(result?.status).toBe("answered");
  expect(result?.response).toMatchObject({ kind: "command", exit_code: 0, stderr: "[REDACTED]" });
  if (result?.response?.kind === "command") {
    expect(result.response.stdout).toContain("edited:[REDACTED]");
    expect(result.response.stdout).toContain(cwd);
  }
  const stored = getSqlite().query("SELECT * FROM human_requests WHERE id=?").get(entry.id);
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect((await req(app, "POST", `/human-requests/${entry.id}/run`, input)).status).toBe(409);
  expect(
    (
      await req(app, "POST", `/human-requests/${entry.id}/acknowledge`, {
        version: result?.version,
      })
    ).status,
  ).toBe(200);
});

test("should report failed commands without automatically retrying", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-command-failure-"));
  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      prompt: "Failure test",
      origin: { backend: "external", session_id: "command-origin", request_id: "command-failure" },
      command: { host: null, cwd, script: "exit 7" },
    })
  ).json<HumanRequest>();
  const response = await req(app, "POST", `/human-requests/${entry.id}/run`, {
    version: 1,
    script:
      process.platform === "win32"
        ? '[Console]::Error.Write("failed"); exit 7'
        : "printf failed >&2; exit 7",
    values: {},
  });
  expect(response.status).toBe(200);
  const completed = await response.json<HumanRequest>();
  expect(completed.response).toMatchObject({ kind: "command", exit_code: 7, stderr: "failed" });
});

test("should reject cancelled, stale, unknown-argument and invalid-folder executions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-command-validation-"));
  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      prompt: "Validation",
      origin: { backend: "external", session_id: "validation", request_id: "validation" },
      command: { host: null, cwd, script: "true" },
    })
  ).json<HumanRequest>();
  expect(
    (
      await req(app, "POST", `/human-requests/${entry.id}/run`, {
        version: 1,
        script: "true",
        values: { UNKNOWN: "value" },
      })
    ).status,
  ).toBe(400);
  await req(app, "POST", `/human-requests/${entry.id}/cancel`, { version: 1 });
  expect(
    (
      await req(app, "POST", `/human-requests/${entry.id}/run`, {
        version: 1,
        script: "true",
        values: {},
      })
    ).status,
  ).toBe(409);
  const invalid = new HumanRequestStore(getSqlite()).create({
    kind: "command",
    prompt: "Invalid folder",
    origin: { backend: "external", session_id: "validation", request_id: "invalid-folder" },
    command: { host: null, cwd: join(cwd, "missing"), script: "true" },
  });
  const rejected = await req(app, "POST", `/human-requests/${invalid.id}/run`, {
    version: invalid.version,
    script: "true",
    values: {},
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({
    error: "The command folder is unavailable on the selected host",
  });
  expect(new HumanRequestStore(getSqlite()).get(invalid.id).status).toBe("pending");
});

test("should enforce a command timeout and bound/redact large output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-command-bounds-"));
  const create = async (request_id: string, timeout_seconds = 10) =>
    (
      await req(app, "POST", "/human-requests", {
        kind: "command",
        prompt: "Bounded execution",
        origin: { backend: "external", session_id: "bounds", request_id },
        command: {
          host: null,
          cwd,
          script: "true",
          timeout_seconds,
          arguments: [{ name: "VALUE", label: "Value", required: false }],
        },
      })
    ).json<HumanRequest>();
  const entry = await create("timeout", 1);
  const before = Date.now();
  const response = await req(app, "POST", `/human-requests/${entry.id}/run`, {
    version: 1,
    script: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30 & wait",
    values: {},
  });
  expect(response.status).toBe(200);
  const completed = await response.json<HumanRequest>();
  expect(Date.now() - before).toBeLessThan(5000);
  expect(completed.response).toMatchObject({ kind: "command", exit_code: -1 });
  const large = await create("large");
  const value = "unique-secret-token";
  const result = await (
    await req(app, "POST", `/human-requests/${large.id}/run`, {
      version: 1,
      script:
        process.platform === "win32"
          ? "for ($index=0; $index -lt 20000; $index++) { [Console]::Out.Write($env:ORC_INPUT_VALUE) }"
          : 'i=0; while [ "$i" -lt 20000 ]; do printf "%s" "$ORC_INPUT_VALUE"; i=$((i+1)); done',
      values: { VALUE: value },
    })
  ).json<HumanRequest>();
  expect(result.response?.kind).toBe("command");
  if (result.response?.kind === "command") {
    expect(result.response.truncated).toBe(true);
    expect(result.response.stdout.length).toBeLessThanOrEqual(64000);
    expect(result.response.stdout).not.toContain(value);
  }
});

test("should stop command descendants on timeout", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-command-descendants-"));
  const marker = join(cwd, "child-survived.txt").replaceAll("'", "''");
  const script =
    process.platform === "win32"
      ? `$child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', "Start-Sleep -Seconds 3; Set-Content -LiteralPath '${marker}' -Value survived") -WindowStyle Hidden -PassThru; $child.WaitForExit()`
      : `(sleep 3; printf survived > '${marker}') & wait`;
  const entry = new HumanRequestStore(getSqlite()).create({
    kind: "command",
    prompt: "Verify timeout cleanup",
    origin: { backend: "test", session_id: "descendants", request_id: "descendants" },
    command: { host: null, cwd, script, timeout_seconds: 1 },
  });
  const response = await req(app, "POST", `/human-requests/${entry.id}/run`, {
    version: entry.version,
    script,
    values: {},
  });
  expect(response.status).toBe(200);
  const completed = await response.json<HumanRequest>();
  expect(completed.response).toMatchObject({ kind: "command", exit_code: -1 });
  await Bun.sleep(3000);
  expect(existsSync(join(cwd, "child-survived.txt"))).toBe(false);
}, 10000);
