import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { chooseChatModel, closeChatHistory, openChatHistory, settingsSection } from "./_chat-ui";
import { API_SECRET, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

test.afterEach(async ({ request }) => {
  await request.patch("/api/settings", {
    headers: AUTH_HEADERS,
    data: { terminal_font: "", chat: ChatSettingsSchema.parse({}) },
  });
});

test("discarding a phone task draft clears it and restores the create action", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await gotoView(page, "tasks");
  const opener = page.getByTestId("new-task-button");
  await opener.click();
  await page.getByTestId("task-title-input").fill("Discard this task draft");
  await page.getByTestId("task-body-input").fill("Draft acceptance criteria");
  await page.getByTestId("form-cancel").click();
  await expect(page.getByTestId("keep-editing")).toBeFocused();
  await page.getByTestId("keep-editing").click();
  await expect(page.getByTestId("task-title-input")).toHaveValue("Discard this task draft");
  await page.getByTestId("form-cancel").click();
  await page.getByTestId("discard-form-changes").click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByTestId("task-title-input")).toHaveValue("");
  await expect(page.getByTestId("task-body-input")).toHaveValue("");
});

test("Back and reload protect an active form until changes are explicitly discarded", async ({
  page,
}) => {
  await gotoView(page, "activity");
  await page.getByTestId("nav-jobs").click();
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-name-input").fill("Draft protected from navigation");
  await page.getByTestId("job-command-input").fill("echo navigation draft");
  await page.goBack();
  await expect(page.getByTestId("keep-editing")).toBeVisible();
  await page.getByTestId("keep-editing").click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await expect(page.getByTestId("job-name-input")).toHaveValue("Draft protected from navigation");

  const prompt = page.waitForEvent("dialog");
  const reload = page.evaluate(() => window.location.reload());
  const warning = await prompt;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss();
  await reload;
  await expect(page.getByTestId("job-command-input")).toHaveValue("echo navigation draft");

  await page.goBack();
  await page.getByTestId("discard-form-changes").click();
  await expect(page).toHaveURL(/\/activity(?:\?|$)/);
  await expect(page.getByTestId("form-dialog")).toHaveCount(0);
});

for (const width of [390, 320]) {
  test(`phone skill rows stay compact and keep named visibility and open actions at ${width}px`, async ({
    page,
    request,
  }) => {
    const name = tid("phone-skill");
    await apiPost(request, "/skills", {
      name,
      content: `---\nname: ${name}\ndescription: Compact skill fixture\n---\n\nReview the selected change.`,
    });
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "skills");
    await page.getByTestId("skill-search-input").fill(name);
    const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBeLessThanOrEqual(104);
    const visibility = row.getByTestId(`skill-visibility-${name}`);
    const target = await visibility.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/skills/settings/visibility") &&
        response.request().method() === "PUT",
    );
    await visibility.click();
    expect((await saved).ok()).toBe(true);
    await expect(visibility).toHaveAttribute("aria-checked", "false");
    await page.reload();
    await expect(visibility).toHaveAttribute("aria-checked", "false");
    await visibility.click();
    await expect(visibility).toHaveAttribute("aria-checked", "true");
    await row.getByTestId("skill-open").click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Review the selected change.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test(`phone task actions update the correct task and keep a compact row at ${width}px`, async ({
    page,
    request,
  }) => {
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("phone-actions"),
    });
    const task = await apiPost<{ id: string }>(request, "/tasks", {
      title: "Review phone error recovery",
      project_id: project.id,
      status: "todo",
      priority: "normal",
    });
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "tasks");
    await page.goto(`/tasks?project=${project.id}&view=table`);
    const row = page.locator(`[data-testid="task-row"][data-task-id="${task.id}"]`);
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBeLessThanOrEqual(104);
    await row.getByTestId("task-actions-button").click();
    await page.getByTestId("task-row-status").click();
    await page.getByRole("option", { name: "doing", exact: true }).click();
    await page.getByTestId("task-row-priority").click();
    await page.getByRole("option", { name: "high", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const saved = await apiGet<{ status: string; priority: string }>(
          request,
          `/tasks/${task.id}`,
        );
        return { status: saved.status, priority: saved.priority };
      })
      .toEqual({ status: "doing", priority: "high" });
    await page.reload();
    await expect(row).toContainText("Doing");
    await expect(row).toContainText("High");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test(`phone project edits preserve Keep, discard explicitly and save without a second prompt at ${width}px`, async ({
    page,
    request,
  }) => {
    const name = tid("phone-project-draft");
    const project = await apiPost<{ id: string }>(request, "/projects", { name });
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "projects");
    const row = page.locator(`[data-testid="project-row"][data-project-id="${project.id}"]`);
    await row.getByTestId("project-open").click();
    const field = page.getByTestId("edit-project-name-input");
    await field.fill(`${name}-draft`);
    await expect(page.getByTestId("edit-project-submit")).toBeInViewport();
    await page.keyboard.press("Escape");
    await page.getByTestId("keep-editing").click();
    await expect(field).toHaveValue(`${name}-draft`);
    await page.keyboard.press("Escape");
    await page.getByTestId("discard-form-changes").click();
    await row.getByTestId("project-open").click();
    await expect(field).toHaveValue(name);
    await field.fill(`${name}-saved`);
    await page.getByTestId("edit-project-submit").click();
    await expect(page.getByTestId("edit-project-dialog")).toHaveCount(0);
    await expect(page.getByTestId("discard-form-changes")).toHaveCount(0);
    await page.reload();
    await row.getByTestId("project-open").click();
    await expect(field).toHaveValue(`${name}-saved`);
  });
}

