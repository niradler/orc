import type { HumanRequest } from "@orc/core/human-requests";
import type { NotificationPage } from "@orc/core/notifications";
import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

test.beforeEach(async ({ request }) => {
  const page = await apiGet<NotificationPage>(request, "/notifications?limit=100");
  for (const item of page.notifications) {
    const response = await request.patch(`${API_BASE}/notifications/${item.id}`, {
      headers: AUTH_HEADERS,
      data: { dismissed: true },
    });
    expect(response.ok()).toBe(true);
  }
});

for (const theme of ["dark", "light"] as const)
  for (const width of [1440, 390]) {
    test(`generic notification menu handles requests and jobs ${theme} ${width}`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await request.patch(`${API_BASE}/settings`, { headers: AUTH_HEADERS, data: { theme } });
      await page.addInitScript((theme) => localStorage.setItem("orc_theme", theme), theme);
      const question = await apiPost<HumanRequest>(request, "/human-requests", {
        kind: "question",
        title: "Choose the deployment window",
        prompt: "Which deployment window should we use?",
        origin: { backend: "test", session_id: tid("question"), request_id: "window" },
      });
      const approval = await apiPost<HumanRequest>(request, "/human-requests", {
        kind: "approval",
        title: "Review the migration",
        prompt: "Allow this migration?",
        origin: { backend: "test", session_id: tid("approval"), request_id: "migration" },
        action: {
          tool: "command",
          cwd: repoRoot(),
          host: "local",
          input: { command: "echo migration" },
        },
      });
      const job = await apiPost<{ id: string; name: string }>(request, "/jobs", {
        name: tid("notification-job"),
        command: "echo Notification demo",
        trigger_type: "manual",
        notify_on: "always",
        enabled: false,
      });
      await apiPost(request, `/jobs/${job.id}/trigger`, {});
      await expect
        .poll(async () =>
          (await apiGet<NotificationPage>(request, "/notifications")).notifications.some(
            (item) => item.type === "job.finished" && item.title.includes(job.name),
          ),
        )
        .toBe(true);
      await gotoView(page, "tasks");
      await expect(page.getByTestId("nav-attention")).toHaveCount(0);
      await expect(page.getByTestId("notification-menu")).toHaveCount(0);
      if (width === 390) {
        await page.getByTestId("chat-open-button").click();
        await expect(page.getByTestId("mobile-chat-sheet")).toBeVisible();
      }
      const bell = page.locator('[data-testid="notification-bell"]:visible').last();
      await expect(bell).toHaveAccessibleName("Notifications: 3 unread");
      await bell.click();
      const menu = page.getByTestId("notification-menu");
      await expect(menu).toBeVisible();
      const questionCard = page.getByTestId(`attention-request-${question.id}`);
      await questionCard.getByTestId("attention-review").click();
      await questionCard.getByTestId("attention-answer").fill("Tomorrow at 09:00");
      await menu.getByRole("button", { name: "Close notifications", exact: true }).click();
      await expect(bell).toBeFocused();
      await bell.click();
      await expect(questionCard.getByTestId("attention-answer")).toHaveValue("Tomorrow at 09:00");
      await questionCard.getByTestId("attention-send").click();
      await expect(questionCard.getByTestId("attention-response")).toHaveText("Tomorrow at 09:00");
      const approvalCard = page.getByTestId(`attention-request-${approval.id}`);
      await approvalCard.getByTestId("attention-review").click();
      await expect(approvalCard.getByTestId("attention-action")).toContainText("echo migration");
      await page.screenshot({
        path: testInfo.outputPath(`notification-center-${theme}-${width}.png`),
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await approvalCard.getByTestId("attention-deny").click();
      await expect(approvalCard.getByTestId("attention-response")).toHaveText("Denied");
      const jobItem = menu.getByTestId("notification-item").filter({ hasText: job.name });
      await jobItem.getByTestId("notification-open").click();
      await expect(page).toHaveURL(new RegExp(`/jobs/${job.id}\\?run=.*project=all`));
      await expect(page.getByTestId("job-detail-sheet")).toBeVisible();
      await expect(page.getByTestId("mobile-chat-sheet")).toHaveCount(0);
      const history = await apiGet<NotificationPage>(request, "/notifications");
      expect(
        history.notifications.find((item) => item.source_id === question.id)?.requires_action,
      ).toBe(false);
      expect(
        history.notifications.find((item) => item.source_id === approval.id)?.requires_action,
      ).toBe(false);
    });
  }

test("a dismissed notification's old link still opens its source request", async ({
  page,
  request,
}) => {
  const source = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    title: "Linked request after alert dismissal",
    prompt: "Still answerable?",
    origin: { backend: "test", session_id: tid("linked"), request_id: "linked" },
  });
  const item = (await apiGet<NotificationPage>(request, "/notifications")).notifications.find(
    (item) => item.source_id === source.id,
  );
  expect(item).toBeDefined();
  const response = await request.patch(`${API_BASE}/notifications/${item?.id}`, {
    headers: AUTH_HEADERS,
    data: { dismissed: true },
  });
  expect(response.ok()).toBe(true);
  await gotoView(page, "tasks");
  await page.goto(`/attention?request=${source.id}`);
  const card = page.getByTestId(`attention-request-${source.id}`);
  await expect(card.getByTestId("attention-answer")).toBeVisible();
  await card.getByTestId("attention-answer").fill("Yes");
  await card.getByTestId("attention-send").click();
  await expect(card.getByTestId("attention-response")).toHaveText("Yes");
});

