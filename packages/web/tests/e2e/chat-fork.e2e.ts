import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
});

// The browser suite runs with ORC_E2E_CHAT_MOCK, so a fork must fall back to the
// portable context replay and say so instead of spawning a provider process.
for (const width of [1440, 390]) {
  test(`forks a completed response with a visible context notice at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tasks");
    await page.getByTestId("chat-open-button").click();
    await page
      .getByTestId("chat-input")
      .fill("Respond after 1500ms. Reply with exactly: FORK-SOURCE.");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-message-content").last()).toContainText("FORK-SOURCE", {
      timeout: 15_000,
    });
    // Durations below a second are intentionally hidden, so the mock waits.
    await expect(page.getByTestId("chat-message-duration").last()).toBeVisible();

    const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
    if (width > 767) await assistant.hover();
    // Touch and narrow layouts keep the actions visible without hover.
    await expect(assistant.getByTestId("chat-message-copy")).toBeVisible();
    await assistant.getByTestId("chat-message-fork").click();

    const notice = page.getByTestId("chat-fork-notice");
    await expect(notice).toContainText("Forked from");
    await expect(notice).toContainText("context replay");
    await expect(notice).toContainText("2 messages");
    await expect(notice).toContainText("text only");
    await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(
      1,
    );

    await notice.getByRole("button", { name: "Open source chat" }).click();
    await expect(page.getByTestId("chat-fork-notice")).toHaveCount(0);
    await expect(page.getByTestId("chat-message-content").last()).toContainText("FORK-SOURCE");
  });
}
