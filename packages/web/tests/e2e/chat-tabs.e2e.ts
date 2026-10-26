import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});
const login = (secret: string) =>
  localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);

test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(login, API_SECRET);
});
test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
});

test("a run keeps going in its own tab while another conversation runs, and the link opens it", async ({
  page,
  browser,
  baseURL,
}) => {
  const background = `BG-${Date.now()}`;
  const foreground = `FG-${Date.now()}`;
  await page.goto("/tasks?chat=open");
  const panel = page.getByTestId("chat-panel");
  await panel
    .getByTestId("chat-input")
    .fill(`Respond after 2500ms. Reply with exactly: ${background}.`);
  await panel.getByTestId("chat-send-button").click();
  const tabs = panel.getByTestId("chat-tab");
  await expect(tabs.first()).toHaveAttribute("data-state", "running");

  await panel.getByTestId("chat-clear-button").click();
  await expect(tabs).toHaveCount(2);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${foreground}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(foreground);
  await expect(panel.getByTestId("chat-messages")).not.toContainText(background);

  // The first run finished unseen, so its tab asks for attention instead of being dropped.
  await expect(tabs.first()).toHaveAttribute("data-state", "attention", { timeout: 10000 });
  await tabs.first().getByRole("tab").click();
  await expect(tabs.first()).toHaveAttribute("data-active", "true");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(background);
  await expect(tabs.first()).toHaveAttribute("data-state", "idle");

  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);
  const shared = page.url();
  const other = await browser.newContext({ baseURL });
  try {
    const visitor = await other.newPage();
    await visitor.addInitScript(login, API_SECRET);
    await visitor.goto(shared);
    await expect(
      visitor.getByTestId("chat-panel").getByTestId("chat-message-content").last(),
    ).toContainText(background);
  } finally {
    await other.close();
  }
});

test("chat preferences picked in the browser survive a reload", async ({ page }) => {
  await page.goto("/tasks?chat=open");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-agent-select").selectOption("claude");
  await panel.getByTestId("chat-config-button").click();
  await page.getByTestId("chat-permission-mode").selectOption("bypassPermissions");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("chat-panel").getByTestId("chat-agent-select")).toHaveValue(
    "claude",
  );
  await page.getByTestId("chat-panel").getByTestId("chat-config-button").click();
  await expect(page.getByTestId("chat-permission-mode")).toHaveValue("bypassPermissions");
});

test("stopping a reply before its run is named and closing the tab still stops the run", async ({
  page,
}) => {
  await page.goto("/tasks?chat=open");
  const panel = page.getByTestId("chat-panel");
  const first = `FIRST-${Date.now()}`;
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${first}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(first);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat/stream", async (route) => {
    await held;
    await route.continue();
  });
  await panel.getByTestId("chat-clear-button").click();
  const tabs = panel.getByTestId("chat-tab");
  await expect(tabs).toHaveCount(2);
  await panel.getByTestId("chat-input").fill("Respond after 5000ms. Reply with exactly: LATE.");
  await panel.getByTestId("chat-send-button").click();
  await panel.getByTestId("chat-cancel-button").click();
  await tabs.nth(1).getByTestId("chat-tab-close").click();
  await expect(tabs).toHaveCount(1);
  const cancelled = page.waitForRequest(
    (request) =>
      request.method() === "POST" && /\/api\/chat\/runs\/[^/]+\/cancel$/.test(request.url()),
  );
  release();
  await cancelled;
});

test("a reopened tab shows a reply that finished between loading it and attaching", async ({
  page,
}) => {
  const reply = `DONE-${Date.now()}`;
  await page.goto("/tasks?chat=open");
  const panel = page.getByTestId("chat-panel");
  await panel.getByTestId("chat-input").fill(`Reply with exactly: ${reply}.`);
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(reply);
  await expect(page).toHaveURL(/[?&]chatThread=[0-9a-f-]{36}/);

  // The first load sees the question still unanswered; by the time the tab attaches, the turn
  // has finished.
  let first = true;
  await page.route(/\/api\/chat\/threads\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    if (first) {
      first = false;
      thread.messages = thread.messages.slice(0, -1);
    }
    await route.fulfill({ response, json: thread });
  });
  await page.reload();
  await expect(
    page.getByTestId("chat-panel").getByTestId("chat-message-content").last(),
  ).toContainText(reply);
});
