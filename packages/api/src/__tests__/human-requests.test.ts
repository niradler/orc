import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { hostAlias, resolveExecHost } from "@orc/core/exec-host";
import type { HumanRequest } from "@orc/core/human-requests";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { RuleStore } from "@orc/db/rules";
import { removeTempTree, req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await removeTempTree(dir);
}, 20_000);
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
    ["GET", "/missing/view"],
    ["POST", "/missing/respond"],
    ["POST", "/missing/snooze"],
    ["DELETE", "/missing/snooze"],
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

test("should record when the agent reads an answer so ORC never pushes it", async () => {
  const created = await (
    await req(app, "POST", "/human-requests", {
      ...input,
      origin: { ...input.origin, request_id: "request-seen" },
    })
  ).json<HumanRequest>();
  await req(app, "POST", `/human-requests/${created.id}/respond`, {
    version: created.version,
    response: { kind: "question", answer: "Green" },
  });
  const read = await (await req(app, "GET", `/human-requests/${created.id}`)).json<HumanRequest>();
  expect(read.seen_at).toBeNumber();
  expect(read.push_state).toBeNull();
  const again = await (await req(app, "GET", `/human-requests/${created.id}`)).json<HumanRequest>();
  expect(again.seen_at).toBe(read.seen_at);
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

test("should pin command hosts at creation to the default or a configured alias", async () => {
  const command = (request_id: string, host?: string | null) => ({
    kind: "command",
    prompt: "Host selection",
    origin: { backend: "external", session_id: "host-selection", request_id },
    command: { cwd: "/srv", script: "true", ...(host === undefined ? {} : { host }) },
  });
  const unknown = await req(app, "POST", "/human-requests", command("unknown", "machine-hostname"));
  expect(unknown.status).toBe(400);
  expect((await unknown.json<{ error: string }>()).error).toContain(
    'Unknown SSH host "machine-hostname"',
  );
  const defaulted = await (
    await req(app, "POST", "/human-requests", command("default"))
  ).json<HumanRequest>();
  expect(defaulted.input.command?.host).toBe(hostAlias(resolveExecHost()));
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
    const workspace = tempDir("orc-human-revision-");
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
  const cwd = tempDir("orc-command-");
  const secret = "p@ss'\"$()do-not-expand";
  const account = "private-account@example.invalid";
  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      title: "Check the service connection",
      prompt: "Run a credential check",
      origin: { backend: "external", session_id: "command-origin", request_id: "command-once" },
      command: {
        host: null,
        cwd,
        script: "printf original",
        arguments: [
          {
            name: "PASSWORD",
            label: "Password",
            description: "Used only for this connection check",
          },
          { name: "ACCOUNT", label: "Account" },
        ],
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
        ? '[Console]::Out.Write("edited:" + $env:ORC_INPUT_PASSWORD + "|" + $env:ORC_INPUT_ACCOUNT); [Console]::Error.Write($env:ORC_INPUT_PASSWORD); (Get-Location).Path'
        : 'printf "edited:"; printf "%s|%s" "$ORC_INPUT_PASSWORD" "$ORC_INPUT_ACCOUNT"; printf "%s" "$ORC_INPUT_PASSWORD" >&2; pwd',
    values: { PASSWORD: secret, ACCOUNT: account },
  };
  const responses = await Promise.all([
    req(app, "POST", `/human-requests/${entry.id}/run`, input),
    req(app, "POST", `/human-requests/${entry.id}/run`, input),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const result = await responses.find((r) => r.status === 200)?.json<HumanRequest>();
  expect(result?.status).toBe("answered");
  expect(result?.input.title).toBe("Check the service connection");
  expect(result?.response).toMatchObject({ kind: "command", exit_code: 0, stderr: "[REDACTED]" });
  if (result?.response?.kind === "command") {
    expect(result.response.stdout).toContain("edited:[REDACTED]|[REDACTED]");
    expect(result.response.stdout).toContain(cwd);
  }
  const stored = getSqlite().query("SELECT * FROM human_requests WHERE id=?").get(entry.id);
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect(JSON.stringify(stored)).not.toContain(account);
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
  const cwd = tempDir("orc-command-failure-");
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
  const cwd = tempDir("orc-command-validation-");
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
  const cwd = tempDir("orc-command-bounds-");
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
  // Two shell runs (timeout + 20k-write loop); the kill bound is asserted above.
}, 15000);

test("should stop command descendants on timeout", async () => {
  const cwd = tempDir("orc-command-descendants-");
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

test("should snooze and unsnooze pending requests, exclude them from unread count, and wake due snoozes once", async () => {
  const { wakeDueHumanRequestSnoozes } = await import("../notifications.js");
  const created = await (
    await req(app, "POST", "/human-requests", {
      ...input,
      title: "Snooze API test",
      origin: { backend: "codex", session_id: "snooze-api", request_id: "snooze-api-1" },
    })
  ).json<HumanRequest>();

  const beforePage = await (await req(app, "GET", "/notifications?unread=true")).json<{
    notifications: { source_id: string }[];
    snoozed: { source_id: string }[];
    unread: number;
  }>();
  expect(beforePage.notifications.some((n) => n.source_id === created.id)).toBe(true);
  expect(beforePage.snoozed.some((n) => n.source_id === created.id)).toBe(false);
  const unreadBefore = beforePage.unread;

  // Reject missing or conflicting timing inputs and past timestamps.
  expect(
    (await req(app, "POST", `/human-requests/${created.id}/snooze`, { version: 1 })).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", `/human-requests/${created.id}/snooze`, {
        version: 1,
        until: Date.now() + 60_000,
        after_seconds: 60,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", `/human-requests/${created.id}/snooze`, {
        version: 1,
        until: Date.now() - 1000,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", `/human-requests/${created.id}/snooze`, {
        version: 1,
        until: 9_000_000_000_000_000,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", `/human-requests/${created.id}/snooze`, {
        version: 1,
        until: Date.now() + 400 * 86400 * 1000,
      })
    ).status,
  ).toBe(400);

  // Snooze for 1 hour: leaves active notifications & drops unread count by 1.
  const snoozedRes = await req(app, "POST", `/human-requests/${created.id}/snooze`, {
    version: created.version,
    after_seconds: 3600,
  });
  expect(snoozedRes.status).toBe(200);
  const snoozed = await snoozedRes.json<HumanRequest>();
  expect(snoozed.status).toBe("pending");
  expect(snoozed.expires_at).toBe(created.expires_at);
  expect(snoozed.snooze_until).toBeGreaterThan(Date.now() + 3_500_000);

  const snoozedPage = await (await req(app, "GET", "/notifications?unread=true")).json<{
    notifications: { source_id: string }[];
    snoozed: { source_id: string; snooze_until: number | null }[];
    unread: number;
  }>();
  expect(snoozedPage.notifications.some((n) => n.source_id === created.id)).toBe(false);
  expect(snoozedPage.snoozed.find((n) => n.source_id === created.id)?.snooze_until).toBe(
    snoozed.snooze_until,
  );
  expect(snoozedPage.unread).toBe(unreadBefore - 1);

  // Wake now via DELETE restores it to active unread list.
  const wokenRes = await req(
    app,
    "DELETE",
    `/human-requests/${created.id}/snooze?version=${snoozed.version}`,
  );
  expect(wokenRes.status).toBe(200);
  expect((await wokenRes.json<HumanRequest>()).snooze_until).toBeNull();
  const afterWake = await (await req(app, "GET", "/notifications?unread=true")).json<{
    notifications: { source_id: string }[];
    snoozed: { source_id: string }[];
    unread: number;
  }>();
  expect(afterWake.notifications.some((n) => n.source_id === created.id)).toBe(true);
  expect(afterWake.snoozed.some((n) => n.source_id === created.id)).toBe(false);
  expect(afterWake.unread).toBe(unreadBefore);

  // Re-snooze and trigger wake sweep at due time: wakes once.
  const dueUntil = Date.now() + 30_000;
  await req(app, "POST", `/human-requests/${created.id}/snooze`, {
    version: created.version,
    until: dueUntil,
  });
  expect(wakeDueHumanRequestSnoozes(getSqlite(), dueUntil + 1).map((r) => r.id)).toContain(
    created.id,
  );
  expect(wakeDueHumanRequestSnoozes(getSqlite(), dueUntil + 2)).toEqual([]);

  // Answered request rejects snooze with 409.
  await req(app, "POST", `/human-requests/${created.id}/respond`, {
    version: created.version,
    response: { kind: "question", answer: "Blue" },
  });
  const rejectNonPending = await req(app, "POST", `/human-requests/${created.id}/snooze`, {
    version: created.version + 1,
    after_seconds: 600,
  });
  expect(rejectNonPending.status).toBe(409);
});

test("should resolve a saved project secret for a command argument, inject and redact it, and fail closed without a project", async () => {
  const cwd = tempDir("orc-command-ref-");
  const project = await (await req(app, "POST", "/projects", { name: "command-ref-proj" })).json<{
    id: string;
  }>();
  const secretValue = "sk-command-ref-secret-3131";
  expect(
    (
      await req(app, "POST", `/projects/${project.id}/secrets`, {
        name: "deploy-token",
        value: secretValue,
      })
    ).status,
  ).toBe(201);

  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      project_id: project.id,
      prompt: "Run with a saved secret",
      origin: { backend: "test", session_id: "command-ref", request_id: "command-ref-1" },
      command: {
        host: null,
        cwd,
        script: "true",
        arguments: [{ name: "TOKEN", label: "Deploy token", allow_secret_ref: true }],
      },
    })
  ).json<HumanRequest>();

  const script =
    process.platform === "win32"
      ? '[Console]::Out.Write("LEN=" + ($env:ORC_INPUT_TOKEN).Length + " RAW=" + $env:ORC_INPUT_TOKEN)'
      : 'printf "LEN=%s RAW=%s" "$(printf %s "$ORC_INPUT_TOKEN" | wc -c | tr -d " ")" "$ORC_INPUT_TOKEN"';
  const runRes = await req(app, "POST", `/human-requests/${entry.id}/run`, {
    version: entry.version,
    script,
    values: { TOKEN: "project/deploy-token" },
  });
  expect(runRes.status).toBe(200);
  const completed = await runRes.json<HumanRequest>();
  expect(completed.response).toMatchObject({ kind: "command", exit_code: 0 });
  if (completed.response?.kind === "command") {
    expect(completed.response.stdout).toContain(`LEN=${secretValue.length}`);
    expect(completed.response.stdout).toContain("RAW=[REDACTED]");
    expect(completed.response.stdout).not.toContain(secretValue);
  }
  const stored = getSqlite().query("SELECT * FROM human_requests WHERE id=?").get(entry.id);
  expect(JSON.stringify(stored)).not.toContain(secretValue);
  const listed = await (await req(app, "GET", `/projects/${project.id}/secrets`)).json<{
    secrets: { last_used_at: string | null }[];
  }>();
  expect(listed.secrets[0]?.last_used_at).not.toBeNull();

  // A command request without a project cannot resolve a reference: fail closed.
  const noProject = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      prompt: "No project",
      origin: { backend: "test", session_id: "command-ref", request_id: "command-ref-2" },
      command: {
        host: null,
        cwd,
        script: "true",
        arguments: [{ name: "TOKEN", label: "Token", allow_secret_ref: true }],
      },
    })
  ).json<HumanRequest>();
  const failRes = await req(app, "POST", `/human-requests/${noProject.id}/run`, {
    version: noProject.version,
    script: "true",
    values: { TOKEN: "project/deploy-token" },
  });
  expect(failRes.status).toBe(400);
});

