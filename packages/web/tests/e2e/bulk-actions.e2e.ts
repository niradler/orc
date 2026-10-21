import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

test("should create jobs disabled, toggle inline and retry failed bulk updates without touching unselected jobs", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", { name: tid("bulk-jobs") });
  const other = await apiPost<{ id: string }>(request, "/jobs", {
    name: tid("unselected-job"),
    command: "echo other",
    trigger_type: "manual",
  });
  const first = await apiPost<{ id: string }>(request, "/jobs", {
    name: tid("bulk-first"),
    command: "echo first",
    trigger_type: "manual",
    project_id: project.id,
  });
  const second = await apiPost<{ id: string }>(request, "/jobs", {
    name: tid("bulk-second"),
    command: "echo second",
    trigger_type: "manual",
    project_id: project.id,
  });
  await gotoView(page, "jobs");
  await page.goto(`/jobs?project=${project.id}`);
  const firstRow = page.locator(`[data-testid="job-row"][data-job-id="${first.id}"]`);
  const secondRow = page.locator(`[data-testid="job-row"][data-job-id="${second.id}"]`);
  await expect(firstRow.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "false");
  await firstRow.getByTestId("job-toggle-enabled").click();
  await expect(firstRow.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("job-detail-sheet")).not.toBeVisible();
  await firstRow.getByTestId("job-toggle-enabled").click();
  await expect(firstRow.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("select-all-rows").check();
  await expect(page.getByTestId("bulk-actions")).toContainText("2 selected");
  await page.screenshot({
    path: resolve("../../.claude/docs/jobs-bulk-desktop.png"),
    fullPage: true,
  });
  await page.route(`**/api/jobs/${second.id}`, async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary update failure" }),
      });
    else await route.continue();
  });
  await page.getByTestId("jobs-bulk-enable").click();
  await expect(page.getByTestId("jobs-bulk-result")).toContainText("Temporary update failure");
  await expect(firstRow.getByTestId("job-select")).not.toBeChecked();
  await expect(secondRow.getByTestId("job-select")).toBeChecked();
  await page.unroute(`**/api/jobs/${second.id}`);
  await page.getByTestId("jobs-bulk-enable").click();
  await expect(secondRow.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("select-all-rows").check();
  await page.getByTestId("jobs-bulk-disable").click();
  await expect(firstRow.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "false");
  await expect(secondRow.getByTestId("job-toggle-enabled")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect((await apiGet<{ enabled: boolean }>(request, `/jobs/${other.id}`)).enabled).toBe(false);
  await firstRow.getByTestId("job-select").check();
  await page.goto("/jobs?project=all");
  await expect(page.getByTestId("jobs-bulk-enable")).toHaveCount(0);
  await page.goto(`/jobs?project=${project.id}`);
  await expect(page.getByTestId("jobs-bulk-enable")).toHaveCount(0);
  await page.goto("/jobs?project=all");
  const name = tid("new-disabled-job");
  await page.getByTestId("new-job-button").click();
  await expect(page.getByTestId("job-create-enabled")).not.toBeChecked();
  await page.getByTestId("job-name-input").fill(name);
  await page.getByTestId("job-command-input").fill("echo new");
  await page.getByTestId("job-submit").click();
  const row = page.locator(`[data-testid="job-row"][data-job-name="${name}"]`);
  await expect(row.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByTestId("job-toggle-enabled").click();
  await expect(row.getByTestId("job-toggle-enabled")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: resolve("../../.claude/docs/jobs-toggle-mobile.png"),
    fullPage: true,
  });
});

test("should share selection controls with Projects and limit bulk status changes to displayed selections", async ({
  page,
  request,
}) => {
  const first = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("bulk-project-first"),
  });
  const second = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("bulk-project-second"),
  });
  const paused = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("bulk-project-paused"),
    status: "paused",
  });
  await gotoView(page, "projects");
  const row = (id: string) => page.locator(`[data-testid="project-row"][data-project-id="${id}"]`);
  await row(first.id).getByTestId("project-select").check();
  await row(second.id).getByTestId("project-select").check();
  await expect(page.getByTestId("bulk-actions")).toContainText("2 selected");
  await page.screenshot({
    path: resolve("../../.claude/docs/projects-bulk-desktop.png"),
    fullPage: true,
  });
  await expect(page.getByTestId("project-edit-dialog")).not.toBeVisible();
  await page.getByTestId("projects-bulk-paused").click();
  await expect(page.getByTestId("projects-bulk-result")).toContainText("2 projects set to paused");
  await page.getByTestId("projects-filter-paused").click();
  await page.getByTestId("select-all-rows").check();
  await page.getByTestId("projects-bulk-archived").click();
  await expect(row(first.id)).toHaveCount(0);
  await expect(row(second.id)).toHaveCount(0);
  await expect(row(paused.id)).toHaveCount(0);
  expect((await apiGet<{ status: string }>(request, `/projects/${first.id}`)).status).toBe(
    "archived",
  );
  await page.getByTestId("projects-filter-all").click();
  await row(first.id).getByTestId("project-select").check();
  await page.getByTestId("projects-filter-active").click();
  await expect(page.getByTestId("projects-bulk-archived")).toHaveCount(0);
  await page.getByTestId("projects-filter-all").click();
  await expect(page.getByTestId("projects-bulk-archived")).toHaveCount(0);
});
