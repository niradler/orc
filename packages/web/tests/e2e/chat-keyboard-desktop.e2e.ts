import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET, gotoView, repoRoot } from "./_helpers";

test("desktop composer keeps the full workspace controls in both themes", async ({
  page,
  request,
}) => {
  const artifacts = join(repoRoot(), ".claude/validation/chat-keyboard");
  mkdirSync(artifacts, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/ssh", (route) =>
    route.fulfill({ json: { host: null, hosts: ["lab"], supported: true } }),
  );
  for (const theme of ["dark", "light"] as const) {
    const response = await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: { theme, chat: ChatSettingsSchema.parse({}) },
    });
    expect(response.ok()).toBe(true);
    await gotoView(page, "tasks");
    await page.getByTestId("chat-open-button").click();
    const panel = page.getByTestId("chat-panel").filter({ visible: true });
    await panel.getByTestId("chat-input").fill("Review the workspace changes before sending.");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect
      .poll(() => panel.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(theme === "dark" ? "rgb(0, 0, 0)" : "rgb(250, 250, 250)");
    for (const id of [
      "chat-workspace-host",
      "chat-workspace-browse",
      "chat-workspace-recent",
      "chat-workspace-worktree",
    ])
      await expect(panel.getByTestId(id)).toBeInViewport();
    await expect(panel.getByTestId("chat-send-button")).toBeInViewport();
    expect(
      await panel
        .getByTestId("chat-workspace-actions")
        .evaluate((element) => getComputedStyle(element).overflowX),
    ).toBe("visible");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(artifacts, `desktop-${theme}.png`) });
  }
});
