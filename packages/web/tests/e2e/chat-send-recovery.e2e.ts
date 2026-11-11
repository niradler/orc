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
