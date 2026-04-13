import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

interface Project {
  id: string;
}
interface Task {
  id: string;
}

test.describe("Dashboard", () => {
  test("stats reflect API state and stat cards navigate", async ({ page, request }) => {
    // Seed a task so the stats have a deterministic "todo" increment.
    const title = tid("pw-dash");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await gotoView(page, "dashboard");
      await expect(page.getByTestId("view-title")).toHaveText(/dashboard/i);

      // Stat cards are present
      const todoCard = page.locator(`[data-testid="stat-card"][data-stat-label="Todo"]`);
      const projectsCard = page.locator(`[data-testid="stat-card"][data-stat-label="Projects"]`);
      const memoriesCard = page.locator(`[data-testid="stat-card"][data-stat-label="Memories"]`);
      const activeJobsCard = page.locator(
        `[data-testid="stat-card"][data-stat-label="Active Jobs"]`,
      );

      await expect(todoCard).toBeVisible();
      await expect(projectsCard).toBeVisible();
      await expect(memoriesCard).toBeVisible();
      await expect(activeJobsCard).toBeVisible();

      // Todo count should be >= 1 (we seeded one)
      const todoValue = todoCard.getByTestId("stat-card-value");
      await expect(todoValue).toBeVisible();
      const raw = (await todoValue.textContent())?.trim() ?? "0";
      expect(Number(raw)).toBeGreaterThanOrEqual(1);

      // Clicking the Projects stat card navigates to the projects view.
      await projectsCard.click();
      await expect(page.getByTestId("view-title")).toHaveText(/projects/i);
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("project scope is reflected in dashboard meta", async ({ page, request }) => {
    const name = tid("pw-dash-proj");
    const project = await apiPost<Project>(request, "/projects", {
      name,
      status: "active",
    });
    try {
      await gotoView(page, "dashboard");
      await page.getByTestId("sidebar-project-select").selectOption(project.id);
      // meta shows project name when scoped to a specific project
      await expect(page.getByTestId("view-meta")).toContainText(name);
      // back to All Projects
      await page.getByTestId("sidebar-project-select").selectOption("all");
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });
});
