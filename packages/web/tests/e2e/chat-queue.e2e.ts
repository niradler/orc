import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { closeChatHistory, openChatActions, openChatHistory } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", { headers, data: { chat: ChatSettingsSchema.parse({}) } });
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
  }, API_SECRET);
  await page.goto("/tasks?chat=open");
});

async function send(panel: Locator, text: string) {
  await panel.getByTestId("chat-input").fill(text);
  await panel.getByTestId("chat-send-button").click();
}
async function expandQueue(panel: Locator) {
  const queue = panel.getByTestId("chat-message-queue");
  if ((await queue.getAttribute("open")) === null)
    await panel.getByTestId("chat-queue-toggle").click();
}
function posts(page: Page) {
  const values: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/chat/stream"))
      values.push(request.postDataJSON().messages[0].content);
  });
  return values;
}

test("keeps accepting messages while running and drains edited messages in order", async ({
  page,
}) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 2500ms. Reply with exactly: FIRST.");
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await expect(panel.getByTestId("chat-input")).toBeEnabled();
  await send(panel, "Reply with exactly: ORIGINAL.");
  await send(panel, "Reply with exactly: THIRD.");
  const pending = panel.getByTestId("chat-queued-message");
  await expect(pending).toHaveCount(2);
  await expect(panel.getByTestId("chat-pending-count")).toHaveText("2 pending");
  await expandQueue(panel);
  await pending.first().getByTestId("chat-queued-edit").click();
  await pending.first().getByTestId("chat-queued-input").fill("Reply with exactly: EDITED.");
  await expect(panel).toHaveAttribute("data-streaming", "false");
  expect(sent).toHaveLength(1); // editing reserves the pending entry even when the turn finishes
  await pending.first().getByTestId("chat-queued-save").click();
  await expect(pending).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  expect(sent).toEqual([
    "Respond after 2500ms. Reply with exactly: FIRST.",
    "Reply with exactly: EDITED.",
    "Reply with exactly: THIRD.",
  ]);
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("THIRD");
});

test("force send stops the live run and prioritizes the selected message once", async ({
  page,
}) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 10000ms. Reply with exactly: INTERRUPTED.");
  await expect(page).toHaveURL(/chatThread=/);
  await send(panel, "Reply with exactly: LATER.");
  await send(panel, "Reply with exactly: NOW.");
  const cancelled = page.waitForResponse((response) =>
    /\/chat\/runs\/[^/]+\/cancel$/.test(response.url()),
  );
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-message").nth(1).getByTestId("chat-queued-force").click();
  expect((await cancelled).ok()).toBe(true);
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  expect(sent.slice(1)).toEqual(["Reply with exactly: NOW.", "Reply with exactly: LATER."]);
});

test("Stop holds pending messages until explicitly forced", async ({ page }) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 10000ms. Reply with exactly: STOP.");
  await send(panel, "Reply with exactly: PENDING.");
  await panel.getByTestId("chat-cancel-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(1);
  expect(sent).toHaveLength(1);
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-force").click();
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("PENDING");
  expect(sent).toHaveLength(2);
});

test("queued messages stay with their background conversation across refresh", async ({ page }) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 2500ms. Reply with exactly: BACKGROUND.");
  await expect(page).toHaveURL(/chatThread=/);
  await send(panel, "Reply with exactly: QUEUED.");
  await openChatActions(page);
  await page.getByTestId("chat-refresh-button").click();
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(1);
  await panel.getByTestId("chat-clear-button").click();
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
  await send(panel, "Reply with exactly: OTHER.");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("OTHER");
  await openChatHistory(page);
  await expect(
    page.getByTestId("chat-session-list").getByTestId("chat-tab").filter({ hasText: "BACKGROUND" }),
  ).toHaveAttribute("data-state", "attention");
  await page
    .getByTestId("chat-session-list")
    .getByTestId("chat-tab")
    .filter({ hasText: "BACKGROUND" })
    .getByTestId("chat-session-select")
    .click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("QUEUED");
  expect(sent).toHaveLength(3);
});

