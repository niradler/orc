import { expect, test } from "@playwright/test";
import {
  approvalRequest,
  liveSession,
  notificationScenario,
  poll,
  sourcesLoaded,
} from "./_agent-notifications";
import { notificationInbox } from "./_helpers";

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("Needs you: a permission prompt chimes without stealing focus and opens its review form", async ({
  page,
}) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;
  await page.keyboard.press("Shift");

  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);

  const toast = page.getByTestId("agent-toast");
  await expect(toast).toHaveCount(1, { timeout: 2_000 });
  await expect(toast).toHaveAttribute("data-level", "needs-you");
  await expect(toast).toContainText("Migrate billing tables");
  await expect(toast).toContainText("Run the database migration");
  await expect(page.getByTestId("agent-notification-live")).toHaveText(
    "Run the database migration",
  );
  await expect(page.getByTestId("agent-notification-live")).toHaveAttribute("aria-live", "polite");
  expect(await scenario.chimeNotes()).toBe(2);
  expect(
    await page.evaluate(() => !!document.activeElement?.closest('[data-testid="agent-toasts"]')),
  ).toBe(false);

  await page.clock.fastForward(30_000);
  await expect(toast).toHaveCount(1);

  await page.keyboard.press("Alt+KeyN");
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  const card = page.getByTestId("attention-request-notify-approval-0");
  await card.getByTestId("attention-review").click();
  await card.getByTestId("attention-approve").click();
  await poll(page);
  await expect(toast).toHaveCount(0);
  expect(scenario.responses).toEqual([
    {
      id: "notify-approval-0",
      body: { version: 1, response: { kind: "approval", approved: true } },
    },
  ]);
});

test("Needs you: no toast or chime for the session already in view", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/sessions?session=notify-live-0");
  await loaded;
  await page.keyboard.press("Shift");

  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(2_500);

  await expect(page.getByTestId("agent-toast")).toHaveCount(0);
  expect(await scenario.chimeNotes()).toBe(0);
});

test("Done: a finished session gives one silent toast that pauses on hover and closes itself", async ({
  page,
}) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(1, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;
  await page.keyboard.press("Shift");

  scenario.state.sessions = [liveSession(1, "idle")];
  await poll(page);

  const toast = page.getByTestId("agent-toast");
  await expect(toast).toHaveCount(1, { timeout: 2_000 });
  await expect(toast).toHaveAttribute("data-level", "done");
  await expect(toast).toContainText("Fix flaky login test");
  await expect(toast.getByTestId("agent-toast-approve")).toHaveCount(0);
  await expect(page.getByTestId("agent-notification-live")).toHaveText("Fix flaky login test");
  expect(await scenario.chimeNotes()).toBe(0);

  await toast.hover();
  await page.clock.fastForward(8_000);
  await expect(toast).toHaveCount(1);
  await page.mouse.move(5, 5);
  await page.clock.fastForward(6_500);
  await expect(toast).toHaveCount(0);

  await poll(page);
  await page.clock.runFor(1_500);
  await expect(toast).toHaveCount(0);
});

test("Done: sessions finishing together collapse into one toast", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(1, "running"), liveSession(2, "running"), liveSession(3, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;

  scenario.state.sessions = [
    liveSession(1, "idle"),
    liveSession(2, "idle"),
    liveSession(3, "idle"),
  ];
  await poll(page);

  const toast = page.getByTestId("agent-toast");
  await expect(toast).toHaveCount(1, { timeout: 2_000 });
  await expect(toast).toContainText("3 updates finished");
  await expect(page.getByTestId("agent-notification-live")).toHaveText("3 new notifications");
  expect(await scenario.chimeNotes()).toBe(0);

  await toast.getByTestId("agent-toast-open").click();
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  await page.getByTestId("notification-menu").getByTestId("notification-open").first().click();
  await expect(page).toHaveURL(/\/sessions\?.*session=notify-live-1/);
});

