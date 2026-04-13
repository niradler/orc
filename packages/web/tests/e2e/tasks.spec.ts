import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPatch, apiPost, gotoView, tid } from "./_helpers";

interface Task {
  id: string;
  title: string;
  status: string;
}

test.describe("Tasks CRUD", () => {
  test("create via UI then delete via UI", async ({ page, request }) => {
    const title = tid("pw-task");
    await gotoView(page, "tasks");
    await expect(page.getByTestId("view-title")).toHaveText(/tasks/i);

    // Switch to table view so rows are easy to find
    await page.getByTestId("tasks-view-table").click();

    // Create
    await page.getByTestId("new-task-button").click();
    await page.getByTestId("task-title-input").fill(title);
    await page.getByTestId("task-submit").click();

    const row = page.locator(`[data-testid="task-row"][data-task-title="${title}"]`);
    await expect(row).toBeVisible();

    // API verify
    const { tasks } = await apiGet<{ tasks: Task[] }>(request, "/tasks?limit=100");
    const created = tasks.find((t) => t.title === title);
    expect(created).toBeTruthy();

    // Delete
    await row.getByTestId("task-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);

    const { tasks: after } = await apiGet<{ tasks: Task[] }>(request, "/tasks?limit=100");
    expect(after.find((t) => t.title === title)).toBeUndefined();
  });

  test("update task status via API reflects in UI", async ({ page, request }) => {
    const title = tid("pw-task-s");
    const created = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await apiPatch<Task>(request, `/tasks/${created.id}`, { status: "doing" });
      await gotoView(page, "tasks");
      const tableBtn = page.getByTitle("Table view");
      if (await tableBtn.isVisible().catch(() => false)) await tableBtn.click();

      const row = page.locator(`[data-testid="task-row"][data-task-id="${created.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(title);
    } finally {
      await apiDelete(request, `/tasks/${created.id}`);
    }
  });
});
