import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Locator, test } from "@playwright/test";
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

test("a send that never reaches the server returns to the queue instead of vanishing", async ({
  page,
}) => {
  const panel = page.getByTestId("chat-panel");
  await send(panel, "Reply with exactly: FIRST.");
  await expect(page).toHaveURL(/chatThread=/);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("FIRST");

  let dropped = 0;
  await page.route("**/api/chat/stream", async (route) => {
    if (dropped++ === 0) return route.abort("internetdisconnected");
    return route.fallback();
  });
  await send(panel, "Reply with exactly: RECOVERED.");

  await expect(panel.getByTestId("chat-error")).toContainText("didn't reach the agent");
  const pending = panel.getByTestId("chat-queued-message");
  await expect(pending).toHaveCount(1);
  if ((await panel.getByTestId("chat-message-queue").getAttribute("open")) === null)
    await panel.getByTestId("chat-queue-toggle").click();
  await expect(pending.getByTestId("chat-queued-content")).toContainText("RECOVERED");
  await expect(panel.getByTestId("chat-message-content")).not.toContainText(["RECOVERED"]);

  await pending.getByTestId("chat-queued-force").click();
  await expect(pending).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-error")).toHaveCount(0);
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("RECOVERED");
  expect(dropped).toBe(2);
});

test("a first send that never reaches the server returns to the queue after a bounded lookup", async ({
  page,
}) => {
  // The recovery window is 15s of backoff; fake timers keep the test fast while
  // the by-message lookups still hit the real server.
  await page.clock.install();
  await page.reload();
  const panel = page.getByTestId("chat-panel");
  let lookups = 0;
  await page.route("**/api/chat/threads/by-message/**", (route) => {
    lookups++;
    return route.fallback();
  });
  await page.route("**/api/chat/stream", (route) => route.abort("internetdisconnected"));
  await send(panel, "Reply with exactly: ORPHAN.");
  await expect(panel.getByTestId("chat-reconnecting")).toBeVisible();
  // Backoff 1s, 2s, 4s, then the 15s window closes before the 8s wait completes.
  // A connectivity wake may add an extra lookup, so counts are lower bounds.
  await page.clock.fastForward(1_000);
  await expect.poll(() => lookups).toBeGreaterThanOrEqual(1);
  await page.clock.fastForward(2_000);
  await expect.poll(() => lookups).toBeGreaterThanOrEqual(2);
  await page.clock.fastForward(4_000);
  await expect.poll(() => lookups).toBeGreaterThanOrEqual(3);
  await page.clock.fastForward(8_000);

  await expect(panel.getByTestId("chat-error")).toContainText("back in the queue");
  await expect(panel.getByTestId("chat-error")).not.toContainText("Refresh");
  await expect(panel.getByTestId("chat-reconnecting")).toHaveCount(0);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-pending-count")).toContainText("Paused");
  const pending = panel.getByTestId("chat-queued-message");
  await expect(pending).toHaveCount(1);
  if ((await panel.getByTestId("chat-message-queue").getAttribute("open")) === null)
    await panel.getByTestId("chat-queue-toggle").click();
  await expect(pending.getByTestId("chat-queued-content")).toContainText("ORPHAN");
  // No phantom bubble and no adopted thread: the send never landed.
  await expect(panel.getByTestId("chat-message-content")).toHaveCount(0);
  await expect(page).not.toHaveURL(/chatThread=/);
  // Bounded: once the window closes, polling stops for good.
  const settled = lookups;
  expect(settled).toBeGreaterThanOrEqual(3);
  await page.clock.fastForward(30_000);
  expect(lookups).toBe(settled);
});

test("a first send whose response is lost adopts the thread the server created", async ({
  page,
}) => {
  const panel = page.getByTestId("chat-panel");
  await page.route("**/api/chat/stream", async (route) => {
    await route.fetch();
    return route.abort("internetdisconnected");
  });
  await send(panel, "Reply with exactly: ADOPTED.");
  await expect(page).toHaveURL(/chatThread=/);
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-message-content")).toHaveCount(2);
  await expect(panel.getByTestId("chat-message-content").first()).toContainText("ADOPTED");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("ADOPTED");
  await expect(panel.getByTestId("chat-error")).toHaveCount(0);
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
});

test("a first send lost mid-turn adopts the thread and streams the running reply", async ({
  page,
}) => {
  const panel = page.getByTestId("chat-panel");
  let attaches = 0;
  await page.route("**/api/chat/threads/*/live", (route) => {
    attaches++;
    return route.fallback();
  });
  await page.route("**/api/chat/stream", async (route) => {
    // Forward in the background so the server starts the turn, then drop the
    // response before the page sees it.
    void route.fetch().catch(() => {});
    return route.abort("internetdisconnected");
  });
  await send(panel, "Reply with exactly: RUNNING. reply after 3000ms");
  await expect(page).toHaveURL(/chatThread=/);
  await expect(panel).toHaveAttribute("data-streaming", "true");
  await expect(panel.getByTestId("chat-message-content").first()).toContainText("RUNNING");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("RUNNING", {
    timeout: 15_000,
  });
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-message-content")).toHaveCount(2);
  await expect(panel.getByTestId("chat-error")).toHaveCount(0);
  await expect(panel.getByTestId("chat-queued-message")).toHaveCount(0);
  expect(attaches).toBeGreaterThanOrEqual(1);
});
