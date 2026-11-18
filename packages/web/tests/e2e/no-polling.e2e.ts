import { createHmac } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { API_BASE, apiDelete, apiPost, gotoView, tid } from "./_helpers";

const IDLE_MS = 30_000;

function apiRequests(page: Page) {
  const paths: string[] = [];
  let last = Date.now();
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (!path.startsWith("/api/") || path === "/api/events") return;
    paths.push(path);
    last = Date.now();
  });
  return { paths, quiet: () => Date.now() - last >= 1000 };
}

async function expectIdle(page: Page, requests: ReturnType<typeof apiRequests>) {
  await expect.poll(requests.quiet).toBe(true);
  const start = requests.paths.length;
  await page.waitForTimeout(IDLE_MS);
  console.log(
    `${test.info().title}: ${requests.paths.length - start} API requests in ${IDLE_MS / 1000}s idle`,
  );
  expect(requests.paths.slice(start)).toEqual([]);
}

test.describe("views refresh from resource events, not timers", () => {
  test.setTimeout(120_000);

  test("a job run started outside the browser shows its status and output", async ({
    page,
    request,
  }) => {
    const job = await apiPost<{ id: string }>(request, "/jobs", {
      name: tid("no-poll-job"),
      command: "sleep 2; echo no-poll-output",
      trigger_type: "manual",
    });
    try {
      const paths = apiRequests(page);
      await gotoView(page, "jobs");
      await page
        .locator(`[data-testid="job-row"][data-job-id="${job.id}"]`)
        .getByTestId("job-open-detail")
        .click();
      await expect(page.getByTestId("job-detail-sheet")).toBeVisible();
      await expectIdle(page, paths);
      await apiPost(request, `/jobs/${job.id}/trigger`, {});
      const run = page.getByTestId("job-run-result");
      await expect(run).toContainText(/running/i);
      await run.click();
      await expect(page.getByText("no-poll-output", { exact: true })).toBeVisible();
      await expect(run).toContainText(/success/i);
      await expectIdle(page, paths);
    } finally {
      await apiDelete(request, `/jobs/${job.id}`);
    }
  });

  test("a webhook delivery from outside shows up in the open deliveries list", async ({
    page,
    request,
  }) => {
    const name = tid("no-poll-source");
    const hook = await apiPost<{ id: string; token: string; secret: string }>(
      request,
      "/webhooks",
      { name, provider: "generic" },
    );
    try {
      const paths = apiRequests(page);
      await gotoView(page, "jobs");
      await page.getByTestId("nav-webhooks").click();
      const row = page.getByTestId("webhook-endpoint").filter({ hasText: name });
      await row.getByTestId("webhook-deliveries-toggle").click();
      await expectIdle(page, paths);
      const body = JSON.stringify({ action: "opened" });
      const sent = await request.post(`${API_BASE.replace(/\/api$/, "")}/webhooks/${hook.token}`, {
        data: body,
        headers: {
          "content-type": "application/json",
          "X-Orc-Event": "no-poll",
          "X-Orc-Delivery": tid("delivery"),
          "X-Orc-Signature-256": `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`,
        },
      });
      expect(sent.status()).toBe(202);
      await expect(row.getByTestId("webhook-delivery")).toContainText("no-poll");
      await expectIdle(page, paths);
    } finally {
      await apiDelete(request, `/webhooks/${hook.id}`);
    }
  });

  test("a document added outside the browser appears parsed in the open knowledge base", async ({
    page,
    request,
  }) => {
    const name = tid("no-poll-kb");
    const kb = await apiPost<{ id: string }>(request, "/kb/bases", { name, project_id: null });
    try {
      const paths = apiRequests(page);
      await gotoView(page, "knowledge");
      await page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`).click();
      await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
      await expectIdle(page, paths);
      await apiPost(request, `/kb/bases/${kb.id}/documents`, {
        title: "No poll runbook",
        content: "# No poll runbook\n\nArrives through the event stream.",
      });
      const doc = page.locator(
        '[data-testid="kb-document-row"][data-document-title="No poll runbook"]',
      );
      await expect(doc).toBeVisible();
      await expect(page.getByText("Parsing…")).toHaveCount(0);
      await expectIdle(page, paths);
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });
});
