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
  await page.getByTestId("chat-settings-tab-customize").click();
}

async function closeSessionSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-config-dialog")).toHaveCount(0);
}

async function openInspector(page: Page) {
  await page.getByTestId("session-inspector-toggle").filter({ visible: true }).click();
  await expect(page.getByTestId("session-inspector")).toBeVisible();
}

test.describe("one chat panel at 1440px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the inspector adds the desktop Browser tab and replaces the preview panel", async ({
    page,
  }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(CHAT_PAGE);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    // The header has one panel control: the preview Globe is gone.
    await expect(page.getByTestId("chat-preview-toggle")).toHaveCount(0);
    await openSessionSettings(page);
    await expect(page.getByTestId("chat-browser-agent-access")).toBeVisible();
    await closeSessionSettings(page);
    await openInspector(page);
    await expect(page.getByTestId("desktop-preview-panel")).toHaveCount(0);
    await expect(page.getByTestId("session-inspector-tab-overview")).toBeVisible();
    await expect(page.getByTestId("session-inspector-tab-diff")).toBeVisible();
    await expect(page.getByTestId("session-inspector-tab-files")).toBeVisible();
    await page.getByTestId("session-inspector-tab-browser").click();
    await expect(page).toHaveURL(/inspector=browser/);
    await expect(page.getByTestId("inspector-browser")).toBeVisible();
    await expect(page.getByTestId("desktop-preview-browser-surface")).toBeVisible();
    // The Browser tab is a tab of the same panel, not a second aside.
    await expect(page.getByTestId("session-inspector")).toHaveCount(1);
  });

  test("without the desktop bridge the same inspector has no Browser tab", async ({ page }) => {
    await mockSessionHome(page);
    await page.goto(`/chat?project=all&sessionTerminal=${HOME.terminal}`);
    await openInspector(page);
    await expect(page.getByTestId("session-inspector-tab-overview")).toBeVisible();
    await expect(page.getByTestId("session-inspector-tab-browser")).toHaveCount(0);
  });

  test("a desktop open request opens the single inspector on its Browser tab", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(CHAT_PAGE);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => !!(window as Window & { __previewOpen?: unknown }).__previewOpen),
      )
      .toBe(true);
    await page.evaluate(() => {
      (window as Window & { __previewOpen?: (request: unknown) => void }).__previewOpen?.({
        kind: "url",
        target: "https://example.com",
      });
    });
    await expect(page.getByTestId("session-inspector")).toBeVisible();
    await expect(page).toHaveURL(/inspector=browser/);
    await expect(page.getByTestId("inspector-browser")).toBeVisible();
    await expect(page.getByTestId("session-inspector")).toHaveCount(1);
  });
});

test.describe("phone inspector", () => {
  test.use({ viewport: { width: 390, height: 900 } });

  test("keeps Overview, Changes and Files without the desktop Browser tab", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(`/chat?project=all&sessionTerminal=${HOME.terminal}`);
    await openInspector(page);
    await expect(page.getByTestId("session-inspector-tab-overview")).toBeVisible();
    await expect(page.getByTestId("session-inspector-tab-browser")).toHaveCount(0);
  });
});

test.describe("side chat scope", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("side chat has no browser, files or panel entry points", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(SIDE_CHAT);
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("chat-preview-toggle")).toHaveCount(0);
    await expect(page.getByTestId("session-inspector-toggle")).toHaveCount(0);
    await expect(page.getByTestId("session-inspector")).toHaveCount(0);
    await openSessionSettings(page);
    await expect(page.getByTestId("chat-browser-agent-access")).toHaveCount(0);
  });

  test("opening the inspector on the chat page does not follow the side chat", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    // Enter the chat page from a real page so Close chat has somewhere to return to.
    await page.goto("/activity?project=all");
    await page.goto(CHAT_PAGE);
    await openInspector(page);
    await page.getByTestId("session-inspector-tab-browser").click();
    await expect(page.getByTestId("desktop-preview-browser-surface")).toBeVisible();

    // Close chat returns to the page it came from; the header reopens the side chat there,
    // which has no inspector and no Browser entry point.
    await page.getByTestId("chat-close-button").click();
    await expect(page).toHaveURL(/\/activity\?project=all$/);
    await page.getByTestId("chat-open-button").click();
    await expect(page.getByTestId("chat-panel")).toBeVisible();
    await expect(page.getByTestId("session-inspector")).toHaveCount(0);
    await expect(page.getByTestId("chat-preview-toggle")).toHaveCount(0);

    // The side chat is a different surface; the chat page opens the inspector again.
    await page.getByTestId("chat-fullscreen-button").click();
    await expect(page.getByTestId("session-inspector")).toHaveCount(0);
    await page.getByTestId("session-inspector-toggle").filter({ visible: true }).click();
    await expect(page.getByTestId("session-inspector")).toBeVisible();
    await page.getByTestId("session-inspector-tab-browser").click();
    await expect(page.getByTestId("desktop-preview-browser-surface")).toBeVisible();
  });
});

test.describe("narrow desktop inspector", () => {
  test.use({ viewport: { width: 1024, height: 800 } });

  test("keeps the Browser surface placed inside the sheet", async ({ page }) => {
    await mockSessionHome(page);
    await mockPreviewBridge(page);
    await page.goto(`/chat?project=all&sessionTerminal=${HOME.terminal}`);
    await openInspector(page);
    await page.getByTestId("session-inspector-tab-browser").click();
    await expect(page.getByTestId("inspector-browser")).toBeVisible();
    await expect(page.getByTestId("desktop-preview-browser-surface")).toBeVisible();
    // The inspector's own Sheet must not be treated as an overlay hiding the
    // native browser view; the bridge still needs real bounds.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const log = (window as Window & { __previewBounds?: unknown[] }).__previewBounds ?? [];
          return log.some((entry) => !!entry && typeof entry === "object");
        }),
      )
      .toBe(true);
  });
});
