import { expect, type Locator, type Page, test } from "@playwright/test";
import { apiGet, gotoView, tid } from "./_helpers";

async function footerFits(page: Page, dialog: Locator, width: number) {
  const bounds = await dialog.locator(".work-form-footer").boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Missing form footer");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
  if (width < 640) expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(843);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await dialog.locator(".work-form-footer button:visible").all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error("Missing footer button");
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    if (width < 640) expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

function countFormWrites(page: Page, resource: string) {
  const counts = { posts: 0, patches: 0 };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === `/api/${resource}`) counts.posts += 1;
    if (request.method() === "PATCH" && path.startsWith(`/api/${resource}/`)) counts.patches += 1;
  });
  return counts;
}

for (const width of [1440, 390, 320]) {
  test(`job steps preserve drafts, validate hidden fields and save create/edit ${width}`, async ({
    page,
    request,
  }, info) => {
    const writes = countFormWrites(page, "jobs");
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "jobs");
    await page.getByTestId("new-job-button").click();
    const dialog = page.getByTestId("form-dialog");
    await expect(dialog.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("job-submit")).toHaveCount(0);
    await footerFits(page, dialog, width);
    // Direct tab navigation is allowed, but final validation must reveal the first invalid field.
    await page.getByTestId("form-step-automation").click();
    await page.getByTestId("job-submit").click();
    await expect(page.getByTestId("job-name-input")).toBeFocused();
    const name = tid("step-job");
    await page.getByTestId("job-name-input").fill(name);
    await page.getByTestId("form-step-automation").click();
    await page.getByTestId("job-submit").click();
    await expect(page.getByTestId("job-command-input")).toBeFocused();
    await page.getByTestId("job-command-input").fill("echo step-draft");
    await dialog.getByLabel("Timeout in seconds").fill("0");
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(dialog.getByLabel("Timeout in seconds")).toBeFocused();
    await dialog.getByLabel("Timeout in seconds").fill("321");
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("job-create-enabled")).not.toBeChecked();
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("job-command-input")).toHaveValue("echo step-draft");
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("job-name-input")).toHaveValue(name);
    await page.getByTestId("form-step-automation").click();
    await footerFits(page, dialog, width);
    await page.screenshot({ path: info.outputPath("job-automation.png") });
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await page.getByTestId("job-submit").click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual({ posts: 1, patches: 0 });
    const { jobs } = await apiGet<{
      jobs: Array<{ id: string; name: string; enabled: boolean; timeout_secs: number }>;
    }>(request, "/jobs");
    const saved = jobs.find((job) => job.name === name);
    if (!saved) throw new Error("Created job is absent");
    expect(saved.enabled).toBe(false);
    expect(saved.timeout_secs).toBe(321);
    const row = page.locator(`[data-testid="job-row"][data-job-id="${saved.id}"]`);
    await row.getByTestId("job-edit").click();
    await page.getByTestId("form-step-execution").click();
    await page.getByTestId("job-command-input").fill("echo edited-step");
    await page.getByTestId("form-step-automation").click();
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await expect(page.getByTestId("job-command-input")).toHaveValue("echo edited-step");
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await footerFits(page, dialog, width);
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await page.getByTestId("job-edit-submit").click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual({ posts: 1, patches: 1 });
    expect(
      (await apiGet<{ action: { command: string } }>(request, `/jobs/${saved.id}`)).action.command,
    ).toBe("echo edited-step");
  });

  test(`project steps retain configuration and create/edit across tabs ${width}`, async ({
    page,
    request,
  }, info) => {
    const writes = countFormWrites(page, "projects");
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "projects");
    await page.getByTestId("new-project-button").click();
    const dialog = page.getByTestId("form-dialog");
    await page.getByTestId("form-step-configuration").click();
    await page.getByTestId("project-submit").click();
    await expect(page.getByTestId("project-name-input")).toBeFocused();
    const name = tid("step-project");
    await page.getByTestId("project-name-input").fill(name);
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await page.getByTestId("project-first-task").uncheck();
    await page.getByTestId("project-git-remote-url").fill("https://github.com/acme/steps.git");
    await dialog.getByLabel("Max Workers").fill("0");
    await page.getByTestId("project-submit").click();
    await expect(dialog.getByLabel("Max Workers")).toBeFocused();
    await dialog.getByLabel("Max Workers").fill("2");
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("project-name-input")).toHaveValue(name);
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("project-git-remote-url")).toHaveValue(
      "https://github.com/acme/steps.git",
    );
    await footerFits(page, dialog, width);
    await page.screenshot({ path: info.outputPath("project-configuration.png") });
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await page.getByTestId("project-submit").click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual({ posts: 1, patches: 0 });
    const row = page.locator(`[data-testid="project-row"][data-project-name="${name}"]`);
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-project-id");
    await (width < 1280
      ? row.getByTestId("project-open")
      : row.getByRole("button", { name: `Edit project: ${name}`, exact: true })
    ).click();
    const edit = page.getByTestId("edit-project-dialog");
    await expect(page.getByTestId("edit-project-name-input")).toHaveValue(name);
    await page.getByTestId("form-step-configuration").click();
    await page.getByTestId("edit-project-git-remote-url").fill("git@github.com:acme/edited.git");
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await expect(page.getByTestId("edit-project-git-remote-url")).toHaveValue(
      "git@github.com:acme/edited.git",
    );
    await footerFits(page, edit, width);
    expect(writes).toEqual({ posts: 1, patches: 0 });
    await page.getByTestId("edit-project-submit").click();
    await expect(edit).toHaveCount(0);
    expect(writes).toEqual({ posts: 1, patches: 1 });
    expect(
      (await apiGet<{ git_remote_url: string; max_workers: number }>(request, `/projects/${id}`))
        .git_remote_url,
    ).toBe("git@github.com:acme/edited.git");
    await (width < 1280
      ? row.getByTestId("project-open")
      : row.getByRole("button", { name: `Edit project: ${name}`, exact: true })
    ).click();
    await page.getByTestId("form-step-configuration").click();
    await expect(page.getByTestId("edit-project-git-remote-url")).toHaveValue(
      "git@github.com:acme/edited.git",
    );
  });

  test(`task steps retain draft and save without a runnable execution setup ${width}`, async ({
    page,
    request,
  }, info) => {
    const writes = countFormWrites(page, "tasks");
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "tasks");
    await page.getByTestId("new-task-button").click();
    const dialog = page.getByTestId("form-dialog");
    await page.getByTestId("form-step-advanced").click();
    await page.getByTestId("task-submit").click();
    await expect(page.getByTestId("task-title-input")).toBeFocused();
    const title = tid("step-task");
    await page.getByTestId("task-title-input").fill(title);
    await page.getByTestId("task-body-input").fill("Acceptance checks survive step navigation.");
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await dialog.getByLabel("Skill override", { exact: true }).fill("step-skill");
    await page.getByTestId("form-step-next").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await dialog.getByLabel("Tags", { exact: true }).fill("step, draft");
    await dialog.getByLabel("Author", { exact: true }).fill("human");
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(dialog.getByLabel("Skill override", { exact: true })).toHaveValue("step-skill");
    await page.getByTestId("form-step-back").click();
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await expect(page.getByTestId("task-title-input")).toHaveValue(title);
    await expect(page.getByTestId("task-body-input")).toHaveValue(
      "Acceptance checks survive step navigation.",
    );
    await page.getByTestId("form-step-advanced").click();
    await expect(dialog.getByLabel("Tags", { exact: true })).toHaveValue("step, draft");
    await expect(page.getByTestId("task-start-readiness")).toBeVisible();
    await footerFits(page, dialog, width);
    await page.screenshot({ path: info.outputPath("task-advanced.png") });
    expect(writes).toEqual({ posts: 0, patches: 0 });
    await page.getByTestId("task-submit").click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual({ posts: 1, patches: 0 });
    const { tasks } = await apiGet<{
      tasks: Array<{ title: string; tags: string[]; skill_name: string }>;
    }>(request, "/tasks");
    const saved = tasks.find((task) => task.title === title);
    if (!saved) throw new Error("Created task is absent");
    expect(saved.tags).toEqual(["step", "draft"]);
    expect(saved.skill_name).toBe("step-skill");
  });
}
