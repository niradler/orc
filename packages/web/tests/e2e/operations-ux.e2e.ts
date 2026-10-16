import { expect, test } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, gotoView, selectProject, tid } from "./_helpers";

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`operations workflows ${theme} ${width}`, async ({ page, request }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.request.patch("/api/settings", {
        headers: { Authorization: `Bearer ${API_SECRET}` },
        data: { theme },
      });
      await page.addInitScript(
        ({ secret, theme }) => {
          localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
          localStorage.setItem("orc_theme", theme);
        },
        { secret: API_SECRET, theme },
      );
      const project = await apiPost<{ id: string }>(request, "/projects", {
        name: tid("operations"),
      });
      const task = await apiPost<{ id: string }>(request, "/tasks", {
        title: tid("focused-task"),
        project_id: project.id,
        status: "todo",
      });
      const other = await apiPost<{ id: string }>(request, "/tasks", {
        title: tid("excluded-task"),
        project_id: project.id,
        status: "todo",
      });
      const job = await apiPost<{ id: string; name: string }>(request, "/jobs", {
        name: tid("editable-job"),
        project_id: project.id,
        description: "Clear me",
        command: "echo operations",
        trigger_type: "manual",
        max_retries: 3,
      });
      await apiPost(request, "/memories", {
        project_id: project.id,
        content: tid("scoped-memory"),
        type: "fact",
      });
      await gotoView(page, "dashboard");
      await selectProject(page, project.id);
      await expect(page.getByTestId("view-title")).toHaveText("Activity");
      await expect(
        page.locator('[data-stat-label="Active jobs"] [data-testid="stat-card-value"]'),
      ).toHaveText("1");
      await expect(
        page.locator('[data-stat-label="Memories"] [data-testid="stat-card-value"]'),
      ).toHaveText("1");
      await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
      await page.goto(`/tasks?project=${project.id}`);
      const title = (await apiGet<{ title: string }>(request, `/tasks/${task.id}`)).title;
      await page.getByLabel("Search tasks", { exact: true }).fill(title);
      await expect(
        page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="kanban-card"][data-task-id="${other.id}"]`),
      ).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("tasks.png"), fullPage: true });
      await page.getByTestId("tasks-view-table").click();
      await expect(page).toHaveURL(/view=table/);
      await page.goBack();
      await expect(page.getByTestId("tasks-view-board")).toHaveAttribute("aria-pressed", "true");
      await page.goForward();
      await expect(page.getByTestId("tasks-view-table")).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await expect(page.getByRole("tab", { selected: true })).toContainText("All");
      await page.goto(`/jobs?project=${project.id}`);
      const row = page.locator(`[data-testid="job-row"][data-job-id="${job.id}"]`);
      await row.getByTestId("job-edit").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Description", { exact: true }).fill("");
      await dialog.getByLabel("Maximum retries", { exact: true }).fill("0");
      await dialog.getByLabel("Command", { exact: true }).fill("echo changed operations");
      await page.screenshot({ path: testInfo.outputPath("job-edit.png"), fullPage: true });
      await dialog.getByTestId("job-edit-submit").click();
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await row.getByRole("button", { name: job.name, exact: true }).click();
      await expect(page.getByTestId("job-detail-sheet")).toContainText("echo changed operations");
      const saved = await apiGet<{ description: string; max_retries: number }>(
        request,
        `/jobs/${job.id}`,
      );
      expect(saved.max_retries).toBe(0);
      expect(saved.description).toBe("");
      await page.screenshot({ path: testInfo.outputPath("jobs.png"), fullPage: true });
      await page.getByTestId("sheet-close").click();
      await page.goto("/sessions");
      await selectProject(page, "all");
      await page.getByTestId("nav-audit").click();
      await expect(page).toHaveURL(/\/audit/);
      await page.goBack();
      await expect(page.getByTestId("nav-sessions")).toHaveAttribute("aria-current", "page");
      await page.goForward();
      await expect(page.getByTestId("nav-audit")).toHaveAttribute("aria-current", "page");
      await page.reload();
      await expect(page.getByTestId("logged-sessions")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("sessions.png"), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByTestId("nav-sessions").click();
      await page.route("**/api/sessions/live?*", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session service unavailable" }),
        }),
      );
      await page.reload();
      await expect(page.getByTestId("live-sessions")).toContainText("Session service unavailable");
    });
  }
}

test("an Audit detail URL reopens directly", async ({ page, request }) => {
  const agent = tid("direct-session");
  const { result } = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "session_log",
    args: { agent, summary: "Direct session detail" },
  });
  await gotoView(page, "sessions");
  await page.goto(`/audit/${result.replace("Session logged: ", "").trim()}`);
  await expect(page.getByTestId("nav-audit")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("dialog")).toContainText(agent);
  await page.getByTestId("sheet-close").click();
  await page.getByTestId("nav-sessions").click();
  await expect(page.getByTestId("live-sessions")).toBeVisible();
});

test("overview drilldowns preserve shared project scope independently of the saved picker", async ({
  page,
  request,
}) => {
  const saved = await apiPost<{ id: string }>(request, "/projects", { name: tid("saved-scope") });
  const shared = await apiPost<{ id: string }>(request, "/projects", { name: tid("shared-scope") });
  await apiPost(request, "/tasks", {
    title: tid("shared-doing"),
    status: "doing",
    project_id: shared.id,
  });
  await gotoView(page, "dashboard");
  await selectProject(page, saved.id);
  await page.goto(`/dashboard?project=${shared.id}`);
  await expect(
    page.locator('[data-stat-label="Doing"] [data-testid="stat-card-value"]'),
  ).toHaveText("1");
  await page.locator('[data-stat-label="Doing"]').click();
  await expect(page).toHaveURL(new RegExp(`project=${shared.id}`));
  await expect(page).toHaveURL(/status=doing/);
  await page.reload();
  await expect(page.getByTestId("task-row")).toHaveCount(1);
});

for (const view of ["tasks", "jobs", "sessions", "dashboard"] as const) {
  test(`${view} distinguishes loading, empty results and request failures`, async ({
    page,
  }, testInfo) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failing = false;
    const endpoint = view === "dashboard" ? "tasks" : view === "sessions" ? "sessions/live" : view;
    const pattern = new RegExp(`/api/${endpoint}(?:[?].*)?$`);
    await page.route(pattern, async (route) => {
      await gate;
      await route.fulfill({
        status: failing ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failing
            ? { error: `${view} temporarily unavailable` }
            : { [view === "sessions" ? "sessions" : endpoint]: [] },
        ),
      });
    });
    await gotoView(page, view);
    if (view === "tasks") await page.getByTestId("tasks-view-table").click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: /Loading/ })
        .or(page.getByRole("status", { name: /Loading/ }))
        .first(),
    ).toBeVisible();
    release();
    const emptyText =
      view === "tasks" || view === "dashboard"
        ? "No tasks"
        : view === "jobs"
          ? "No jobs configured"
          : "No active agent sessions. Enable Show ended to browse previous conversations.";
    await expect(page.getByText(emptyText, { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${view}-empty.png`), fullPage: true });
    failing = true;
    await page.reload();
    await expect(
      page.getByText(`${view} temporarily unavailable`, { exact: view !== "dashboard" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${view}-error.png`), fullPage: true });
    failing = false;
    await page.getByRole("button", { name: /retry/i }).first().click();
    await expect(page.getByText(emptyText, { exact: true }).first()).toBeVisible();
  });
}