test("forcing before a run is named waits for cancellation before dispatching", async ({
  page,
}) => {
  const sent = posts(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/chat/stream", async (route) => {
    if (first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 10000ms. Reply with exactly: DELAYED.");
  await send(panel, "Reply with exactly: FORCED.");
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-force").click();
  expect(sent).toHaveLength(1);
  const cancelled = page.waitForRequest((request) =>
    /\/chat\/runs\/[^/]+\/cancel$/.test(request.url()),
  );
  release();
  await cancelled;
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("FORCED");
  expect(sent).toHaveLength(2);
});

test("a failed stop leaves the queue pending and displays the error", async ({ page }) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 3000ms. Reply with exactly: RUNNING.");
  await expect(page).toHaveURL(/chatThread=/);
  await send(panel, "Reply with exactly: PENDING.");
  await page.route("**/api/chat/runs/*/cancel", (route) =>
    route.fulfill({ status: 503, json: { error: "Unable to stop" } }),
  );
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-force").click();
  await expect(panel.getByTestId("chat-error")).toContainText("Unable to stop");
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(1);
  expect(sent).toHaveLength(1);
});

test("queued editing rejects blank text and cancelling retains the original", async ({ page }) => {
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 2000ms. Reply with exactly: FIRST.");
  await send(panel, "Reply with exactly: ORIGINAL.");
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-edit").click();
  await panel.getByTestId("chat-queued-input").fill("   ");
  await expect(panel.getByTestId("chat-queued-save")).toBeDisabled();
  await expect(panel.getByTestId("chat-queued-force")).toHaveCount(0);
  await panel.getByTestId("chat-queued-edit-cancel").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("ORIGINAL");
});

test("mobile composer queues messages without overflowing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 2000ms. Reply with exactly: MOBILE.");
  await send(panel, "x".repeat(200));
  await expect(panel.getByTestId("chat-queue-toggle")).toBeVisible();
  await expect(panel.getByTestId("chat-queued-content")).not.toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("desktop Enter queues, Shift+Enter inserts a newline, and whitespace does not send", async ({
  page,
}) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 3000ms. Reply with exactly: FIRST.");
  const input = panel.getByTestId("chat-input");
  await input.fill("line one");
  await input.press("Shift+Enter");
  await input.press("x");
  await expect(input).toHaveValue("line one\nx");
  await input.press("Enter");
  await expect(panel.getByTestId("chat-queued-content")).toHaveText("line one\nx");
  await expect(input).toHaveValue("");
  await input.fill("   ");
  await expect(panel.getByTestId("chat-send-button")).toBeDisabled();
  await input.press("Enter");
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(1);
  expect(sent).toHaveLength(1);
});

test("a rejected turn pauses the rest of the queue without retrying POST", async ({ page }) => {
  const sent = posts(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/chat/stream", async (route) => {
    await held;
    await route.fulfill({ status: 400, json: { error: "Rejected turn" } });
  });
  const panel = page.getByTestId("chat-panel");
  await send(panel, "FIRST");
  await send(panel, "KEEP PENDING");
  release();
  await expect(panel.getByTestId("chat-error")).toContainText("Rejected turn");
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-queued-content")).toHaveText("KEEP PENDING");
  expect(sent).toHaveLength(1);
});

test("closing a conversation cannot dispatch its pending message", async ({ page }) => {
  const sent = posts(page);
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Respond after 1800ms. Reply with exactly: FIRST.");
  await expect(page).toHaveURL(/chatThread=/);
  await send(panel, "NEVER SENT");
  await openChatHistory(page);
  await page.getByTestId("chat-session-list").getByTestId("chat-tab-close").click();
  await closeChatHistory(page);
  await send(panel, "Respond after 2500ms. Reply with exactly: OTHER.");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("OTHER");
  expect(sent).toHaveLength(2);
  expect(sent).not.toContain("NEVER SENT");
});

test("should retain mobile drafts and pending edits when hiding and reopening chat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByTestId("chat-panel").filter({ visible: true });
  await panel.getByTestId("chat-input").fill("Unsent mobile draft");
  await panel.getByTestId("chat-close-button").click();
  await page.getByTestId("chat-open-button").click();
  await expect(panel.getByTestId("chat-input")).toHaveValue("Unsent mobile draft");
  await send(panel, "Respond after 1500ms. Reply with exactly: FIRST.");
  await send(panel, "ORIGINAL");
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-edit").click();
  await panel.getByTestId("chat-queued-input").fill("Saved after reopening");
  await panel.getByTestId("chat-close-button").click();
  await page.getByTestId("chat-open-button").click();
  await expect(panel.getByTestId("chat-queued-input")).toHaveValue("Saved after reopening");
  await panel.getByTestId("chat-queued-save").click();
  await expect(panel.getByTestId("chat-message-content").last()).toContainText(
    "Saved after reopening",
  );
});

