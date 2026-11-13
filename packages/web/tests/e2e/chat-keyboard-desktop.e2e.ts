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
  await page.route("**/api/git/worktrees?**", (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({
      json: { root: cwd, worktrees: [{ path: cwd, branch: "refs/heads/main", main: true }] },
    });
  });
  await page.route("**/api/git/branches?**", (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({
      json: {
        root: cwd,
        current: "main",
        default_branch: "origin/main",
        local: ["main"],
        remote: ["origin/main"],
      },
    });
  });
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
      "chat-agent-model-button",
      "chat-workspace-folder",
      "chat-workspace-branch",
    ]) {
      await expect(panel.getByTestId(id)).toBeInViewport();
      await expect(panel.getByTestId(id)).toHaveAccessibleName(/\S/);
    }
    await expect(panel.getByTestId("chat-send-button")).toBeInViewport();
    const tools = await panel
      .getByTestId("chat-composer-tools")
      .evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(tools.scrollWidth).toBeLessThanOrEqual(tools.width);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(artifacts, `desktop-${theme}.png`) });
  }
});
