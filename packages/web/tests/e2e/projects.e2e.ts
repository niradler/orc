import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

interface Project {
  id: string;
  name: string;
  status: string;
}

test.describe("Projects CRUD", () => {
  test("create via UI, then delete via UI", async ({ page }) => {
    const name = tid("pw-proj");
    await gotoView(page, "projects");
    await expect(page.getByTestId("view-title")).toHaveText(/projects/i);

    // Create
    await page.getByTestId("new-project-button").click();
    await page.getByTestId("project-name-input").fill(name);
    await page.getByTestId("project-submit").click();

    // Row appears
    const row = page.locator(`[data-testid="project-row"][data-project-name="${name}"]`);
    await expect(row).toBeVisible();

    // Delete via UI
    await row.getByTestId("project-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(row).toHaveCount(0);
  });

  test("update via API reflects in UI", async ({ page, request }) => {
    const name = tid("pw-proj-u");
    const created = await apiPost<Project>(request, "/projects", {
      name,
      status: "active",
    });
    try {
      await gotoView(page, "projects");
      const row = page.locator(`[data-testid="project-row"][data-project-id="${created.id}"]`);
      await expect(row).toContainText(name);
    } finally {
      await apiDelete(request, `/projects/${created.id}`);
    }
  });

  test("edit project name via UI updates in table", async ({ page, request }) => {
    const name = tid("pw-proj-edit");
    const updatedName = `${name}-renamed`;
    const created = await apiPost<Project>(request, "/projects", {
      name,
      status: "active",
    });

    try {
      await gotoView(page, "projects");

      // Click the row to open the edit dialog
      const row = page.locator(`[data-testid="project-row"][data-project-id="${created.id}"]`);
      await expect(row).toBeVisible();
      await row.click();

      const editDialog = page.getByTestId("edit-project-dialog");
      await expect(editDialog).toBeVisible();

      // Clear and type the new name
      const nameInput = editDialog.getByTestId("edit-project-name-input");
      await nameInput.clear();
      await nameInput.fill(updatedName);

      await editDialog.getByTestId("edit-project-submit").click();

      // The row in the table should now show the new name
      const updatedRow = page.locator(
        `[data-testid="project-row"][data-project-name="${updatedName}"]`,
      );
      await expect(updatedRow).toBeVisible();
      await expect(editDialog).not.toBeVisible();
    } finally {
      await apiDelete(request, `/projects/${created.id}`);
    }
  });

  test("project status filter tab works", async ({ page, request }) => {
    const activeName = tid("pw-proj-active");
    const archivedName = tid("pw-proj-archived");
    const activeProj = await apiPost<Project>(request, "/projects", {
      name: activeName,
      status: "active",
    });
    const archivedProj = await apiPost<Project>(request, "/projects", {
      name: archivedName,
      status: "archived",
    });

    try {
      await gotoView(page, "projects");

      // Click "Active" tab
      await page.getByRole("tab", { name: /^active/i }).click();

      await expect(
        page.locator(`[data-testid="project-row"][data-project-id="${activeProj.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="project-row"][data-project-id="${archivedProj.id}"]`),
      ).toHaveCount(0);

      // Click "Archived" tab
      await page.getByRole("tab", { name: /^archived/i }).click();

      await expect(
        page.locator(`[data-testid="project-row"][data-project-id="${archivedProj.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="project-row"][data-project-id="${activeProj.id}"]`),
      ).toHaveCount(0);
    } finally {
      await apiDelete(request, `/projects/${activeProj.id}`);
      await apiDelete(request, `/projects/${archivedProj.id}`);
    }
  });
});
