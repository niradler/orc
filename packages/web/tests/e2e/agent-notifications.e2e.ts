import { expect, test } from "@playwright/test";
import {
  approvalRequest,
  chatCompletion,
  liveSession,
  mockChatThread,
  mockResumedChat,
  NOTIFY_CHAT_THREAD,
  notificationScenario,
  poll,
  sourcesLoaded,
} from "./_agent-notifications";
import { notificationInbox } from "./_helpers";

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("Needs you: a permission prompt chimes and jumps the bell without stealing focus", async ({
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

  const bellIcon = page.getByTestId("notification-bell-icon").first();
  await expect(bellIcon).toHaveAttribute("data-pulse", "1", { timeout: 2_000 });
  await expect(page.getByTestId("notification-unread").first()).toHaveText("1");
  await expect(page.getByTestId("agent-notification-live")).toHaveText(
    "Run the database migration",
  );
  await expect(page.getByTestId("agent-notification-live")).toHaveAttribute("aria-live", "polite");
  expect(await scenario.chimeNotes()).toBe(2);
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="notification-menu"]'),
    ),
  ).toBe(false);

  await page.clock.fastForward(30_000);
  await expect(bellIcon).toHaveAttribute("data-pulse", "1");
  await page.screenshot({
    path: "../../output/playwright/notifications-bell-desktop-1440.png",
    animations: "disabled",
  });

  await page.keyboard.press("Alt+KeyN");
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/notifications-menu-desktop-1440.png",
    animations: "disabled",
  });
  const card = page.getByTestId("attention-request-notify-approval-0");
  await card.getByTestId("attention-review").click();
  await card.getByTestId("attention-approve").click();
  await poll(page);
  // Reviewing marked the notification read; the answered request stays in history.
  await expect(page.getByTestId("notification-unread")).toHaveCount(0);
  await page.getByTestId("notifications-show-read").click();
  await expect(page.getByTestId("notification-item")).toHaveCount(1);
  expect(scenario.responses).toEqual([
    {
      id: "notify-approval-0",
      body: { version: 1, response: { kind: "approval", approved: true } },
    },
  ]);
});

test("Needs you: no bell jump or chime for the session already in view", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running")],
    requests: [],
  });
  await mockResumedChat(page, "notify-live-0");
  const loaded = sourcesLoaded(page);
  await page.goto("/chat?sessionLive=notify-live-0");
  await loaded;
  await expect(page.getByText("Resumed.").first()).toBeVisible();
  await page.keyboard.press("Shift");

  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(2_500);

  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "0",
  );
  expect(await scenario.chimeNotes()).toBe(0);
});

test("Needs you: no bell jump for the session in view when it is older than the 50 newest", async ({
  page,
}) => {
  const newer = Array.from({ length: 50 }, (_, index) => ({
    ...liveSession(1, "running"),
    id: `notify-newer-${index}`,
    session_id: `notify-newer-native-${index}`,
  }));
  const scenario = await notificationScenario(page, { sessions: newer, requests: [] });
  await page.route("**/api/sessions/live/notify-live-0", (route) =>
    route.fulfill({ json: liveSession(0, "running", true) }),
  );
  await mockResumedChat(page, "notify-live-0");
  const loaded = sourcesLoaded(page);
  await page.goto("/chat?sessionLive=notify-live-0");
  await loaded;
  await expect(page.getByText("Resumed.").first()).toBeVisible();
  await page.keyboard.press("Shift");

  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(2_500);

  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "0",
  );
  expect(await scenario.chimeNotes()).toBe(0);
});

test("Done: a finished session jumps the bell silently", async ({ page }) => {
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
  await page.clock.runFor(1_500);

  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "1",
  );
  expect(await scenario.chimeNotes()).toBe(0);
  await expect(page.getByTestId("notification-bell").first()).toHaveAccessibleName(
    "Notifications: 1 unread",
  );
});

test("a continuing session dismisses its stale notification automatically", async ({ page }) => {
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(1, "running")],
    requests: [],
  });
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks");
  await loaded;

  scenario.state.sessions = [liveSession(1, "idle")];
  await poll(page);
  await expect(page.getByTestId("notification-bell").first()).toHaveAccessibleName(
    "Notifications: 1 unread",
  );

  // The agent starts a new turn; the finished alert is no longer relevant.
  scenario.state.sessions = [liveSession(1, "running")];
  await poll(page);
  await expect(page.getByTestId("notification-bell").first()).toHaveAccessibleName(
    "Notifications: 0 unread",
  );
  await page.getByTestId("notification-bell").first().click();
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
});

