import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { HumanRequest, SecretClaimResult } from "@orc/core/human-requests";
import type { ProjectSecretCheckResult, ProjectSecretMetadata } from "@orc/core/project-secrets";
import { resetRedactedSecrets } from "@orc/core/secret-redactor";
import { getDb, getSqlite } from "@orc/db/client";
import { job_run_logs, job_runs } from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { eq } from "drizzle-orm";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;

beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);
afterEach(() => {
  resetRedactedSecrets();
});

async function createProject(name: string): Promise<{ id: string; name: string }> {
  const res = await req(app, "POST", "/projects", { name });
  expect(res.status).toBe(201);
  return res.json<{ id: string; name: string }>();
}

test("authenticates secret claim and project secret endpoints", async () => {
  for (const [method, path] of [
    ["POST", "/api/human-requests/missing/claim"],
    ["GET", "/api/projects/p1/secrets"],
    ["POST", "/api/projects/p1/secrets"],
    ["PUT", "/api/projects/p1/secrets/foo"],
    ["DELETE", "/api/projects/p1/secrets/foo"],
    ["POST", "/api/projects/p1/secrets/foo/check"],
  ] as const) {
    expect((await app.request(path, { method })).status).toBe(401);
  }
});

test("delivers multi-field secret once without persisting plaintext anywhere", async () => {
  const project = await createProject("secret-direct-proj");
  const createdRes = await req(app, "POST", "/human-requests", {
    project_id: project.id,
    kind: "secret",
    title: "Connect OpenAI",
    prompt: "Enter API key and base URL.",
    fields: [
      { key: "OPENAI_API_KEY", label: "OpenAI API key", required: true },
      { key: "BASE_URL", label: "Base URL", required: true },
    ],
    origin: { backend: "codex", session_id: "secret-sess-1", request_id: "r1" },
  });
  expect(createdRes.status).toBe(200);
  const created = await createdRes.json<HumanRequest>();

  const apiKey = "sk-live-secret-alpha-7711";
  const baseUrl = "https://secret-endpoint.internal.test/v1";
  const respondRes = await req(app, "POST", `/human-requests/${created.id}/respond`, {
    version: created.version,
    response: {
      kind: "secret",
      values: { OPENAI_API_KEY: apiKey, BASE_URL: baseUrl },
      save_to_project: false,
    },
  });
  expect(respondRes.status).toBe(200);
  const respondText = await respondRes.text();
  expect(respondText).not.toContain(apiKey);
  expect(respondText).not.toContain(baseUrl);

  const readText = await (await req(app, "GET", `/human-requests/${created.id}`)).text();
  expect(readText).not.toContain(apiKey);
  expect(readText).not.toContain(baseUrl);

  const sqlite = getSqlite();
  const dbDump = JSON.stringify([
    sqlite.query("SELECT * FROM human_requests").all(),
    sqlite.query("SELECT * FROM audit_log").all(),
    sqlite.query("SELECT * FROM notifications").all(),
  ]);
  expect(dbDump).not.toContain(apiKey);
  expect(dbDump).not.toContain(baseUrl);

  const claimRes = await req(app, "POST", `/human-requests/${created.id}/claim`);
  expect(claimRes.status).toBe(200);
  const claimed = await claimRes.json<SecretClaimResult>();
  expect(claimed.secret).toBe(true);
  expect(claimed.stored).toBe(false);
  expect(claimed.values).toEqual({ OPENAI_API_KEY: apiKey, BASE_URL: baseUrl });

  const duplicate = await req(app, "POST", `/human-requests/${created.id}/claim`);
  expect(duplicate.status).toBe(409);
  const dupBody = await duplicate.json<{ consumed?: boolean }>();
  expect(dupBody.consumed).toBe(true);

  const ack = await req(app, "POST", `/human-requests/${created.id}/acknowledge`, {
    version: claimed.request.version,
  });
  expect(ack.status).toBe(200);
  expect((await ack.json<HumanRequest>()).status).toBe("delivered");
});