test("phone bell keeps updates closed, retains Done updates, and works inside chat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running"), liveSession(1, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks?project=all&chat=open");
  await loaded;
  const chat = page.getByTestId("mobile-chat-sheet");
  await expect(chat).toBeVisible();
  scenario.state.sessions = [liveSession(0, "running", true), liveSession(1, "idle")];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(1500);
  await expect(page.getByTestId("notification-menu")).toHaveCount(0);
  await expect(page.getByTestId("agent-toasts")).not.toBeVisible();
  await expect(chat.getByTestId("notification-bell")).toHaveAccessibleName(
    "Notifications: 2 unread",
  );
  await page.clock.fastForward(8000);
  await chat.getByTestId("notification-bell").click();
  const menu = notificationInbox(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("notification-item")).toHaveCount(2);
  await page.screenshot({
    path: "../../output/playwright/notifications-phone-dark.png",
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  });
  await page.clock.runFor(300);
  await page.screenshot({
    path: "../../output/playwright/notifications-phone-light.png",
    animations: "disabled",
  });
  await menu.getByTestId("notification-open").filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/sessions\?session=notify-live-1&project=all$/);
  await expect(chat).toHaveCount(0);
});

test("review uses the current approval version after source changes", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;
  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await expect(page.getByTestId("agent-toast")).toHaveCount(1);
  const replacement = { ...approvalRequest(0), version: 2 };
  scenario.state.requests = [replacement];
  await poll(page);
  await page.getByTestId("agent-toast-open").click();
  await page
    .getByTestId("attention-request-notify-approval-0")
    .getByTestId("attention-approve")
    .click();
  expect(scenario.responses[0]).toEqual({
    id: "notify-approval-0",
    body: { version: 2, response: { kind: "approval", approved: true } },
  });
});

test("phone bell preserves access to requests that already exist at startup", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await notificationScenario(page, {
    sessions: [liveSession(0, "running", true)],
    requests: [approvalRequest(0)],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;
  const bell = page.getByTestId("notification-bell").first();
  await expect(bell).toHaveAccessibleName("Notifications: 1 unread");
  await expect(page.getByTestId("notification-menu")).toHaveCount(0);
  await page.keyboard.press("Alt+KeyN");
  await expect(notificationInbox(page)).toBeVisible();
  await expect(page.getByTestId("attention-request-notify-approval-0")).toBeVisible();
});

test("an unfocused desktop still receives updates for its selected session", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  await page.addInitScript(() => {
    Object.defineProperty(document, "hasFocus", { value: () => false });
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/sessions?session=notify-live-0");
  await loaded;
  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(1500);
  await expect(page.getByTestId("agent-toast")).toHaveCount(1);
});

test("sound preferences persist after reload and disabling sound keeps alerts silent", async ({
  page,
}) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/settings?settingsSection=notifications");
  await loaded;
  await page.getByTestId("notification-sound-volume").fill("35");
  await page.getByTestId("notification-sound-enabled").uncheck();
  await page.reload();
  await expect(page.getByTestId("notification-sound-enabled")).not.toBeChecked();
  await expect(page.getByTestId("notification-sound-volume")).toHaveValue("35");
  await page.keyboard.press("Shift");
  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await expect(page.getByTestId("agent-toast")).toHaveCount(1);
  expect(await scenario.chimeNotes()).toBe(0);
});

test("opening a Done update from phone chat reveals the finished session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(1, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks?project=all&chat=open");
  await loaded;
  scenario.state.sessions = [liveSession(1, "idle")];
  await poll(page);
  await page.clock.runFor(1500);
  await page.getByTestId("mobile-chat-sheet").getByTestId("notification-bell").click();
  await notificationInbox(page).getByTestId("notification-open").click();
  await expect(page).toHaveURL(/\/sessions\?session=notify-live-1&project=all$/);
  await expect(page.getByTestId("mobile-chat-sheet")).toHaveCount(0);
});