test("read state is shared across pages and survives reload", async ({ page, request }) => {
  const source = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    title: "Shared notification",
    prompt: "A question",
    origin: { backend: "test", session_id: tid("shared"), request_id: "shared" },
  });
  await gotoView(page, "tasks");
  const second = await page.context().newPage();
  try {
    await gotoView(second, "tasks");
    await expect(
      second.locator('[data-testid="notification-bell"]:visible').first(),
    ).toHaveAccessibleName("Notifications: 1 unread");
    await page.locator('[data-testid="notification-bell"]:visible').first().click();
    await page
      .locator(`[data-source-id="${source.id}"]`)
      .getByTestId("notification-mark-read")
      .click();
    await expect(
      second.locator('[data-testid="notification-bell"]:visible').first(),
    ).toHaveAccessibleName("Notifications: 0 unread");
    await second.reload();
    await expect(
      second.locator('[data-testid="notification-bell"]:visible').first(),
    ).toHaveAccessibleName("Notifications: 0 unread");
  } finally {
    await second.close();
  }
});

test("notification and audit retention save in Settings with defaults and an audit event", async ({
  page,
  request,
}) => {
  await request.patch(`${API_BASE}/settings`, {
    headers: AUTH_HEADERS,
    data: { notification_retention_days: 30, audit_retention_days: 90 },
  });
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=storage");
  await expect(page.getByTestId("notification-retention-days")).toHaveValue("30");
  await expect(page.getByTestId("audit-retention-days")).toHaveValue("90");
  await page.getByTestId("notification-retention-days").fill("2");
  await page.getByTestId("audit-retention-days").fill("7");
  await page.getByTestId("retention-save").click();
  await expect(page.getByRole("status")).toContainText("Retention saved.");
  await page.reload();
  await expect(page.getByTestId("notification-retention-days")).toHaveValue("2");
  await expect(page.getByTestId("audit-retention-days")).toHaveValue("7");
  const audit = await apiGet<{ entries: { action: string }[] }>(
    request,
    "/audit?scope=all&entity_type=settings&snapshot=preview",
  );
  expect(audit.entries.some((entry) => entry.action === "settings.retention_changed")).toBe(true);
  await request.patch(`${API_BASE}/settings`, {
    headers: AUTH_HEADERS,
    data: { notification_retention_days: 30, audit_retention_days: 90 },
  });
});
