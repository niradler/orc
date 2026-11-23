import { mkdirSync } from "node:fs";
import { ChatSettingsSchema } from "@orc/core/chat";
import type { HumanRequest } from "@orc/core/human-requests";
import type { NotificationPage } from "@orc/core/notifications";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  API_BASE,
  AUTH_HEADERS,
  apiGet,
  apiPost,
  gotoView,
  notificationInbox,
  tid,
} from "./_helpers";

async function dismissNotifications(request: APIRequestContext): Promise<void> {
  for (let batch = 0; batch < 10; batch++) {
    const page = await apiGet<NotificationPage>(request, "/notifications?limit=100");
    if (page.notifications.length === 0) return;
    for (const item of page.notifications) {
      await request.patch(`${API_BASE}/notifications/${item.id}`, {
        headers: AUTH_HEADERS,
        data: { dismissed: true },
      });
    }
  }
}

async function cancelPendingRequests(request: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    const res = await request.get(`${API_BASE}/human-requests/${id}/view`, {
      headers: AUTH_HEADERS,
    });
    if (!res.ok()) continue;
    const current = (await res.json()) as HumanRequest;
    if (["pending", "unavailable"].includes(current.status)) {
      await request.post(`${API_BASE}/human-requests/${id}/cancel`, {
        headers: AUTH_HEADERS,
        data: { version: current.version },
      });
    }
  }
}

const screenshotDir = process.env.ORC_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

test.beforeEach(async ({ request }) => {
  await dismissNotifications(request);
});

