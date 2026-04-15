import { expect, test } from "@playwright/test";

const ask = (marker: string) =>
  `Reply with exactly: ${marker}. Do not include any other words, punctuation, quotes, or whitespace around it.`;

test.describe("Chat panel - end-to-end SSE round-trip", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const openBtn = page.getByTestId("chat-open-button");
    if (await openBtn.isVisible().catch(() => false)) {
      await openBtn.click();
    }
    await expect(page.getByTestId("chat-panel")).toBeVisible();
  });

  test("sending a message streams an assistant reply and re-enables input", async ({ page }) => {
    const panel = page.getByTestId("chat-panel");
    const input = page.getByTestId("chat-input");
    const marker = "PW-E2E-OK-1";

    await expect(panel).toHaveAttribute("data-streaming", "false");
    await expect(input).toBeEnabled();

    await input.fill(ask(marker));
    await input.press("Enter");

    // Streaming flag should flip on (within action timeout)
    await expect(panel).toHaveAttribute("data-streaming", "true");
    // Input locked while streaming - proves UI respects streaming state
    await expect(input).toBeDisabled();

    // Wait for SSE 'done' -> flag flips back
    await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 45_000 });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");

    // Assistant message rendered (regression guard: previously the stream hung
    // and the placeholder never promoted into a real message).
    const assistantMessages = page.locator("[data-testid='chat-message'][data-role='assistant']");
    const assistantText = assistantMessages.locator("[data-testid='chat-message-content']").last();
    await expect(assistantText).toContainText(marker);
    await expect(assistantMessages).toHaveCount(1);

    // User's own message is preserved
    const userText = page.locator(
      "[data-testid='chat-message'][data-role='user'] [data-testid='chat-message-content']",
    );
    await expect(userText).toContainText(marker);
  });

  test("consecutive sends do not hang (no stale streaming state)", async ({ page }) => {
    const panel = page.getByTestId("chat-panel");
    const input = page.getByTestId("chat-input");

    for (const marker of ["PW-E2E-SEQ-A", "PW-E2E-SEQ-B"]) {
      await input.fill(ask(marker));
      await input.press("Enter");
      await expect(panel).toHaveAttribute("data-streaming", "false", { timeout: 45_000 });
      await expect(input).toBeEnabled();
    }

    const assistantMessages = page.locator(
      "[data-testid='chat-message'][data-role='assistant'] [data-testid='chat-message-content']",
    );
    await expect(assistantMessages).toHaveCount(2);
    await expect(assistantMessages.nth(0)).toContainText("PW-E2E-SEQ-A");
    await expect(assistantMessages.nth(1)).toContainText("PW-E2E-SEQ-B");
  });
});
