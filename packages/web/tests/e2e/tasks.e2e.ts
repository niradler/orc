import { expect, test } from "@playwright/test";
import { apiDelete, apiPatch, apiPost, gotoView, tid } from "./_helpers";

interface Task {
  id: string;
  title: string;
  status: string;
  comments_count?: number;
}

test.describe("Tasks CRUD", () => {
  test("create via UI then delete via UI", async ({ page }) => {
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

    // Delete
    await row.getByTestId("task-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);
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

  test("open task detail sheet from table view", async ({ page, request }) => {
    const title = tid("pw-task-detail");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await gotoView(page, "tasks");
      await page.getByTestId("tasks-view-table").click();

      const row = page.locator(`[data-testid="task-row"][data-task-id="${task.id}"]`);
      await expect(row).toBeVisible();

      // Click the row (not the delete button) to open the detail sheet
      await row.locator("td").first().click();

      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(title);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("edit task title via detail sheet reflects in sheet", async ({ page, request }) => {
    const title = tid("pw-task-edit");
    const updatedTitle = `${title}-updated`;
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await gotoView(page, "tasks");
      await page.getByTestId("tasks-view-table").click();

      // Open detail sheet by clicking the first cell
      const row = page.locator(`[data-testid="task-row"][data-task-id="${task.id}"]`);
      await expect(row).toBeVisible();
      await row.locator("td").first().click();

      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();

      // Click "Edit Task" to open the edit dialog
      await sheet.getByRole("button", { name: /edit task/i }).click();

      const editDialog = page.getByTestId("edit-task-dialog");
      await expect(editDialog).toBeVisible();

      // Clear the title input and type a new value
      const titleInput = editDialog.getByTestId("edit-task-title");
      await titleInput.clear();
      await titleInput.fill(updatedTitle);

      await editDialog.getByTestId("edit-task-submit").click();

      await expect(editDialog).not.toBeVisible();
      // Sheet should now reflect the updated title
      await expect(sheet).toContainText(updatedTitle);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("add comment via task detail sheet appears in sheet", async ({ page, request }) => {
    const title = tid("pw-task-comment");
    const commentContent = `PW comment ${tid("c")}`;
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await gotoView(page, "tasks");
      await page.getByTestId("tasks-view-table").click();

      // Open detail sheet
      const row = page.locator(`[data-testid="task-row"][data-task-id="${task.id}"]`);
      await expect(row).toBeVisible();
      await row.locator("td").first().click();

      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();

      // Fill and submit comment
      await sheet.getByPlaceholder("Add a comment...").fill(commentContent);
      await sheet.getByTestId("task-comment-submit").click();

      // Comment text should appear inside the sheet
      await expect(sheet).toContainText(commentContent);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("status filter tab shows only matching tasks", async ({ page, request }) => {
    const todoTitle = tid("pw-task-filter-todo");
    const doingTitle = tid("pw-task-filter-doing");
    const todoTask = await apiPost<Task>(request, "/tasks", {
      title: todoTitle,
      status: "todo",
      priority: "normal",
    });
    const doingTask = await apiPost<Task>(request, "/tasks", {
      title: doingTitle,
      status: "doing",
      priority: "normal",
    });

    try {
      await gotoView(page, "tasks");
      await page.getByTestId("tasks-view-table").click();

      // Click the "Todo" tab
      await page.getByRole("tab", { name: /^todo/i }).click();

      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${todoTask.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${doingTask.id}"]`),
      ).toHaveCount(0);

      // Switch to "Doing" tab
      await page.getByRole("tab", { name: /^doing/i }).click();

      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${doingTask.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${todoTask.id}"]`),
      ).toHaveCount(0);
    } finally {
      await apiDelete(request, `/tasks/${todoTask.id}`);
      await apiDelete(request, `/tasks/${doingTask.id}`);
    }
  });
});