test("should keep non-opted-in command arguments literal and reject an unknown project_id", async () => {
  const cwd = tempDir("orc-command-literal-");
  const project = await (
    await req(app, "POST", "/projects", { name: "command-literal-proj" })
  ).json<{ id: string }>();
  const secretValue = "sk-literal-collision-secret-7272";
  await req(app, "POST", `/projects/${project.id}/secrets`, {
    name: "config",
    value: secretValue,
  });

  // PATH is not opted in, so the literal project/config must pass through untouched
  // even though a secret named config exists.
  const entry = await (
    await req(app, "POST", "/human-requests", {
      kind: "command",
      project_id: project.id,
      prompt: "Literal path argument",
      origin: { backend: "test", session_id: "command-literal", request_id: "command-literal-1" },
      command: {
        host: null,
        cwd,
        script: "true",
        arguments: [{ name: "PATH_ARG", label: "Path" }],
      },
    })
  ).json<HumanRequest>();
  // The literal value is itself redacted from output (all inputs are), so prove it
  // passed through by its length: project/config (14), not the stored secret.
  const script =
    process.platform === "win32"
      ? '[Console]::Out.Write("LEN=" + ($env:ORC_INPUT_PATH_ARG).Length)'
      : 'printf "LEN=%s" "$(printf %s "$ORC_INPUT_PATH_ARG" | wc -c | tr -d " ")"';
  const runRes = await req(app, "POST", `/human-requests/${entry.id}/run`, {
    version: entry.version,
    script,
    values: { PATH_ARG: "project/config" },
  });
  expect(runRes.status).toBe(200);
  const completed = await runRes.json<HumanRequest>();
  if (completed.response?.kind === "command") {
    expect(completed.response.stdout).toContain(`LEN=${"project/config".length}`);
    expect(completed.response.stdout).not.toContain(`LEN=${secretValue.length}`);
    expect(completed.response.stdout).not.toContain(secretValue);
  }

  // A non-existent project_id is rejected at creation now that it selects a secret namespace.
  const badProject = await req(app, "POST", "/human-requests", {
    kind: "command",
    project_id: "does-not-exist",
    prompt: "Unknown project",
    origin: { backend: "test", session_id: "command-literal", request_id: "command-literal-2" },
    command: { host: null, cwd, script: "true" },
  });
  expect(badProject.status).toBe(400);
});
