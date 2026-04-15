import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

interface Project {
  id: string;
}
interface Task {
  id: string;
}

/**
 * Regression guard: the sidebar "All Projects" scope must NOT filter jobs or
 * memories out (it was literally sending `project_id=all`). This test scopes
 * to a project, verifies only that project's task shows, scopes back to
 * "All Projects", verifies the unscoped task becomes visible again.
 */
test.describe("Sidebar project scope", () => {
  test("scoping tasks view to a project filters; All Projects unscopes", async ({
    page,
    request,
  }) => {
    const projectName = tid("pw-scope-proj");
    const project = await apiPost<Project>(request, "/projects", {
      name: projectName,
      status: "active",
    });

    const scopedTitle = tid("pw-scope-in");
    const unscopedTitle = tid("pw-scope-out");
    const scoped = await apiPost<Task>(request, "/tasks", {
      title: scopedTitle,
      status: "todo",
      priority: "normal",
      project_id: project.id,
    });
    const unscoped = await apiPost<Task>(request, "/tasks", {
      title: unscopedTitle,
      status: "todo",
      priority: "normal",
    });

    try {
      await gotoView(page, "tasks");
      await page.getByTestId("tasks-view-table").click();

      // Default is "all" - both tasks should be reachable
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${scoped.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${unscoped.id}"]`),
      ).toBeVisible();

      // Scope to the project
      await page.getByTestId("sidebar-project-select").selectOption(project.id);

      // Scoped task still there, unscoped task no longer there
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${scoped.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${unscoped.id}"]`),
      ).toHaveCount(0);

      // Back to All Projects - both visible again
      await page.getByTestId("sidebar-project-select").selectOption("all");
      await expect(
        page.locator(`[data-testid="task-row"][data-task-id="${unscoped.id}"]`),
      ).toBeVisible();
    } finally {
      await apiDelete(request, `/tasks/${scoped.id}`);
      await apiDelete(request, `/tasks/${unscoped.id}`);
      await apiDelete(request, `/projects/${project.id}`);
    }
  });
});
