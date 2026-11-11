import type { HumanRequest } from "@orc/core/human-requests";
import type { NotificationPage } from "@orc/core/notifications";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, repoRoot, tid } from "./_helpers";

async function dismissNotifications(request: APIRequestContext): Promise<void> {
  const dismissed = new Set<string>();
  for (let batch = 0; batch <= 20; batch++) {
    const page = await apiGet<NotificationPage>(request, "/notifications?limit=100");
    if (page.notifications.length === 0) return;
    if (page.notifications.some((item) => dismissed.has(item.id)))
      throw new Error("Notification cleanup made no progress after dismissing a page");
    if (batch === 20) break;
    for (const item of page.notifications) {
      const response = await request.patch(`${API_BASE}/notifications/${item.id}`, {
        headers: AUTH_HEADERS,
        data: { dismissed: true },
      });
      expect(response.ok()).toBe(true);
      dismissed.add(item.id);
    }
  }
  throw new Error("Notification cleanup did not empty after 20 pages of 100 entries");
}

test.beforeEach(async ({ request }) => {
  await dismissNotifications(request);
});

test("should clean notifications across more than one page", async ({ request }) => {
  const created: HumanRequest[] = [];
  try {
    for (let index = 0; index < 101; index++)
      created.push(
        await apiPost<HumanRequest>(request, "/human-requests", {
          kind: "question",
          title: `Cleanup fixture ${index}`,
          prompt: "Fixture notification for pagination coverage",
          origin: { backend: "test", session_id: tid("cleanup"), request_id: String(index) },
        }),
      );
    const populated = await apiGet<NotificationPage>(request, "/notifications?limit=100");
    expect(populated.notifications).toHaveLength(100);
    expect(populated.has_more).toBe(true);
    expect(populated.unread).toBe(101);
    await dismissNotifications(request);
    const empty = await apiGet<NotificationPage>(request, "/notifications?limit=100");
    expect(empty.notifications).toHaveLength(0);
    expect(empty.unread).toBe(0);
    expect(empty.has_more).toBe(false);
  } finally {
    for (const item of created)
      await apiPost(request, `/human-requests/${item.id}/cancel`, { version: item.version });
    await dismissNotifications(request);
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
      await expect(page.getByTestId("session-home")).toHaveCount(0);
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
  await page.goto(`/activity?notifications=open&request=${source.id}`);
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

test("clicking a desktop OS notification marks it read and still navigates", async ({
  page,
  request,
}) => {
  const source = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    title: "Desktop click clears",
    prompt: "Which window?",
    origin: { backend: "test", session_id: tid("desktop-click"), request_id: "desktop-click" },
  });
  try {
    const item = (await apiGet<NotificationPage>(request, "/notifications")).notifications.find(
      (notification) => notification.source_id === source.id,
    );
    expect(item).toBeDefined();
    // Fake the Electron bridge: capture onOpen listeners so the test can emit a
    // notification click exactly like the desktop main process does.
    await page.addInitScript(() => {
      const listeners: Array<(path: string, id?: string) => void> = [];
      Object.defineProperty(window, "orcDesktop", {
        value: {
          notify: () => {},
          onOpen: (listener: (path: string, id?: string) => void) => {
            listeners.push(listener);
            return () => {};
          },
          emitOpen: (path: string, id?: string) => {
            for (const listener of [...listeners]) listener(path, id);
          },
        },
      });
    });
    await gotoView(page, "tasks");
    const bell = page.locator('[data-testid="notification-bell"]:visible').last();
    await expect(bell).toHaveAccessibleName("Notifications: 1 unread");
    await page.evaluate(
      ({ path, id }) =>
        (
          window as unknown as { orcDesktop: { emitOpen(p: string, i?: string): void } }
        ).orcDesktop.emitOpen(path, id),
      { path: item?.path, id: item?.id },
    );
    // Intended navigation still happens.
    await expect(page).toHaveURL(
      new RegExp(`/activity\\?notifications=open&request=${source.id}.*project=all`),
    );
    // The clicked notification no longer counts as outstanding, in the UI...
    // The open dialog aria-hides the backdrop, so check the label attribute.
    await expect(page.locator('[data-testid="notification-bell"]:visible').last()).toHaveAttribute(
      "aria-label",
      "Notifications: 0 unread",
    );
    // ...and in the shared server state.
    await expect
      .poll(async () => {
        const history = await apiGet<NotificationPage>(request, "/notifications");
        return (
          history.notifications.find((notification) => notification.id === item?.id)?.read_at ??
          null
        );
      })
      .not.toBeNull();
  } finally {
    await apiPost(request, `/human-requests/${source.id}/cancel`, { version: source.version });
  }
});

test("reading a request preserves the active draft and focus as its inbox row disappears", async ({
  page,
  request,
}) => {
  const source = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    title: "Keep this answer",
    prompt: "Which window?",
    origin: { backend: "test", session_id: tid("draft"), request_id: "draft" },
  });
  let releaseRead = () => {};
  const resumeRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route("**/api/notifications/*", async (route) => {
    if (route.request().method() === "PATCH") await resumeRead;
    await route.continue();
  });
  try {
    await gotoView(page, "notifications");
    const row = page.locator(`[data-source-id="${source.id}"]`);
    await row.getByTestId("attention-review").click();
    const answer = page
      .getByTestId(`attention-request-${source.id}`)
      .getByTestId("attention-answer");
    await answer.fill("Tomorrow at 09:00");
    releaseRead();
    await expect(row).toHaveCount(0);
    await expect(answer).toHaveValue("Tomorrow at 09:00");
    await expect(answer).toBeFocused();
  } finally {
    releaseRead();
  }
});

