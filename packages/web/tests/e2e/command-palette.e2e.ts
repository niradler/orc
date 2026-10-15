import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, gotoView, tid } from "./_helpers";

for (const theme of ["dark", "light"])
  for (const width of [1440, 390]) {
    test(`command palette search and actions ${theme} ${width}`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        ({ theme, secret }) => {
          localStorage.setItem("orc_theme", theme);
          localStorage.setItem("orc_api_secret", secret);
        },
        { theme, secret: API_SECRET },
      );
      const term = tid("palette");
      const project = await apiPost<{ id: string }>(request, "/projects", {
        name: `${term}-project`,
      });
      const other = await apiPost<{ id: string }>(request, "/projects", { name: `${term}-other` });
      const task = await apiPost<{ id: string }>(request, "/tasks", {
        title: `${term} remote task`,
        project_id: other.id,
      });
      await apiPost(request, "/memories", { content: `${term} memory`, project_id: project.id });
      await gotoView(page, "tasks");
      await page.goto(`/tasks?project=${project.id}`);
      const trigger = page.getByTestId("command-palette-open");
      await trigger.click();
      const input = page.getByTestId("command-palette-input");
      await expect(input).toBeFocused();
      await input.fill(term);
      const remote = page.locator(`[data-command-id="task-${other.id}-${task.id}"]`);
      await expect(remote).toBeVisible();
      await page.getByTestId("palette-scope").click();
      await expect(remote).toHaveCount(0);
      await expect(page.locator('[data-command-id^="memory-"]')).toBeVisible();
      await page.getByTestId("palette-scope").click();
      await expect(remote).toBeVisible();
      const palette = page.getByTestId("command-palette");
      const bounds = await palette.boundingBox();
      if (!bounds) throw new Error("Command palette has no visible bounds");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await palette.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const accessibility = await new AxeBuilder({ page })
        .include('[data-testid="command-palette"]')
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("global-search.png") });
      await remote.click();
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?project=${other.id}`));
      await expect(page.getByTestId("command-palette")).toHaveCount(0);
      // Close the existing task sheet before using the global shortcut.
      await expect(page.getByTestId("task-detail-sheet")).toBeVisible();
      await page.getByTestId("task-detail-sheet").getByTestId("sheet-close").click();
      await expect(page.getByTestId("task-detail-sheet")).toHaveCount(0);
      await page.keyboard.press("Control+k");
      await expect(input).toBeFocused();
      await input.fill("go settings");
      await input.press("ArrowDown");
      await input.press("Enter");
      await expect(page).toHaveURL(/\/settings\?/);
      await trigger.click();
      await input.fill("create task");
      await input.press("Enter");
      await expect(page.getByTestId("task-title-input")).toBeVisible();
      await page.keyboard.press("Escape");
      await trigger.click();
      await input.fill("switch theme");
      await input.press("Enter");
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme === "dark" ? "light" : "dark",
      );
      await trigger.click();
      await input.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.click();
      await input.fill("zzzznothingmatcheszzzz");
      await expect(page.getByTestId("palette-status")).toContainText("No results");
      await expect(page.getByTestId("command-palette")).toBeInViewport();
    });
  }

test("palette keeps actions usable when resource search fails and retries", async ({ page }) => {
  await gotoView(page, "tasks");
  let fail = true;
  await page.route("**/api/search?*", async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"offline"}',
      });
    else await route.continue();
  });
  await page.getByTestId("command-palette-open").click();
  const input = page.getByTestId("command-palette-input");
  await input.fill("create task");
  await expect(page.getByTestId("palette-retry")).toBeVisible();
  await expect(page.locator('[data-command-id="new-task"]')).toBeVisible();
  fail = false;
  await page.getByTestId("palette-retry").click();
  await expect(page.getByTestId("palette-retry")).toHaveCount(0);
  await page.getByTestId("palette-filter-actions").click();
  await input.press("Enter");
  await expect(page.getByTestId("task-title-input")).toBeVisible();
});

test("palette actions save tasks, switch scope and open terminal setup", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: tid("palette-actions"),
  });
  await gotoView(page, "tasks");
  const trigger = page.getByTestId("command-palette-open");
  const input = page.getByTestId("command-palette-input");
  await trigger.click();
  await input.fill(`switch ${project.name}`);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
  await page.keyboard.press("Meta+k");
  await input.fill("create task");
  await input.press("Enter");
  const title = tid("palette-created-task");
  await page.getByTestId("task-title-input").fill(title);
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("task-detail-sheet")).toBeVisible();
  const taskId = new URL(page.url()).pathname.split("/").at(-1);
  const saved = await apiGet<{ title: string; project_id: string }>(request, `/tasks/${taskId}`);
  expect(saved.title).toBe(title);
  expect(saved.project_id).toBe(project.id);
  await page.reload();
  await expect(page.getByTestId("task-detail-sheet")).toBeVisible();
  await page.getByTestId("task-detail-sheet").getByTestId("sheet-close").click();
  await expect(page.getByTestId("task-detail-sheet")).toHaveCount(0);
  await trigger.click();
  await input.fill("new terminal");
  await input.press("Enter");
  await expect(page.getByTestId("terminal-launch-menu")).toBeVisible();
  await expect(page).not.toHaveURL(/new=1/);
});