for (const width of [1440, 390]) {
  test(`job form keeps actions reachable and protects a draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "jobs");
    const opener = page.getByTestId("new-job-button");
    await opener.click();
    const form = page.getByTestId("form-dialog");
    const submit = page.getByTestId("job-submit");
    await expect(submit).toBeInViewport();
    const bounds = await form.boundingBox();
    if (width === 1440) expect(bounds?.width).toBeGreaterThan(800);
    else expect(bounds?.width).toBe(width);
    await page.getByTestId("job-name-input").fill("Draft job");
    await page.getByTestId("job-command-input").fill("echo draft");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("keep-editing")).toBeFocused();
    await page.getByTestId("keep-editing").click();
    await expect(page.getByTestId("job-name-input")).toHaveValue("Draft job");
    await page.setViewportSize({ width: 320, height: 580 });
    await expect(page.getByTestId("job-command-input")).toHaveValue("echo draft");
    await expect(submit).toBeInViewport();
    await page.keyboard.press("Escape");
    await page.getByTestId("discard-form-changes").click();
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(page.getByTestId("job-name-input")).toHaveValue("");
    await expect(page.getByTestId("job-command-input")).toHaveValue("");
  });

  test(`settings retain section drafts and save only the owning section at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "settings");
    const originalAddress = await page.evaluate(() => localStorage.getItem("orc_api_url"));
    await page.getByTestId("settings-api-url").fill("/api/pending-draft");
    await settingsSection(page, "terminals");
    await page.locator("#settings-terminal-font").fill("Draft Mono");
    await settingsSection(page, "connection");
    await expect(page.getByTestId("settings-api-url")).toHaveValue("/api/pending-draft");
    await page.getByTestId("settings-api-url").fill("/api");
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("status")).toContainText("Connection saved");
    expect(
      (await apiGet<{ terminal_font?: string }>(request, "/settings")).terminal_font ?? "",
    ).toBe("");
    await page.getByTestId("settings-api-url").fill("/api/another-draft");
    await settingsSection(page, "terminals");
    await expect(page.locator("#settings-terminal-font")).toHaveValue("Draft Mono");
    await page.getByTestId("settings-terminal-save").click();
    await expect(page.getByRole("status")).toContainText("Terminal font saved");
    expect((await apiGet<{ terminal_font?: string }>(request, "/settings")).terminal_font).toBe(
      "Draft Mono",
    );
    expect(await page.evaluate(() => localStorage.getItem("orc_api_url"))).toBe(
      originalAddress ?? "/api",
    );
    await settingsSection(page, "connection");
    await expect(page.getByTestId("settings-api-url")).toHaveValue("/api/another-draft");
    await page.reload();
    await expect(page.getByTestId("settings-api-url")).toHaveValue("/api");
  });

  test(`session history retains a closed conversation draft and model at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.patch("/api/settings", {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: {
        chat: ChatSettingsSchema.parse({ models: [{ agent: "codex", id: "retained-model" }] }),
      },
    });
    await page.route("**/api/chat/models?**", (route) =>
      route.fulfill({ json: { models: [], warning: null } }),
    );
    await page.setViewportSize({ width, height: 844 });
    await gotoView(page, "tasks");
    await page.goto("/tasks?chat=full");
    if (width === 1440) await expect(page.getByTestId("chat-session-sidebar")).toBeVisible();
    const marker = tid("history-draft");
    await chooseChatModel(page, "retained-model");
    await page.getByTestId("chat-input").fill(`Reply with exactly: ${marker}.`);
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-message-content").last()).toContainText(marker);
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    await page.getByTestId("chat-input").fill("Keep my unsent follow-up");
    const messageColumn = await page
      .locator('[data-testid="chat-message"][data-role="assistant"]')
      .last()
      .getByTestId("chat-message-content")
      .boundingBox();
    const composerColumn = await page.getByTestId("chat-composer-box").boundingBox();
    expect(Math.abs((messageColumn?.x ?? 0) - (composerColumn?.x ?? 0))).toBeLessThan(2);
    expect(Math.abs((messageColumn?.width ?? 0) - (composerColumn?.width ?? 0))).toBeLessThan(2);
    if (width < 1280) await expect(page.getByTestId("chat-fullscreen-button")).toBeHidden();
    const agent = await page.getByTestId("chat-agent-button").boundingBox();
    const model = await page.getByTestId("chat-model-button").boundingBox();
    const input = await page.getByTestId("chat-input").boundingBox();
    expect(agent?.y).toBeGreaterThan(input?.y ?? 0);
    expect(model?.y).toBeGreaterThan(input?.y ?? 0);
    await page.getByTestId("chat-clear-button").click();
    await openChatHistory(page);
    await page.getByTestId("chat-session-search").fill(marker);
    await expect(
      page.getByTestId("chat-session-list").getByTestId("chat-session-select"),
    ).toHaveCount(1);
    await page.getByTestId("chat-session-list").getByTestId("chat-tab-close").click();
    await expect(
      page.getByTestId("chat-session-list").getByTestId("chat-session-select"),
    ).toBeVisible();
    await page.getByTestId("chat-session-list").getByTestId("chat-session-select").click();
    await closeChatHistory(page);
    await expect(page.getByTestId("chat-input")).toHaveValue("Keep my unsent follow-up");
    await expect(page.getByTestId("chat-model-button")).toHaveText("retained-model");
    await expect(page.getByTestId("chat-message-content").last()).toContainText(marker);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
