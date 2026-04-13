import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

interface Project {
  id: string;
  name: string;
}

test.describe("Projects CRUD", () => {
  test("create via UI, then delete via UI", async ({ page, request }) => {
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

    // Verify via API
    const { projects } = await apiGet<{ projects: Project[] }>(request, "/projects");
    const created = projects.find((p) => p.name === name);
    expect(created, "API should return created project").toBeTruthy();

    // Delete via UI
    await row.getByTestId("project-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(row).toHaveCount(0);

    // Verify via API
    const { projects: after } = await apiGet<{ projects: Project[] }>(request, "/projects");
    expect(after.find((p) => p.name === name)).toBeUndefined();
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
});