test("should keep the composer draft when switching to fullscreen and back", async ({ page }) => {
  const panel = page.getByTestId("chat-panel").filter({ visible: true });
  await panel.getByTestId("chat-input").fill("Unsent desktop draft");
  await panel.getByTestId("chat-fullscreen-button").click();
  await expect(panel.getByTestId("chat-input")).toHaveValue("Unsent desktop draft");
  await panel.getByTestId("chat-fullscreen-button").click();
  await expect(panel.getByTestId("chat-input")).toHaveValue("Unsent desktop draft");
});

for (const width of [390, 1440]) {
  test(`should remove pending and edited messages without dispatching them at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByTestId("chat-panel").filter({ visible: true });
    const sent = posts(page);
    await send(panel, "Respond after 3000ms. Reply with exactly: FIRST.");
    await send(panel, "REMOVE FIRST");
    await send(panel, "REMOVE WHILE EDITING");
    await send(panel, "Reply with exactly: KEEP ONE.");
    await send(panel, "Reply with exactly: KEEP TWO.");
    await expandQueue(panel);
    const pending = panel.getByTestId("chat-queued-message");
    await pending.first().getByTestId("chat-queued-remove").click();
    await expect(pending).toHaveCount(3);
    await pending.first().getByTestId("chat-queued-edit").click();
    await panel.getByTestId("chat-queued-input").fill("UNSAVED REMOVED EDIT");
    await pending.first().getByTestId("chat-queued-remove").click();
    await expect(panel.getByTestId("chat-queued-input")).toHaveCount(0);
    await expect(panel.getByTestId("chat-pending-count")).toHaveText("2 pending");
    await expect(panel).toHaveAttribute("data-streaming", "false");
    await expect(pending).toHaveCount(0);
    expect(sent).toEqual([
      "Respond after 3000ms. Reply with exactly: FIRST.",
      "Reply with exactly: KEEP ONE.",
      "Reply with exactly: KEEP TWO.",
    ]);
  });

  test(`should keep the queue compact and collapsed by default at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByTestId("chat-panel").filter({ visible: true });
    await send(panel, "Respond after 10000ms. Reply with exactly: FIRST.");
    await send(panel, "A long pending message ".repeat(20));
    await send(panel, "Second pending message");
    const queue = panel.getByTestId("chat-message-queue");
    const toggle = panel.getByTestId("chat-queue-toggle");
    await expect(toggle).toHaveText("2 pending");
    await expect(queue).not.toHaveAttribute("open");
    expect((await queue.boundingBox())?.height).toBeLessThanOrEqual(46);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(queue).toHaveAttribute("open");
    const rows = panel.getByTestId("chat-queued-message");
    await expect(rows.first().getByTestId("chat-queued-edit")).toBeVisible();
    expect((await rows.first().boundingBox())?.height).toBeLessThanOrEqual(46);
    expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(queue).not.toHaveAttribute("open");
    await send(panel, "Third pending message");
    await expect(toggle).toHaveText("3 pending");
    await expect(queue).not.toHaveAttribute("open");
    await panel.getByTestId("chat-cancel-button").click();
  });
}

test("should hide an emptied paused queue and accept a new message", async ({ page }) => {
  const panel = page.getByTestId("chat-panel");
  const sent = posts(page);
  await send(panel, "Respond after 10000ms. Reply with exactly: FIRST.");
  await send(panel, "REMOVE ME");
  await panel.getByTestId("chat-cancel-button").click();
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expandQueue(panel);
  await panel.getByTestId("chat-queued-remove").click();
  await expect(panel.getByTestId("chat-message-queue")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await send(panel, "Reply with exactly: NEW.");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("NEW");
  expect(sent).toHaveLength(2);
});