test("desktop snooze menu, bell unread drop, Snoozed group, Escape cancel, Wake now, and early answer @sanity", async ({
  page,
  request,
}) => {
  const createdIds: string[] = [];
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await request.patch(`${API_BASE}/settings`, { headers: AUTH_HEADERS, data: { theme: "dark" } });
    await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));

    const first = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "question",
      title: "Choose staging rollout window",
      prompt: "Should we deploy the billing worker at 14:00 or wait until tomorrow?",
      choices: ["Deploy at 14:00", "Wait until tomorrow"],
      origin: { backend: "codex", session_id: tid("snooze-desk"), request_id: "rollout-window" },
    });
    createdIds.push(first.id);

    const second = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "approval",
      title: "Run database migration check",
      prompt: "Approve read-only migration dry-run on staging?",
      origin: { backend: "claude", session_id: tid("snooze-desk-2"), request_id: "migration-dry" },
      action: {
        tool: "shell",
        cwd: "/workspace/demo-app",
        host: "local",
        input: { command: "bun run db:migrate --dry-run" },
      },
    });
    createdIds.push(second.id);

    await gotoView(page, "tasks");
    const bell = page.locator('[data-testid="notification-bell"]:visible').last();
    await expect(bell).toHaveAccessibleName("Notifications: 2 unread");
    await bell.click();

    const menu = notificationInbox(page);
    await expect(menu).toBeVisible();

    const firstCard = page.getByTestId(`attention-request-${first.id}`);
    await firstCard.getByTestId("attention-review").click();
    // Opening the card marks its notification read and settles it in the expanded detail slot.
    await expect(bell).toHaveAttribute("aria-label", "Notifications: 1 unread");
    await expect(firstCard.getByTestId("attention-snooze")).toBeVisible();

    // Open snooze menu via keyboard from the card action row and press Escape without mutating state.
    const cardSnooze = firstCard.getByTestId("attention-snooze");
    await cardSnooze.focus();
    await expect(cardSnooze).toBeFocused();
    await page.keyboard.press("Enter");
    const snoozeMenu = page.getByTestId("snooze-menu");
    await expect(snoozeMenu).toBeVisible();
    await expect(snoozeMenu).toHaveAttribute("data-presentation", "popover");
    await expect(snoozeMenu.getByTestId("snooze-option-15m")).toBeVisible();
    await expect(snoozeMenu.getByTestId("snooze-option-1h")).toBeVisible();
    await expect(snoozeMenu.getByTestId("snooze-option-3h")).toBeVisible();
    await expect(snoozeMenu.getByTestId("snooze-option-tomorrow")).toBeVisible();
    await expect(snoozeMenu.getByTestId("snooze-option-custom")).toBeVisible();

    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/snooze-menu-desktop-dark.png`,
        animations: "disabled",
      });
    }

    await page.keyboard.press("Escape");
    await expect(snoozeMenu).toHaveCount(0);
    await expect(page.getByTestId("notifications-snoozed-section")).toHaveCount(0);

    // Snooze first request for 1 hour from the card: moves it to Snoozed group while second stays in Needs you.
    await cardSnooze.click();
    await page.getByTestId("snooze-option-1h").click();

    await expect(bell).toHaveAttribute("aria-label", "Notifications: 1 unread");
    const snoozedSection = page.getByTestId("notifications-snoozed-section");
    await expect(snoozedSection).toBeVisible();
    await expect(snoozedSection.getByTestId("notifications-snoozed-count")).toHaveText("1");
    await expect(snoozedSection.locator(`[data-source-id="${first.id}"]`)).toBeVisible();
    await expect(snoozedSection.getByTestId("attention-snoozed-until")).toContainText(
      "Snoozed until",
    );

    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/snoozed-group-desktop-dark.png`,
        animations: "disabled",
      });
    }

    // Light theme screenshot of Snoozed group for visual verification.
    if (screenshotDir) {
      await page.evaluate(() => {
        localStorage.setItem("orc_theme", "light");
        window.dispatchEvent(new StorageEvent("storage", { key: "orc_theme", newValue: "light" }));
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.screenshot({
        path: `${screenshotDir}/snoozed-group-desktop-light.png`,
        animations: "disabled",
      });
      await page.evaluate(() => {
        localStorage.setItem("orc_theme", "dark");
        window.dispatchEvent(new StorageEvent("storage", { key: "orc_theme", newValue: "dark" }));
      });
    }

    // Needs you filter excludes snoozed items.
    await menu.getByTestId("notifications-needs-you").click();
    await expect(page.getByTestId("notifications-snoozed-section")).toHaveCount(0);
    await expect(menu.locator(`[data-source-id="${second.id}"]`)).toBeVisible();
    await menu.getByTestId("notifications-needs-you").click();
    await expect(snoozedSection).toBeVisible();

    // Snooze unread second request directly from the row icon: bell count drops from 1 to 0.
    await menu
      .locator(`[data-source-id="${second.id}"]`)
      .getByTestId("notification-snooze")
      .click();
    await page.getByTestId("snooze-option-3h").click();
    await expect(bell).toHaveAttribute("aria-label", "Notifications: 0 unread");
    await expect(snoozedSection.getByTestId("notifications-snoozed-count")).toHaveText("2");

    // Wake now returns first to Needs you and restores unread count to 1.
    await snoozedSection
      .locator(`[data-source-id="${first.id}"]`)
      .getByTestId("notification-wake-now")
      .click();
    await expect(snoozedSection.getByTestId("notifications-snoozed-count")).toHaveText("1");
    await expect(bell).toHaveAttribute("aria-label", "Notifications: 1 unread");

    // Answer the snoozed second request early directly from the Snoozed group: clears snooze.
    const snoozedSecond = snoozedSection.locator(`[data-source-id="${second.id}"]`);
    await snoozedSecond.getByTestId("attention-review").click();
    await snoozedSecond.getByTestId("attention-approve").click();
    await expect(page.getByTestId("notifications-snoozed-section")).toHaveCount(0);
  } finally {
    await cancelPendingRequests(request, createdIds);
    await dismissNotifications(request);
  }
});

