import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`activity requests scoped data and task/job details honor project membership at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const first = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("operation-first"),
    });
    const other = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("operation-other"),
    });
    const job = await apiPost<{ id: string; name: string }>(request, "/jobs", {
      name: tid("project-job"),
      command: "echo fixture",
      trigger_type: "manual",
      project_id: first.id,
    });
    const globalJob = await apiPost<{ id: string; name: string }>(request, "/jobs", {
      name: tid("unassigned-job"),
      command: "echo fixture",
      trigger_type: "manual",
    });
    const task = await apiPost<{ id: string; title: string }>(request, "/tasks", {
      title: tid("project-task"),
      project_id: first.id,
    });
    const globalTask = await apiPost<{ id: string; title: string }>(request, "/tasks", {
      title: tid("unassigned-task"),
    });
    const requestScopes = new Map<string, string | null>();
    let secondary: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (["/api/jobs", "/api/tasks", "/api/sessions/live"].includes(url.pathname))
        requestScopes.set(url.pathname, url.searchParams.get("project_id"));
      if (/\/api\/jobs\/[^/]+\/runs|\/api\/tasks\/[^/]+\/(comments|links)/.test(url.pathname))
        secondary.push(url.pathname);
    });
    // Empty capped list pages must not prevent a valid independent detail URL opening.
    await page.route("**/api/jobs?**", (route) => route.fulfill({ json: { jobs: [] } }));
    await page.route("**/api/tasks?**", (route) =>
      route.fulfill({ json: { tasks: [], total: 0 } }),
    );
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({ json: { sessions: [] } }),
    );
    await gotoView(page, "dashboard");
    for (const scope of ["unassigned", first.id]) {
      requestScopes.clear();
      await page.goto(`/dashboard?project=${scope}`);
      for (const resource of ["/api/jobs", "/api/tasks", "/api/sessions/live"])
        await expect.poll(() => requestScopes.get(resource)).toBe(scope);
    }
    for (const resource of [
      {
        path: "jobs",
        assigned: job,
        unassigned: globalJob,
        title: job.name,
        unassignedTitle: globalJob.name,
        sheet: "job-detail-sheet",
      },
      {
        path: "tasks",
        assigned: task,
        unassigned: globalTask,
        title: task.title,
        unassignedTitle: globalTask.title,
        sheet: "task-detail-sheet",
      },
    ]) {
      await page.goto(`/${resource.path}/${resource.assigned.id}?project=${first.id}`);
      await expect(page.getByTestId(resource.sheet)).toContainText(resource.title);
      await expect(page.getByTestId(resource.path === "jobs" ? "job-row" : "task-row")).toHaveCount(
        0,
      );
      for (const scope of [other.id, "unassigned"]) {
        secondary = [];
        await page.goto(`/${resource.path}/${resource.assigned.id}?project=${scope}`);
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === `/${resource.path}` && url.searchParams.get("project") === scope,
        );
        await expect(page.getByTestId(resource.sheet)).toHaveCount(0);
        expect(secondary).toEqual([]);
      }
      await page.goto(`/${resource.path}/${resource.unassigned.id}?project=unassigned`);
      await expect(page.getByTestId(resource.sheet)).toContainText(resource.unassignedTitle);
      await page.goto(`/${resource.path}/${resource.assigned.id}?project=all`);
      await expect(page.getByTestId(resource.sheet)).toContainText(resource.title);
    }
  });
}