test("Done: sessions finishing together open from the bell on the chat page", async ({ page }) => {
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
  await page.route("**/api/sessions/live/notify-live-*", (route) =>
    route.fulfill({
      json: scenario.state.sessions.find((session) => route.request().url().endsWith(session.id)),
    }),
  );
  await mockResumedChat(page, "notify-live-1");
  await poll(page);
  await page.clock.runFor(1_500);

  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "1",
  );
  await page.getByTestId("notification-bell").first().click();
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  await page.getByTestId("notification-menu").getByTestId("notification-open").first().click();
  await expect(page).toHaveURL(/\/chat\?/);
  await expect(page.getByText("Resumed.").first()).toBeVisible();
});

test("Done: the open chat clears its completion without a bell jump", async ({ page }) => {
  const scenario = await notificationScenario(page, { sessions: [], requests: [] });
  await mockChatThread(page);
  const loaded = sourcesLoaded(page);
  await page.goto(`/chat?project=all&chatThread=${NOTIFY_CHAT_THREAD}`);
  await loaded;
  await expect(page.getByTestId("session-home")).toBeVisible();
  await page.keyboard.press("Shift");

  scenario.addNotification(chatCompletion());
  await poll(page);
  await page.clock.runFor(2_000);

  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "0",
  );
  expect(scenario.updates).toContainEqual({
    id: `notification-chat-${NOTIFY_CHAT_THREAD}`,
    body: { read: true, dismissed: true },
  });
  await expect(page.getByTestId("notification-bell").first()).toHaveAccessibleName(
    "Notifications: 0 unread",
  );
});

test("phone notifications stay closed during chat and open over the chat page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(0, "running"), liveSession(1, "running")],
    requests: [],
  });
  await mockResumedChat(page, "notify-live-1");
  const loaded = sourcesLoaded(page);
  await page.goto("/chat?project=all");
  await loaded;
  const chat = page.getByTestId("session-home");
  await expect(chat).toBeVisible();
  scenario.state.sessions = [liveSession(0, "running", true), liveSession(1, "idle")];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(1500);
  await expect(page.getByTestId("notification-menu")).toHaveCount(0);
  await expect(page.getByTestId("notification-bell")).toHaveAccessibleName(
    "Notifications: 2 unread",
  );
  await page.clock.fastForward(8000);
  await page.getByTestId("notification-bell").click();
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
  // The notification stays on the chat page and reveals the resumed conversation.
  await expect(page).toHaveURL(/\/chat\?.*project=all/);
  await expect(page.getByText("Resumed.").first()).toBeVisible();
  await expect(chat).toBeVisible();
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
  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "1",
  );
  const replacement = { ...approvalRequest(0), version: 2 };
  scenario.state.requests = [replacement];
  await poll(page);
  await page.getByTestId("notification-bell").first().click();
  await expect(page.getByTestId("notification-menu")).toBeVisible();
  const card = page.getByTestId("attention-request-notify-approval-0");
  await card.getByTestId("attention-review").click();
  await card.getByTestId("attention-approve").click();
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
  await page.goto("/chat?sessionLive=notify-live-0");
  await loaded;
  scenario.state.sessions = [liveSession(0, "running", true)];
  scenario.state.requests = [approvalRequest(0)];
  await poll(page);
  await page.clock.runFor(1500);
  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "1",
  );
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
  await expect(page.getByTestId("notification-bell-icon").first()).toHaveAttribute(
    "data-pulse",
    "1",
  );
  expect(await scenario.chimeNotes()).toBe(0);
});

test("opening a Done update from full screen phone chat reveals the finished session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scenario = await notificationScenario(page, {
    sessions: [liveSession(1, "running")],
    requests: [],
  });
  await mockResumedChat(page, "notify-live-1");
  const loaded = sourcesLoaded(page);
  await page.goto("/tasks?project=all&chat=full");
  await loaded;
  scenario.state.sessions = [liveSession(1, "idle")];
  await poll(page);
  await page.clock.runFor(1500);
  await page.getByTestId("notification-bell").click();
  await notificationInbox(page).getByTestId("notification-open").click();
  // The finished session opens as a conversation on the chat page.
  await expect(page).toHaveURL(/\/chat\?.*project=all/);
  await expect(page.getByText("Resumed.").first()).toBeVisible();
  await expect(page.getByTestId("session-home")).toBeVisible();
});