test("saves to project secrets, injects into jobs, redacts logs, rotates, checks, and deletes", async () => {
  const project = await createProject("secret-store-proj");
  const initialValue = "sk-proj-secret-initial-4422";
  const rotatedValue = "sk-proj-secret-rotated-9988";

  const created = await (
    await req(app, "POST", "/human-requests", {
      project_id: project.id,
      kind: "secret",
      title: "Save API key",
      prompt: "Save key for recurring jobs.",
      save_to_project: true,
      fields: [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API key",
          required: true,
          reference_name: "openai-key",
        },
      ],
      origin: { backend: "codex", session_id: "secret-sess-2", request_id: "r2" },
    })
  ).json<HumanRequest>();

  const answered = await (
    await req(app, "POST", `/human-requests/${created.id}/respond`, {
      version: created.version,
      response: {
        kind: "secret",
        values: { OPENAI_API_KEY: initialValue },
        save_to_project: true,
        reference_names: { OPENAI_API_KEY: "openai-key" },
      },
    })
  ).json<HumanRequest>();
  expect(answered.response).toEqual({
    kind: "secret",
    stored: true,
    references: { OPENAI_API_KEY: "project/openai-key" },
    delivered_fields: ["OPENAI_API_KEY"],
    consumed: false,
  });

  const claimed = await (
    await req(app, "POST", `/human-requests/${created.id}/claim`)
  ).json<SecretClaimResult>();
  expect(claimed.stored).toBe(true);
  expect(claimed.values).toBeUndefined();
  expect(claimed.references).toEqual({ OPENAI_API_KEY: "project/openai-key" });

  const listRes = await req(app, "GET", `/projects/${project.id}/secrets`);
  expect(listRes.status).toBe(200);
  const listText = await listRes.text();
  expect(listText).not.toContain(initialValue);
  const listed = JSON.parse(listText) as { secrets: ProjectSecretMetadata[] };
  expect(listed.secrets).toHaveLength(1);
  expect(listed.secrets[0]?.reference).toBe("project/openai-key");
  expect(listed.secrets[0]?.last_used_at).toBeNull();

  // Execute a job referencing project/openai-key and verify injection + redaction + last_used_at.
  const jobRes = await req(app, "POST", "/jobs", {
    name: "secret-ref-job",
    project_id: project.id,
    command:
      'printf "LEN=%s RAW=%s" "$(printf %s "$OPENAI_API_KEY" | wc -c | tr -d " ")" "$OPENAI_API_KEY"',
    trigger_type: "manual",
    environment: [{ name: "OPENAI_API_KEY", value: "project/openai-key", secret: false }],
  });
  expect(jobRes.status).toBe(201);
  const job = await jobRes.json<{ id: string }>();

  const runId = await executeJob({ jobId: job.id });
  const run = await getDb().query.job_runs.findFirst({ where: eq(job_runs.id, runId) });
  expect(run?.status).toBe("success");
  expect(run?.stdout).toContain(`LEN=${initialValue.length}`);
  expect(run?.stdout).toContain("RAW=[REDACTED]");
  expect(run?.stdout).not.toContain(initialValue);

  const logs = await getDb().query.job_run_logs.findMany({ where: eq(job_run_logs.run_id, runId) });
  expect(JSON.stringify(logs)).not.toContain(initialValue);

  const afterRunList = await (await req(app, "GET", `/projects/${project.id}/secrets`)).json<{
    secrets: ProjectSecretMetadata[];
  }>();
  expect(afterRunList.secrets[0]?.last_used_at).not.toBeNull();

  // HTTP validation check against a local 127.0.0.1 server verifying header injection without leaking value.
  let seenAuth = "";
  const checkServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seenAuth = request.headers.get("authorization") ?? "";
      return new Response(`echo:${seenAuth}`, {
        status: seenAuth === `Bearer ${rotatedValue}` ? 200 : 401,
      });
    },
  });
  try {
    const rotateRes = await req(app, "PUT", `/projects/${project.id}/secrets/openai-key`, {
      value: rotatedValue,
      description: "Rotated key",
      check: {
        type: "http",
        url: `http://127.0.0.1:${checkServer.port}/verify`,
      },
    });
    expect(rotateRes.status).toBe(200);
    expect(await rotateRes.text()).not.toContain(rotatedValue);

    const checkRes = await req(app, "POST", `/projects/${project.id}/secrets/openai-key/check`, {});
    expect(checkRes.status).toBe(200);
    const checkText = await checkRes.text();
    expect(checkText).not.toContain(rotatedValue);
    const checkResult = JSON.parse(checkText) as ProjectSecretCheckResult;
    expect(checkResult.ok).toBe(true);
    expect(checkResult.mode).toBe("http");
    expect(checkResult.status).toBe(200);
    expect(seenAuth).toBe(`Bearer ${rotatedValue}`);
  } finally {
    checkServer.stop(true);
  }

  // Delete secret: next job run fails cleanly instead of using the deleted secret.
  const delRes = await req(app, "DELETE", `/projects/${project.id}/secrets/openai-key`);
  expect(delRes.status).toBe(204);
  await expect(executeJob({ jobId: job.id })).rejects.toThrow("not found");
});

test("rate-limits excessive secret requests per session with HTTP 429", async () => {
  for (let i = 0; i < 10; i++) {
    const res = await req(app, "POST", "/human-requests", {
      kind: "secret",
      prompt: `Secret ${i}`,
      fields: [{ key: "TOKEN", label: "Token" }],
      origin: { backend: "codex", session_id: "rate-limit-sess", request_id: `rl-${i}` },
    });
    expect(res.status).toBe(200);
  }
  const blocked = await req(app, "POST", "/human-requests", {
    kind: "secret",
    prompt: "Secret 11",
    fields: [{ key: "TOKEN", label: "Token" }],
    origin: { backend: "codex", session_id: "rate-limit-sess", request_id: "rl-10" },
  });
  expect(blocked.status).toBe(429);
});
