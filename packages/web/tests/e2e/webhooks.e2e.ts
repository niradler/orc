import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

async function newWebhookJob(
  page: Page,
  name: string,
  sourceId: string,
  kind: "command" | "task" | "agent" = "command",
) {
  await gotoView(page, "jobs");
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-name-input").fill(name);
  await page.getByTestId("job-action-type").selectOption(kind);
  if (kind === "command")
    await page.getByTestId("job-command-input").fill("echo reusable-webhook-ok");
  if (kind === "task") {
    await page.getByTestId("job-task-title").fill("Review received event");
    await expect(page.getByTestId("job-task-autostart")).not.toBeChecked();
  }
  if (kind === "agent")
    await page.getByTestId("job-agent-prompt").fill("Review the event and report findings");
  await page.getByTestId("job-trigger-type").click();
  await page.getByTestId("job-trigger-webhook").click();
  await page.getByTestId("job-webhook-select").selectOption(sourceId);
}

test("standalone source connects multiple typed jobs, filters deliveries and reopens safely", async ({
  page,
  request,
}) => {
  const sourceName = tid("shared-source");
  await gotoView(page, "jobs");
  await page.getByTestId("nav-webhooks").click();
  await page.getByTestId("new-webhook-button").click();
  await page.getByTestId("webhook-name").fill(sourceName);
  await page.getByTestId("webhook-provider").selectOption("generic");
  await page.getByTestId("webhook-create").click();
  const secret = await page.getByTestId("webhook-secret").innerText();
  const url = await page.getByTestId("webhook-created").getByTestId("webhook-url").innerText();
  await page.getByTestId("webhook-setup-done").click();
  const hook = page.getByTestId("webhook-endpoint").filter({ hasText: sourceName });
  await expect(hook.getByTestId("webhook-connected-jobs")).toContainText("Connected jobs (0)");
  const sourceId = await hook.getAttribute("data-webhook-id");
  if (!sourceId) throw new Error("Source ID missing");

  const commandName = tid("command-subscriber");
  await newWebhookJob(page, commandName, sourceId);
  await expect(page.getByTestId("job-create-enabled")).not.toBeChecked();
  await page.getByTestId("webhook-events").pressSequentially("build, deploy");
  await expect(page.getByTestId("webhook-events")).toHaveValue("build, deploy");
  await page.getByTestId("webhook-actions").fill("completed");
  await page.getByTestId("job-create-enabled").check();
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-name-input")).toHaveCount(0);

  const taskName = tid("task-subscriber");
  await newWebhookJob(page, taskName, sourceId, "task");
  await expect(page.getByTestId("job-command-input")).toHaveCount(0);
  await page.getByTestId("webhook-events").fill("build");
  await page.getByTestId("job-create-enabled").check();
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-name-input")).toHaveCount(0);

  const { jobs } = await apiGet<{ jobs: { id: string; name: string; action: { type: string } }[] }>(
    request,
    "/jobs",
  );
  const taskJob = jobs.find((job) => job.name === taskName);
  if (!taskJob) throw new Error("Task job missing");
  expect(taskJob.action.type).toBe("task");
  const body = JSON.stringify({ action: "completed", repository: { full_name: "example/repo" } });
  const headers = {
    "content-type": "application/json",
    "X-Orc-Event": "build",
    "X-Orc-Delivery": tid("delivery"),
    "X-Orc-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
  expect(
    (
      await request.post(url, {
        data: body,
        headers: { ...headers, "X-Orc-Signature-256": "sha256=invalid" },
      })
    ).status(),
  ).toBe(401);
  const delivery = await request.post(url, { data: body, headers });
  expect(delivery.status()).toBe(202);
  expect((await delivery.json()).run_ids).toHaveLength(2);
  expect((await request.post(url, { data: body, headers })).status()).toBe(409);
  await page.getByTestId("nav-webhooks").click();
  await expect(hook.getByTestId("webhook-connected-jobs")).toContainText("Connected jobs (2)");
  await hook.getByTestId("webhook-deliveries-toggle").click();
  await expect(hook.getByTestId("webhook-delivery")).toContainText("success", { timeout: 20_000 });
  await expect(hook.getByTestId("webhook-secret")).toHaveCount(0);
  await page.screenshot({
    path: resolve("../../.claude/docs/webhook-manager-desktop.png"),
    fullPage: true,
  });

  await hook.getByTestId("webhook-job-link").filter({ hasText: taskName }).click();
  await expect(page.getByTestId("job-run-task-link")).toBeVisible();
  await page.getByTestId("job-detail-edit").click();
  await expect(page.getByTestId("job-action-type")).toHaveValue("task");
  await expect(page.getByTestId("webhook-events")).toHaveValue("build");
  await page.getByTestId("webhook-events").fill("build, deploy");
  await page.getByTestId("job-edit-submit").click();
  await expect(page.getByTestId("job-edit-submit")).toHaveCount(0);
  await page.goto(`/jobs/${taskJob.id}?project=all`);
  await page.getByTestId("job-detail-edit").click();
  await expect(page.getByTestId("webhook-events")).toHaveValue("build, deploy");
  await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
});

test("inline source creation retries safely and agent action needs no command", async ({
  page,
  request,
}) => {
  const name = tid("inline-agent");
  await gotoView(page, "jobs");
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-name-input").fill(name);
  await page.getByTestId("job-action-type").selectOption("agent");
  await page.getByTestId("job-agent-prompt").fill("Inspect the incoming event");
  await page.getByTestId("job-trigger-type").click();
  await page.getByTestId("job-trigger-webhook").click();
  await page.getByTestId("webhook-add").click();
  await page.getByTestId("webhook-name").fill(name);
  await page.route("**/api/webhooks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary source failure" }),
    });
    await page.unroute("**/api/webhooks");
  });
  await page.getByTestId("webhook-create").click();
  await expect(page.getByRole("alert")).toContainText("Temporary source failure");
  await page.getByTestId("webhook-create").click();
  await expect(page.getByTestId("webhook-created")).toBeVisible();
  await page.getByTestId("webhook-setup-done").click();
  await expect(page.getByTestId("job-webhook-binding")).toHaveCount(1);
  await page.getByTestId("job-submit").click();
  await expect(page.getByTestId("job-name-input")).toHaveCount(0);
  const { jobs } = await apiGet<{
    jobs: { name: string; enabled: boolean; action: { type: string }; command: string }[];
  }>(request, "/jobs");
  const job = jobs.find((item) => item.name === name);
  if (!job) throw new Error("Agent job missing");
  expect(job.action.type).toBe("agent");
  expect(job.enabled).toBe(false);
  expect(job.command).toBe("");
});

