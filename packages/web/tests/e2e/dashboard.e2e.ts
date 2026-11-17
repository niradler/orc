import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, selectProject, tid } from "./_helpers";

interface Project {
  id: string;
}
interface Task {
  id: string;
}

test.describe("Dashboard", () => {
  test("leads with usage charts and sessions, then lists the newest task", async ({
    page,
    request,
  }) => {
    const title = tid("pw-dash");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await gotoView(page, "activity");
      await expect(page.getByTestId("view-title")).toHaveText(/activity/i);
      await expect(page.getByTestId("activity-chart")).toBeVisible();
      await expect(page.getByTestId("stat-card")).toHaveCount(0);
      const sessions = page.getByRole("heading", { name: "Sessions", exact: true });
      const tasks = page.getByRole("heading", { name: "Recent tasks" });
      const sessionsBox = await sessions.boundingBox();
      const tasksBox = await tasks.boundingBox();
      expect(sessionsBox?.y ?? 0).toBeLessThan(tasksBox?.y ?? 0);
      await page.getByRole("button", { name: title }).first().click();
      await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}`));
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
      await gotoView(page, "activity");
      await selectProject(page, project.id);
      // meta shows project name when scoped to a specific project
      await expect(page.getByTestId("view-meta")).toContainText(name);
      // back to All Projects
      await selectProject(page, "all");
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });
});
