import { expect, test } from "@playwright/test";
import { captureState } from "./_capture-state";
import { openFinalFormStep } from "./_form-ui";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

const markdown =
  "# Verification checklist\n\n- Preserve **drafts**\n- Check keyboard focus\n\nA concise fact 😀";

for (const width of [1440, 390, 320]) {
  test(`memory Markdown fills the content step and preserves native validation and saved source ${width}`, async ({
    page,
    request,
  }, info) => {
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("markdown-memory"),
    });
    const name = tid("markdown-fact");
    await page.addInitScript(
      (theme) => localStorage.setItem("orc_theme", theme),
      width === 320 ? "light" : "dark",
    );
    await page.setViewportSize({ width, height: width < 640 ? 650 : 900 });
    await gotoView(page, "memories");
    await page.goto(`/knowledge/memories?project=${project.id}`);
    await expect(page.getByTestId("new-memory-button")).toBeVisible();
    const desiredTheme = width === 320 ? "light" : "dark";
    if ((await page.locator("html").getAttribute("data-theme")) !== desiredTheme)
      await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", desiredTheme);
    await page.getByTestId("new-memory-button").click();
    const dialog = page.getByTestId("memory-form-dialog");
    await dialog.getByTestId("memory-name-input").fill(name);
    await dialog.getByTestId("memory-description-input").fill("Markdown form regression");
    await openFinalFormStep(page);
    const source = dialog.getByTestId("memory-content-input");
    await source.fill(markdown);
    const geometry = await source.evaluate((element) => {
      const body = element.closest(".work-form-body");
      if (!body) throw new Error("Missing form body");
      const field = element.getBoundingClientRect(),
        bounds = body.getBoundingClientRect();
      return {
        height: field.height,
        available: bounds.height,
        bottom: field.bottom,
        bodyBottom: bounds.bottom - Number.parseFloat(getComputedStyle(body).paddingBottom),
      };
    });
    expect(geometry.height).toBeGreaterThan(geometry.available * 0.65);
    expect(Math.abs(geometry.bottom - geometry.bodyBottom)).toBeLessThan(3);
    await captureState(page, {
      path: info.outputPath(`memory-markdown-source-${width}.png`),
      animations: "disabled",
    });
    await dialog.getByTestId("memory-content-input-preview").click();
    const preview = dialog.getByTestId("memory-content-input-rendered");
    await expect(preview.getByRole("heading", { name: "Verification checklist" })).toBeVisible();
    const emphasis = preview.locator('[data-streamdown="strong"]');
    await expect(emphasis).toHaveText("drafts");
    expect(
      await emphasis.evaluate((element) => Number(getComputedStyle(element).fontWeight)),
    ).toBeGreaterThanOrEqual(600);
    await expect(source).toHaveValue(markdown);
    await expect(dialog.getByTestId("memory-content-count")).toContainText(
      String([...markdown].length),
    );
    await dialog.getByTestId("form-step-details").click();
    await openFinalFormStep(page);
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("keep-editing").click();
    await expect(preview.getByRole("heading", { name: "Verification checklist" })).toBeVisible();
    await dialog.getByTestId("memory-content-input-edit").click();
    await source.fill("");
    await dialog.getByTestId("memory-content-input-preview").click();
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/memories")
        writes.push(request.url());
    });
    await dialog.getByTestId("memory-submit").click();
    await expect(source).toBeVisible();
    await expect(source).toBeFocused();
    expect(writes).toEqual([]);
    await source.fill(markdown);
    await dialog.getByTestId("memory-content-input-preview").click();
    await captureState(page, {
      path: info.outputPath(`memory-markdown-${width}.png`),
      animations: "disabled",
    });
    await dialog.getByTestId("memory-submit").click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByTestId("memory-detail-content")
        .getByRole("heading", { name: "Verification checklist" }),
    ).toBeVisible();
    const saved = await apiGet<{ content: string }>(
      request,
      `/memories/${name}?project_id=${project.id}`,
    );
    expect(saved.content).toBe(markdown);
    expect(writes).toHaveLength(1);
    await page.getByTestId("memory-edit").click();
    await openFinalFormStep(page);
    await expect(page.getByTestId("memory-content-input")).toHaveValue(markdown);
  });
}

