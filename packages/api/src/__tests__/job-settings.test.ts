import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
const fixture = mkdtempSync(join(tmpdir(), "orc-job-settings-"));
beforeAll(() => {
  process.env.HOME = fixture;
  process.env.USERPROFILE = fixture;
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  rmSync(fixture, { recursive: true, force: true });
});

test("should encrypt secrets, keep them on edit, redact both output streams and never return saved values", async () => {
  const secret = "test-job-private-value-42";
  const shell =
    process.platform === "win32"
      ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] }
      : { executable: "sh", args: ["-c"] };
  const command =
    process.platform === "win32"
      ? "[Console]::Out.Write($env:PRIVATE_VALUE); [Console]::Error.Write($env:PRIVATE_VALUE)"
      : 'printf %s "$PRIVATE_VALUE"; printf %s "$PRIVATE_VALUE" >&2';
  const response = await req(app, "POST", "/api/jobs", {
    name: "secure-job",
    command,
    trigger_type: "manual",
    settings: { host: null, shell },
    environment: [{ name: "PRIVATE_VALUE", value: secret, secret: true }],
  });
  expect(response.status).toBe(201);
  const job = await response.json();
  expect(JSON.stringify(job)).not.toContain(secret);
  expect(job.environment).toEqual([{ name: "PRIVATE_VALUE", value: null, secret: true }]);
  const stored = getSqlite()
    .query<{ environment: string }, [string]>("SELECT environment FROM jobs WHERE id=?")
    .get(job.id);
  expect(stored?.environment).not.toContain(secret);
  expect(stored?.environment).toContain("enc:v1:");
  const patch = await req(app, "PATCH", `/api/jobs/${job.id}`, {
    environment: job.environment,
    description: "Edited",
  });
  expect(patch.status).toBe(200);
  const run = await req(app, "POST", `/api/jobs/${job.id}/trigger?sync=true&wait_secs=10`);
  expect(run.status).toBe(200);
  const result = await run.json();
  expect(result.status).toBe("success");
  expect(result.stdout).toContain("[REDACTED]");
  expect(result.stderr).toContain("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain(secret);
  const logs = await req(app, "GET", `/api/jobs/${job.id}/runs/${result.run_id}/logs`);
  expect(await logs.text()).not.toContain(secret);
  const list = await req(app, "GET", "/api/jobs");
  expect(await list.text()).not.toContain(secret);
});

test("should reject invalid settings and missing saved secrets before storing a job", async () => {
  for (const extra of [
    { settings: { timezone: "No/Such_Zone" } },
    { environment: [], env_vars: {} },
    {
      action: {
        type: "agent",
        backend: "codex-cli",
        prompt: "Inspect",
        options: { runtime: "acpx", args: [] },
      },
    },
    {
      action: {
        type: "agent",
        backend: "claude",
        prompt: "Inspect",
        options: { runtime: "claude-sdk", options: { permissionMode: "bypassPermissions" } },
      },
    },
    { settings: { host: "-oBadOption" } },
    { settings: { shell: { executable: "sh\0", args: [] } } },
    { settings: { workspace: { mode: "worktree", base_ref: "--bad", cleanup_on_success: true } } },
    { environment: [{ name: "MISSING", value: null, secret: true }] },
    { environment: [{ name: "ORC_API_SECRET", value: "bad", secret: false }] },
    {
      environment: [
        { name: "A", value: "1", secret: false },
        { name: "a", value: "2", secret: true },
      ],
    },
  ]) {
    const response = await req(app, "POST", "/api/jobs", {
      name: `invalid-${crypto.randomUUID()}`,
      command: "echo ok",
      trigger_type: "manual",
      ...extra,
    });
    expect(response.status).toBe(400);
  }
});

test("should return timezone-aware next runs and preserve existing jobs without settings", async () => {
  const response = await req(app, "POST", "/api/jobs", {
    name: "timed-job",
    command: "echo ok",
    trigger_type: "cron",
    cron_expr: "0 9 * * *",
    enabled: true,
    settings: { timezone: "Asia/Jerusalem" },
  });
  const job = await response.json();
  expect(response.status).toBe(201);
  expect(new Date(job.next_run_at).getTime()).toBeGreaterThan(Date.now());
  expect(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Jerusalem",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(job.next_run_at)),
  ).toBe("09");
  const legacy = await req(app, "POST", "/api/jobs", {
    name: "legacy-settings",
    command: "echo legacy",
    trigger_type: "manual",
    env_vars: { PLAIN: "example" },
  });
  const value = await legacy.json();
  expect(value.settings).toBeNull();
  expect(value.environment).toEqual([{ name: "PLAIN", value: "example", secret: false }]);
  expect(value.env_vars).toBeUndefined();
});