test("mobile navigation opens configured sources and job connections without overflow", async ({
  page,
  request,
}) => {
  const name = tid("mobile-source");
  const hook = await apiPost<{ id: string }>(request, "/webhooks", { name, provider: "github" });
  await apiPost(request, "/jobs", {
    name: tid("mobile-subscriber"),
    action: { type: "task", title: "Review mobile event" },
    trigger_type: "webhook",
    webhooks: [{ webhook_id: hook.id, events: ["push"] }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "activity");
  await page.getByTestId("nav-webhooks").click();
  const endpoint = page.getByTestId("webhook-endpoint").filter({ hasText: name });
  await expect(endpoint).toContainText("Connected jobs (1)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  await endpoint.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve("../../.claude/docs/webhook-manager-mobile-light.png"),
    fullPage: true,
  });
  await endpoint.getByTestId("webhook-job-link").click();
  await expect(page.getByTestId("job-webhooks")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("project-scoped job picker offers shared and matching sources only", async ({
  page,
  request,
}) => {
  const first = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("source-scope-a"),
  });
  const second = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("source-scope-b"),
  });
  const shared = await apiPost<{ id: string }>(request, "/webhooks", {
    name: tid("global-source"),
    provider: "github",
  });
  const own = await apiPost<{ id: string }>(request, "/webhooks", {
    name: tid("own-source"),
    provider: "github",
    project_id: first.id,
  });
  const other = await apiPost<{ id: string }>(request, "/webhooks", {
    name: tid("other-source"),
    provider: "github",
    project_id: second.id,
  });
  await gotoView(page, "jobs");
  await page.goto(`/jobs?project=${first.id}`);
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-trigger-type").click();
  await page.getByTestId("job-trigger-webhook").click();
  const picker = page.getByTestId("job-webhook-select");
  await expect(picker.locator(`option[value="${own.id}"]`)).toHaveCount(1);
  await expect(picker.locator(`option[value="${shared.id}"]`)).toHaveCount(1);
  await expect(picker.locator(`option[value="${other.id}"]`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/jobs?project=all");
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-trigger-type").click();
  await page.getByTestId("job-trigger-webhook").click();
  await expect(picker.locator(`option[value="${shared.id}"]`)).toHaveCount(1);
  await expect(picker.locator(`option[value="${own.id}"]`)).toHaveCount(0);
});
