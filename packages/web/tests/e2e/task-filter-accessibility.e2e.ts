import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("task status deep links expose a selected tab linked to the visible results", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  for (const status of ["all", "todo", "queued", "paused", "cancelled", "changes_requested"]) {
    await page.goto(`/tasks?view=table&status=${status}`);
    const selected = page.getByRole("tab", { selected: true });
    const panel = page.getByRole("tabpanel");
    await expect(selected).toHaveCount(1);
    await expect(panel).toBeVisible();
    const tabId = await selected.getAttribute("id");
    const panelId = await panel.getAttribute("id");
    expect(tabId).toBeTruthy();
    expect(panelId).toBeTruthy();
    await expect(selected).toHaveAttribute("aria-controls", panelId as string);
    await expect(panel).toHaveAttribute("aria-labelledby", tabId as string);
    if (status === "queued") {
      await selected.press("ArrowLeft");
      await expect(page).toHaveURL(/status=done/);
      await expect(page.getByRole("tab", { name: /^Done/, selected: true })).toBeVisible();
    }
  }
});