test("phone snooze bottom sheet, 44px touch targets, zero overflow, and session waiting banner", async ({
  page,
  request,
}) => {
  const createdIds: string[] = [];
  const threadId = crypto.randomUUID();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await request.patch(`${API_BASE}/settings`, { headers: AUTH_HEADERS, data: { theme: "dark" } });
    await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));

    const reqItem = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "question",
      title: "Confirm release notes target",
      prompt: "Should we publish release notes to the staging channel first?",
      choices: ["Staging first", "Skip notes"],
      origin: {
        backend: "codex",
        session_id: tid("snooze-phone"),
        request_id: "release-notes",
        chat_thread_id: threadId,
        session_title: "Release prep session",
      },
    });
    createdIds.push(reqItem.id);

    await gotoView(page, "notifications");
    const inbox = notificationInbox(page);
    await expect(inbox).toBeVisible();

    const row = inbox.locator(`[data-source-id="${reqItem.id}"]`);
    await row.getByTestId("notification-actions").click();
    await page.getByTestId("notification-snooze").click();

    const sheet = page.getByTestId("snooze-menu");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-presentation", "sheet");

    // Touch targets on phone sheet are at least 44px tall and no horizontal overflow occurs.
    const box = await sheet.getByTestId("snooze-option-1h").boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/snooze-sheet-phone-dark.png`,
        animations: "disabled",
      });
    }

    await sheet.getByTestId("snooze-option-1h").click();
    const snoozedSection = page.getByTestId("notifications-snoozed-section");
    await expect(snoozedSection).toBeVisible();
    await expect(snoozedSection.getByTestId("attention-snoozed-until")).toContainText(
      "Snoozed until",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/snoozed-group-phone-dark.png`,
        animations: "disabled",
      });
    }

    const threadMessages = [
      {
        id: "m1",
        role: "user" as const,
        content: "Prepare the staging release notes",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "m2",
        role: "assistant" as const,
        content: "I drafted the staging release notes and asked where to publish them.",
        timestamp: Date.now() - 30_000,
      },
    ];
    const mockedThread = {
      id: threadId,
      title: "Release prep session",
      backend: "codex",
      host: null,
      cwd: "/workspace/demo-app",
      runtimeId: null,
      sourceId: null,
      projectId: null,
      config: ChatSettingsSchema.parse({ agent: "codex" }),
      messages: threadMessages,
      updatedAt: Date.now(),
    };
    await page.route(`**/api/chat/threads/${threadId}`, (route) =>
      route.fulfill({ json: mockedThread }),
    );
    await page.route(`**/api/chat/threads/${threadId}/refresh`, (route) =>
      route.fulfill({ json: mockedThread }),
    );
    await page.route(`**/api/chat/threads/${threadId}/live`, (route) =>
      route.fulfill({ status: 204, body: "" }),
    );
    await page.route(`**/api/chat/threads/${threadId}/history*`, (route) =>
      route.fulfill({
        json: {
          messages: threadMessages,
          total: threadMessages.length,
          hasMore: false,
        },
      }),
    );
    await page.route(`**/api/chat/threads/${threadId}/session`, (route) =>
      route.fulfill({
        json: {
          changed: false,
          running: false,
          workingChildren: 0,
          waitingChildren: 0,
          stopping: false,
          live: null,
          queued: [],
        },
      }),
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/chat?chatThread=${threadId}&project=all`);
    const banner = page.getByTestId("session-snoozed-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Waiting for you · snoozed until");
    // Session must remain in waiting ("needs-you") state, never idle or ended.
    await expect(page.locator('[data-state="needs-you"]').first()).toBeVisible();

    if (screenshotDir) {
      await page.screenshot({
        path: `${screenshotDir}/session-waiting-snoozed-desktop-dark.png`,
        animations: "disabled",
      });
    }

    // Wake now from the session waiting banner clears the snooze immediately.
    await banner.getByTestId("session-wake-now").click();
    await expect(banner).toHaveCount(0);
  } finally {
    await cancelPendingRequests(request, createdIds);
    await dismissNotifications(request);
  }
});

test("custom snooze inside expanded question and command cards never submits respond or run, and 700px uses bottom sheet", async ({
  page,
  request,
}) => {
  const createdIds: string[] = [];
  const unexpectedCalls: string[] = [];
  try {
    await page.route("**/api/human-requests/*/respond", async (route) => {
      unexpectedCalls.push(route.request().url());
      await route.continue();
    });
    await page.route("**/api/human-requests/*/run", async (route) => {
      unexpectedCalls.push(route.request().url());
      await route.continue();
    });

    const questionReq = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "question",
      title: "Custom snooze question isolation",
      prompt: "Should we rotate keys?",
      origin: { backend: "codex", session_id: tid("custom-q"), request_id: "custom-q" },
    });
    createdIds.push(questionReq.id);

    const commandReq = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "command",
      title: "Custom snooze command isolation",
      prompt: "Run diagnostics script",
      origin: { backend: "codex", session_id: tid("custom-cmd"), request_id: "custom-cmd" },
      command: { host: null, cwd: "/tmp", script: "echo should-not-run" },
    });
    createdIds.push(commandReq.id);

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoView(page, "tasks");
    const bell = page.locator('[data-testid="notification-bell"]:visible').last();
    await bell.click();

    // Expand question card, fill an answer (so submit is enabled!), then submit Custom snooze.
    const qCard = page.getByTestId(`attention-request-${questionReq.id}`);
    await qCard.getByTestId("attention-review").click();
    await expect(qCard.getByTestId("attention-answer")).toBeVisible();
    await qCard.getByTestId("attention-answer").fill("Draft answer that must not send");
    await qCard.getByTestId("attention-snooze").click();
    await page.getByTestId("snooze-option-custom").click();
    await expect(page.getByTestId("snooze-custom-input")).toBeVisible();
    await page.getByTestId("snooze-custom-submit").click();

    const snoozedSection = page.getByTestId("notifications-snoozed-section");
    await expect(snoozedSection.locator(`[data-source-id="${questionReq.id}"]`)).toBeVisible();

    // Expand command card and submit Custom snooze via Enter key on the datetime input.
    const cmdCard = page.getByTestId(`attention-request-${commandReq.id}`);
    await cmdCard.getByTestId("attention-review").click();
    await expect(cmdCard.getByTestId("attention-snooze")).toBeVisible();
    await cmdCard.getByTestId("attention-snooze").click();
    await page.getByTestId("snooze-option-custom").click();
    const customInput = page.getByTestId("snooze-custom-input");
    await customInput.focus();
    await page.keyboard.press("Enter");

    await expect(snoozedSection.locator(`[data-source-id="${commandReq.id}"]`)).toBeVisible();
    // Neither /respond nor /run may have been invoked, and both requests remain pending + snoozed.
    expect(unexpectedCalls).toEqual([]);
    for (const id of [questionReq.id, commandReq.id]) {
      const current = await apiGet<HumanRequest>(request, `/human-requests/${id}/view`);
      expect(current.status).toBe("pending");
      expect(current.snooze_until).toBeGreaterThan(Date.now());
    }

    // At 700px (phone breakpoint < 768px), row Snooze opens a bottom sheet anchored at the bottom, not detached at (0,0).
    await snoozedSection
      .locator(`[data-source-id="${questionReq.id}"]`)
      .getByTestId("notification-wake-now")
      .click();
    await page.setViewportSize({ width: 700, height: 844 });
    await gotoView(page, "notifications");
    const row = notificationInbox(page).locator(`[data-source-id="${questionReq.id}"]`);
    await row.getByTestId("notification-actions").click();
    await page.getByTestId("notification-snooze").click();
    const sheet = page.getByTestId("snooze-menu");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-presentation", "sheet");
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(800);
    expect(box?.y ?? 0).toBeGreaterThan(200);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  } finally {
    await cancelPendingRequests(request, createdIds);
    await dismissNotifications(request);
  }
});
