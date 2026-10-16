import { expect, test } from "@playwright/test";
import { API_SECRET, apiPost, gotoView, selectProject, tid } from "./_helpers";

test("themes persist, grouped navigation works, and the mobile project shortcut opens one dialog", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("workspace-sidebar").locator("nav > button")).toHaveCount(6);
  await page.getByTestId("theme-toggle").click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("nav-activity").click();
  await page.getByTestId("nav-sessions").click();
  await expect(page).toHaveURL(/\/sessions/);
  await page.getByTestId("nav-library").click();
  await page.getByTestId("nav-rules").click();
  await expect(page).toHaveURL(/\/rules/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-magicui-theme-vt", "active");
  await page.evaluate(() =>
    Object.defineProperty(document, "startViewTransition", {
      value: undefined,
      configurable: true,
    }),
  );
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId("mobile-nav-open").click();
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("project-name-input")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test("notebook links and graph use real notes and edits reopen after theme changes", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", { name: tid("notebook") });
  const from = tid("flow"),
    to = tid("backend");
  const write = (slug: string, content: string) =>
    apiPost(request, "/wiki", {
      project_id: project.id,
      slug,
      title: slug,
      kind: "concept",
      summary: "Connected project knowledge",
      content,
      expected_revision: 0,
      note: "Browser fixture",
    });
  await write(from, `# Task flows\n\nRead [[${to}]] for agent details.`);
  await write(to, "# Agent backends\n\nOriginal content.");
  await gotoView(page, "wiki");
  await selectProject(page, project.id);
  await page.locator(`[data-testid="notebook-note"][data-slug="${from}"]`).click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Task flows");
  await page.getByTestId(`wiki-link-${to}`).click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Agent backends");
  await page.getByTestId("notebook-links-toggle").click();
  await expect(page.locator("#notebook-links")).toContainText(from);
  await page.getByTestId("notebook-graph-toggle").click();
  await expect(page.getByTestId("notebook-graph").locator("svg")).toBeVisible();
  await page.getByTestId("notebook-graph-toggle").click();
  await page.getByTestId("notebook-links-toggle").click();
  await page.getByTestId("markdown-mode-edit").click();
  await page
    .getByTestId("wiki-editor-content")
    .fill("# Agent backends\n\nSaved and reopened notebook content.");
  await page.getByTestId("theme-toggle").click();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("Saved and reopened");
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText(
    "Saved and reopened notebook content",
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId("notebook-files-toggle").click();
    await expect(page.getByTestId("notebook-files")).toBeVisible();
    await page
      .locator(`[data-testid="notebook-files"] [data-testid="notebook-note"][data-slug="${from}"]`)
      .click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Task flows");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test("Codex chat streams and keeps history while switching between desktop and mobile", async ({
  page,
}) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto("/tasks");
  await page.getByTestId("chat-open-button").click();
  await expect(page.getByTestId("chat-agent-select")).toHaveValue("codex");
  const marker = tid("chat-continuity");
  await page.getByTestId("chat-input").fill(`Reply with exactly: ${marker}.`);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toContainText(
    marker,
  );
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("chat-open-button").click();
  await expect(page.getByTestId("mobile-chat-sheet")).toContainText(marker);
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("chat-open-button").click();
  await expect(page.getByTestId("chat-messages")).toContainText(marker);
});

test("mobile project creation opens its first task without a covering navigation drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "tasks");
  await page.getByTestId("mobile-nav-open").click();
  await page.getByTestId("mobile-nav-drawer").getByTestId("sidebar-project-select").click();
  await page.getByTestId("project-picker-create").click();
  await page.getByTestId("project-name-input").fill(tid("mobile-project"));
  await page.getByTestId("project-submit").click();
  await page.getByTestId("task-title-input").fill("First task in a mobile project");
  await page.getByTestId("task-submit").click();
  await expect(page.getByTestId("mobile-nav-drawer")).not.toBeVisible();
  await expect(page.getByTestId("task-detail-sheet")).toContainText(
    "First task in a mobile project",
  );
});

test("a conflicting notebook save keeps its draft and explicit discard adopts the latest revision", async ({
  page,
  request,
}) => {
  const slug = tid("conflict");
  const baseline = {
    project_id: null,
    slug,
    title: "Conflict recovery",
    kind: "concept",
    summary: "Recovery fixture",
    note: "Validation",
  };
  await apiPost(request, "/wiki", {
    ...baseline,
    content: "# Original note",
    expected_revision: 0,
  });
  await gotoView(page, "wiki");
  await page.locator(`[data-testid="notebook-note"][data-slug="${slug}"]`).click();
  await page.getByTestId("markdown-mode-edit").click();
  await page.getByTestId("wiki-editor-content").fill("# My unsaved draft");
  let sameNoteDialogs = 0;
  const unexpectedDiscard = async (dialog: import("@playwright/test").Dialog) => {
    sameNoteDialogs++;
    await dialog.dismiss();
  };
  page.on("dialog", unexpectedDiscard);
  await page.locator(`[data-testid="notebook-note"][data-slug="${slug}"]`).click();
  expect(sameNoteDialogs).toBe(0);
  await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
  page.off("dialog", unexpectedDiscard);
  await apiPost(request, "/wiki", {
    ...baseline,
    content: "# New external revision",
    expected_revision: 1,
  });
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-workspace").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("My unsaved draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("document-discard").click();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("New external revision");
  await page.getByTestId("wiki-editor-content").fill("# Recovered and saved");
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Recovered and saved");
});
