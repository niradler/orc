import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isEncryptedSecret } from "@orc/core/secrets";
import { getDb } from "@orc/db/client";
import { job_runs, webhook_deliveries, webhooks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const sign = (secret: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
async function waitForRun(id: string) {
  for (let i = 0; i < 100; i++) {
    const run = await getDb().query.job_runs.findFirst({ where: eq(job_runs.id, id) });
    if (run && !["pending", "running"].includes(run.status)) return run;
    await Bun.sleep(50);
  }
  throw new Error("job did not finish");
}

beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
});

describe("managed webhooks", () => {
  test("should configure a disabled job without enabling it or allowing an event to run it", async () => {
    const job = await (
      await req(app, "POST", "/jobs", {
        name: "disabled-hook-job",
        command: "echo disabled",
        trigger_type: "webhook",
      })
    ).json();
    expect(job.enabled).toBe(false);
    const create = await req(app, "POST", "/webhooks", {
      name: "Disabled job hook",
      provider: "generic",
      job_id: job.id,
    });
    expect(create.status).toBe(201);
    const hook = await create.json();
    const body = JSON.stringify({ event: "test" });
    const response = await app.request(`/webhooks/${hook.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orc-signature-256": sign(hook.secret, body),
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as { accepted: boolean }).accepted).toBe(false);
    expect(
      await getDb().query.job_runs.findMany({ where: eq(job_runs.job_id, job.id) }),
    ).toHaveLength(0);
    const saved = await (await req(app, "GET", `/jobs/${job.id}`)).json();
    expect(saved.enabled).toBe(false);
  });
  test("generic delivery verifies, deduplicates, and reaches job stdin", async () => {
    const jobResponse = await req(app, "POST", "/jobs", {
      name: "webhook-stdin-job",
      enabled: true,
      command:
        "bun -e 'process.stdout.write((await Bun.stdin.text())+\"|\"+Bun.env.ORC_WEBHOOK_EVENT)'",
      trigger_type: "webhook",
    });
    const job = await jobResponse.json();
    const create = await req(app, "POST", "/webhooks", {
      name: "Deploy hook",
      provider: "generic",
      job_id: job.id,
      events: ["deploy"],
      actions: ["start"],
    });
    expect(create.status).toBe(201);
    const hook = await create.json();
    expect(hook.secret).toBeTruthy();
    const stored = await getDb().query.webhooks.findFirst({ where: eq(webhooks.id, hook.id) });
    expect(isEncryptedSecret(stored?.secret ?? "")).toBe(true);
    const listed = await (await req(app, "GET", "/webhooks")).json();
    expect(listed.webhooks[0].secret).toBeUndefined();

    const body = JSON.stringify({ action: "start", value: 42 });
    const headers = {
      "content-type": "application/json",
      "x-orc-event": "deploy",
      "x-orc-delivery": "delivery-1",
      "x-orc-signature-256": sign(hook.secret, body),
    };
    const accepted = await app.request(`/webhooks/${hook.token}`, {
      method: "POST",
      headers,
      body,
    });
    expect(accepted.status).toBe(202);
    const result = (await accepted.json()) as { accepted: boolean; run_id: string };
    expect(result.accepted).toBe(true);
    const run = await waitForRun(result.run_id);
    expect(run.status).toBe("success");
    expect(run.stdout).toBe(`${body}|deploy`);

    const duplicate = await app.request(`/webhooks/${hook.token}`, {
      method: "POST",
      headers,
      body,
    });
    expect(duplicate.status).toBe(409);
    expect(
      await getDb().query.webhook_deliveries.findMany({
        where: eq(webhook_deliveries.webhook_id, hook.id),
      }),
    ).toHaveLength(1);
  });

  test("GitHub uses its signature headers and filters arbitrary events", async () => {
    const jobResponse = await req(app, "POST", "/jobs", {
      name: "github-webhook-job",
      command: "true",
      trigger_type: "webhook",
    });
    const job = await jobResponse.json();
    const create = await req(app, "POST", "/webhooks", {
      name: "PR hook",
      provider: "github",
      job_id: job.id,
      events: ["pull_request", "pull_request_review", "pull_request_review_comment"],
      actions: ["opened", "submitted"],
    });
    const hook = await create.json();
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "acme/widget" },
    });
    const ignored = await app.request(`/webhooks/${hook.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": "github-1",
        "x-hub-signature-256": sign(hook.secret, body),
      },
      body,
    });
    expect(ignored.status).toBe(202);
    expect(((await ignored.json()) as { accepted: boolean }).accepted).toBe(false);

    const invalid = await app.request(`/webhooks/${hook.token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "github-2",
        "x-hub-signature-256": "sha256=bad",
      },
      body,
    });
    expect(invalid.status).toBe(401);
    expect(
      await getDb().query.job_runs.findMany({
        where: eq(job_runs.job_id, job.id),
      }),
    ).toHaveLength(0);
  });
});
