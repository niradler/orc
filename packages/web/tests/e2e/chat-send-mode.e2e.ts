import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { holdChatStream } from "./_chat-stream";
import { openChatSettings } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };

test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", {
    headers,
    data: { chat: ChatSettingsSchema.parse({}) },
  });
  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
  }, API_SECRET);
  await page.goto("/tasks?chat=open");
});

for (const width of [390, 1440]) {
  test(`While responding saves the send choice per conversation at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByTestId("chat-panel").filter({ visible: true });
    const release = await holdChatStream(page);
    try {
      await panel
        .getByTestId("chat-input")
        .fill("Respond after 2500ms. Reply with exactly: FIRST.");
      await panel.getByTestId("chat-send-button").click();
      await expect(page).toHaveURL(/chatThread=/);
      await expect(panel).toHaveAttribute("data-streaming", "true");
    } finally {
      await release();
    }
    await expect(panel).toHaveAttribute("data-streaming", "false");
    const threadId = new URL(page.url()).searchParams.get("chatThread");
    expect(threadId).toBeTruthy();

    await openChatSettings(page, "customize");
    await expect(page.getByTestId("chat-send-mode")).toHaveValue("steer");
    await page.getByTestId("chat-send-mode").focus();
    await page.screenshot({ path: testInfo.outputPath(`send-mode-${width}.png`) });
    await page.getByTestId("chat-send-mode").selectOption("queue");
    await expect(page.getByTestId("chat-error")).toHaveCount(0);
    await expect
      .poll(async () => {
        const response = await request.get(`/api/chat/threads/${threadId}`, { headers });
        return ((await response.json()) as { config: { sendWhileRunning: string } }).config
          .sendWhileRunning;
      })
      .toBe("queue");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-config-dialog")).toHaveCount(0);

    // The queue path is now the primary send, so a running turn holds the message.
    const steers: string[] = [];
    page.on("request", (incoming) => {
      if (incoming.method() === "POST" && incoming.url().endsWith("/steer"))
        steers.push(incoming.url());
    });
    await panel.getByTestId("chat-input").fill("Respond after 2500ms. Reply with exactly: SECOND.");
    await panel.getByTestId("chat-send-button").click();
    await expect(panel).toHaveAttribute("data-streaming", "true");
    await expect(panel.getByTestId("chat-input")).toBeEnabled();
    await expect(panel.getByTestId("chat-send-outcome")).toHaveText(
      "Send queues until the turn ends.",
    );
    await panel.getByTestId("chat-input").fill("Reply with exactly: HELD.");
    await panel.getByTestId("chat-send-button").click();
    await expect(panel.getByTestId("chat-pending-count")).toHaveText("1 pending");
    await page.screenshot({ path: testInfo.outputPath(`queued-${width}.png`) });
    if (process.env.ORC_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.ORC_SCREENSHOT_DIR}/composer-queues-${width}.png`,
      });
    expect(steers).toHaveLength(0);
  });
}
