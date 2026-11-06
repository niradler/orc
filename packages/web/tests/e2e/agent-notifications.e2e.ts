import { expect, test } from "@playwright/test";
import {
  approvalRequest,
  liveSession,
  notificationScenario,
  poll,
  sourcesLoaded,
} from "./_agent-notifications";

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("Needs you: a permission prompt raises a toast with Approve and Deny, chimes and announces, and Approve answers it", async ({
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
  await expect(toast.getByTestId("agent-toast-state")).toHaveAttribute("data-state", "needs-you");
  await expect(toast).toContainText("codex");
  await expect(toast.getByTestId("agent-toast-title")).toHaveText("Migrate billing tables");
  await expect(toast).toContainText("Run the database migration");
  await expect(toast.getByTestId("agent-toast-approve")).toBeVisible();
  await expect(toast.getByTestId("agent-toast-deny")).toBeVisible();
  await expect(page.getByTestId("agent-notification-live")).toHaveText(
    "Needs you: codex · Migrate billing tables",
  );
  await expect(page.getByTestId("agent-notification-live")).toHaveAttribute("aria-live", "polite");
  expect(await scenario.chimeNotes()).toBe(2);
  expect(
    await page.evaluate(() => !!document.activeElement?.closest('[data-testid="agent-toasts"]')),
  ).toBe(false);

  await page.clock.fastForward(30_000);
  await expect(toast).toHaveCount(1);

  await page.keyboard.press("Alt+KeyN");
  await expect(toast.getByTestId("agent-toast-approve")).toBeFocused();

  await toast.getByTestId("agent-toast-approve").click();
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
  await expect(toast.getByTestId("agent-toast-title")).toHaveText("Fix flaky login test");
  await expect(toast.getByTestId("agent-toast-approve")).toHaveCount(0);
  await expect(page.getByTestId("agent-notification-live")).toHaveText(
    "Done: codex · Fix flaky login test",
  );
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
  await expect(toast.getByTestId("agent-toast-title")).toHaveText("3 sessions finished");
  await expect(toast.getByTestId("agent-toast-subject")).toHaveCount(3);
  await expect(page.getByTestId("agent-notification-live")).toHaveText("3 sessions finished");
  expect(await scenario.chimeNotes()).toBe(0);

  await toast.getByTestId("agent-toast-subject").first().click();
  await expect(page).toHaveURL(/\/sessions\?.*session=notify-live-1/);
  await expect(toast).toHaveCount(0);
});