for (const theme of ["dark", "light"] as const)
  for (const width of [1440, 390])
    test(`unread inbox and read history ${theme} ${width}`, async ({ page, request }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await request.patch(`${API_BASE}/settings`, { headers: AUTH_HEADERS, data: { theme } });
      await page.addInitScript((theme) => localStorage.setItem("orc_theme", theme), theme);
      const sources: HumanRequest[] = [];
      for (const title of ["Review deployment", "Choose a window"])
        sources.push(
          await apiPost<HumanRequest>(request, "/human-requests", {
            kind: "question",
            title,
            prompt: title,
            origin: { backend: "test", session_id: tid("inbox"), request_id: title },
          }),
        );
      await gotoView(page, "notifications");
      const menu = page.getByTestId("notification-menu");
      const toggle = menu.getByTestId("notifications-show-read");
      const rows = menu.getByTestId("notification-item");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect(rows).toHaveCount(2);
      const first = menu.locator(`[data-source-id="${sources[0]?.id}"]`);
      await first.getByTestId("notification-mark-read").click();
      await expect(first).toHaveCount(0);
      await toggle.click();
      await expect(rows).toHaveCount(2);
      await expect(first.getByTestId("notification-mark-read")).toHaveAccessibleName("Mark unread");
      await first.getByTestId("notification-mark-read").click();
      await toggle.click();
      await expect(rows).toHaveCount(2);
      await first.getByTestId("attention-review").click();
      await expect(first).toHaveCount(0);
      await expect(
        page.getByTestId(`attention-request-${sources[0]?.id}`).getByTestId("attention-answer"),
      ).toBeVisible();
      await menu.getByTestId("notifications-mark-all-read").click();
      await expect(rows).toHaveCount(0);
      await expect(menu.getByTestId("notifications-empty")).toHaveText("No unread notifications.");
      await toggle.click();
      await expect(rows).toHaveCount(2);
      await expect(rows.getByRole("button", { name: "Mark unread", exact: true })).toHaveCount(2);
      await page.screenshot({
        path: testInfo.outputPath(`inbox-${theme}-${width}.png`),
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.reload();
      await expect(page.getByTestId("notifications-show-read")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(page.getByTestId("notifications-empty")).toBeVisible();
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
