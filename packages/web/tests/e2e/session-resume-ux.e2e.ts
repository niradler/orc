import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("history sidebar resizes by dragging and keyboard, persists and resets", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: {
        threads: Array.from({ length: 6 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          title: `Session ${index + 1}: Review workspace changes and continue implementation`,
          updatedAt: Date.now() - index * 1000,
          running: false,
          agent: "codex",
        })),
      },
    }),
  );
  await gotoView(page, "tasks");
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-fullscreen-button").click();
  const handle = page.getByTestId("chat-history-resize");
  const sidebar = page.getByTestId("chat-session-sidebar");
  await expect(sidebar.getByTestId("chat-resume-thread")).toHaveCount(6);
  await expect(handle).toHaveAttribute("aria-valuenow", "256");
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error("Missing resize handle");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 160, bounds.y + bounds.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "416px");
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar).toHaveCSS("width", "432px");
  await page.screenshot({ path: testInfo.outputPath("history-expanded-desktop.png") });
  await page.reload();
  if (!(await page.getByTestId("chat-panel").isVisible()))
    await page.getByTestId("chat-open-button").click();
  if (!(await handle.isVisible())) await page.getByTestId("chat-fullscreen-button").click();
  await expect(sidebar).toHaveCSS("width", "432px");
  await handle.dblclick();
  await expect(sidebar).toHaveCSS("width", "256px");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toHaveCount(0);
  await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
  await expect(page.getByTestId("chat-sessions-dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("history-phone-drawer.png") });
});
