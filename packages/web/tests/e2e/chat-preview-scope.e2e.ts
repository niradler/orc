import { expect, type Page, test } from "@playwright/test";
import { mockPreviewBridge } from "./_preview-demo";
import { HOME, mockSessionHome } from "./_session-home-demo";

const CHAT_PAGE = `/chat?project=all&chatThread=${HOME.chatA}`;
const SIDE_CHAT = `/?project=all&chat=open&chatThread=${HOME.chatA}`;

async function openSessionSettings(page: Page) {
  if (!(await page.getByTestId("chat-config-button").isVisible()))
    await page.getByTestId("chat-options-button").click();
  await page.getByTestId("chat-config-button").click();
  await expect(page.getByTestId("chat-config-dialog")).toBeVisible();
}

async function closeSessionSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-config-dialog")).toHaveCount(0);
}

for (const width of [1440, 390])
  test.describe(`preview panel scope at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("the chat page keeps the browser and files panel", async ({ page }) => {
      await mockSessionHome(page);
      await mockPreviewBridge(page);
      await page.goto(CHAT_PAGE);
      const toggle = page.getByTestId("chat-preview-toggle");
      await expect(toggle).toBeVisible();
      await openSessionSettings(page);
      await expect(page.getByTestId("chat-browser-agent-access")).toBeVisible();
      await closeSessionSettings(page);
      await toggle.click();
      await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();
      await expect(page.getByTestId("preview-files-tab")).toBeVisible();
    });
  });

test.describe("side chat preview scope", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("side chat has no browser, files or preview entry points", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(SIDE_CHAT);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("chat-preview-toggle")).toHaveCount(0);
    await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
    await openSessionSettings(page);
    await expect(page.getByTestId("chat-browser-agent-access")).toHaveCount(0);
  });

  test("opening a panel on the chat page does not follow the side chat", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    // Enter the chat page from a real page so Close chat has somewhere to return to.
    await page.goto("/activity?project=all");
    await page.goto(CHAT_PAGE);
    await page.getByTestId("chat-preview-toggle").click();
    await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();

    // Close chat returns to the page it came from; the header reopens the side chat there,
    // keeping the same mounted session and its open panel state.
    await page.getByTestId("chat-close-button").click();
    await expect(page).toHaveURL(/\/activity\?project=all$/);
    await page.getByTestId("chat-open-button").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-preview-toggle")).toHaveCount(0);

    // Returning to the chat page restores the panel the conversation already had open.
    await page.getByTestId("chat-fullscreen-button").click();
    await expect(page.getByTestId("chat-preview-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("desktop-preview-panel")).toBeVisible();
  });
});