test("Task body and job task instructions preview Markdown without changing their source", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "tasks");
  await page.getByTestId("new-task-button").click();
  await page.getByTestId("task-title-input").fill(tid("markdown-task"));
  await page.getByTestId("task-body-input").fill(markdown);
  await page.getByTestId("task-body-input-preview").click();
  await expect(
    page
      .getByTestId("task-body-input-rendered")
      .getByRole("heading", { name: "Verification checklist" }),
  ).toBeVisible();
  await captureState(page, {
    path: info.outputPath("task-markdown-preview.png"),
    animations: "disabled",
  });
  await openFinalFormStep(page);
  await page.getByTestId("task-submit").click();
  const detail = page.getByTestId("task-detail-sheet");
  await expect(detail).toBeVisible();
  const createdTaskId = new URL(page.url()).pathname.split("/").at(-1);
  if (!createdTaskId || createdTaskId === "tasks")
    throw new Error("Missing created task detail route");
  await expect(
    detail.getByTestId("task-detail-body").getByRole("heading", { name: "Verification checklist" }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "Edit task", exact: true }).click();
  const edit = page.getByTestId("edit-task-dialog");
  const changed = `${markdown}\n\n## Confirmed result`;
  await edit.getByTestId("edit-task-body").fill(changed);
  await edit.getByTestId("edit-task-body-preview").click();
  await expect(
    edit.getByTestId("edit-task-body-rendered").getByRole("heading", { name: "Confirmed result" }),
  ).toBeVisible();
  await edit.getByTestId("edit-task-submit").click();
  await expect(edit).toHaveCount(0);
  await expect(
    detail.getByTestId("task-detail-body").getByRole("heading", { name: "Confirmed result" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await gotoView(page, "jobs");
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("form-step-execution").click();
  await page.getByTestId("job-action-type").selectOption("task");
  await page.getByTestId("job-task-body").fill(markdown);
  await page.getByTestId("job-task-body-preview").click();
  await expect(
    page
      .getByTestId("job-task-body-rendered")
      .getByRole("heading", { name: "Verification checklist" }),
  ).toBeVisible();
  await page.getByTestId("form-step-details").click();
  await page.getByTestId("form-step-execution").click();
  await expect(page.getByTestId("job-task-body")).toHaveValue(markdown);
  const savedTask = await apiGet<{ body: string }>(request, `/tasks/${createdTaskId}`);
  expect(savedTask.body).toBe(changed);
});

test("Skill Markdown retains Read Edit Split and saved draft behavior with compact controls", async ({
  page,
}, info) => {
  const name = tid("markdown-skill");
  const content = `---\nname: ${name}\ndescription: Markdown editor regression\n---\n${markdown}`;
  await gotoView(page, "skills");
  await page.getByTestId("new-skill-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("skill-name-input").fill(name);
  await dialog.getByTestId("skill-content-input").fill(content);
  await captureState(page, {
    path: info.outputPath("skill-markdown-edit.png"),
    animations: "disabled",
  });
  await dialog.getByTestId("markdown-mode-read").click();
  await expect(
    dialog.getByTestId("markdown-preview").getByRole("heading", { name: "Verification checklist" }),
  ).toBeVisible();
  await captureState(page, {
    path: info.outputPath("skill-markdown-read.png"),
    animations: "disabled",
  });
  await dialog.getByTestId("markdown-mode-split").click();
  await expect(dialog.getByTestId("skill-content-input")).toBeVisible();
  await expect(dialog.getByTestId("markdown-preview")).toBeVisible();
  await captureState(page, {
    path: info.outputPath("skill-markdown-split.png"),
    animations: "disabled",
  });
  await dialog.getByTestId("skill-submit").click();
  const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
  await row.click();
  await page.getByTestId("markdown-mode-edit").click();
  await page.getByTestId("skill-file-content").fill(`${content}\n\n## Saved edit`);
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await page.reload();
  await page.getByTestId("markdown-mode-read").click();
  await expect(
    page.getByTestId("markdown-preview").getByRole("heading", { name: "Saved edit" }),
  ).toBeVisible();
});
