import { expect, test } from "@playwright/test";
import { API_SECRET, apiDelete, apiPatch, apiPost, gotoView, selectProject, tid } from "./_helpers";

test("themes persist, grouped navigation works, and the mobile project shortcut opens one dialog", async ({
  page,
}) => {
  // The theme is a server setting, so earlier specs may have left it light.
  await page.request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { theme: "dark" },
  });
  await gotoView(page, "tasks");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("workspace-sidebar").locator("nav > button")).toHaveCount(6);
  // Reloading before the server save lands would load the old theme back.
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
  );
  await page.getByTestId("theme-toggle").click();
  expect((await saved).status()).toBe(200);
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

test("knowledge base document links use real documents and edits reopen after theme changes", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", { name: tid("kb-links") });
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("pw-kb-redesign"),
    project_id: project.id,
  });
  const from = tid("flow"),
    to = tid("backend");
  const write = (title: string, content: string) =>
    apiPost(request, `/kb/bases/${kb.id}/documents`, { title, content });
  try {
    await write(from, `# Task flows\n\nRead [[${to}]] for agent details.`);
    await write(to, "# Agent backends\n\nOriginal content.");
    await gotoView(page, "knowledge");
    await selectProject(page, project.id);
    await page.locator(`[data-testid="kb-row"][data-kb-name="${kb.name}"]`).click();
    await page.locator(`[data-testid="kb-document-row"][data-document-title="${from}"]`).click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Task flows");
    await page.getByTestId(`wiki-link-${to}`).click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Agent backends");
    await expect(page.getByTestId("kb-backlink")).toContainText(from);
    await page.getByTestId("markdown-mode-edit").click();
    await page
      .getByTestId("kb-document-content")
      .fill("# Agent backends\n\nSaved and reopened document content.");
    await page.getByTestId("theme-toggle").click();
    await expect(page.getByTestId("kb-document-content")).toContainText("Saved and reopened");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("markdown-mode-read").click();
    await expect(page.getByTestId("markdown-preview")).toContainText(
      "Saved and reopened document content",
    );
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page
        .getByTestId("knowledge-bases")
        .getByRole("button", { name: "Files", exact: true })
        .click();
      await expect(page.getByTestId("kb-documents")).toBeVisible();
      await page.locator(`[data-testid="kb-document-row"][data-document-title="${from}"]`).click();
      await expect(page.getByTestId("markdown-preview")).toContainText("Task flows");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
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

test("a conflicting knowledge base document save keeps its draft and explicit discard adopts the latest revision", async ({
  page,
  request,
}) => {
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("pw-kb-conflict-recovery"),
    project_id: null,
  });
  const title = tid("conflict");
  const row = page.locator(`[data-testid="kb-document-row"][data-document-title="${title}"]`);
  try {
    const doc = await apiPost<{ id: string; revision: number }>(
      request,
      `/kb/bases/${kb.id}/documents`,
      { title, content: "# Original note" },
    );
    await gotoView(page, "knowledge");
    await page.locator(`[data-testid="kb-row"][data-kb-name="${kb.name}"]`).click();
    await row.click();
    await page.getByTestId("markdown-mode-edit").click();
    await page.getByTestId("kb-document-content").fill("# My unsaved draft");
    let sameNoteDialogs = 0;
    const unexpectedDiscard = async (dialog: import("@playwright/test").Dialog) => {
      sameNoteDialogs++;
      await dialog.dismiss();
    };
    page.on("dialog", unexpectedDiscard);
    await row.click();
    expect(sameNoteDialogs).toBe(0);
    await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
    page.off("dialog", unexpectedDiscard);
    await apiPatch(request, `/kb/documents/${doc.id}`, {
      expected_revision: doc.revision,
      content: "# New external revision",
    });
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-workspace").getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("kb-document-content")).toContainText("My unsaved draft");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("document-discard").click();
    await expect(page.getByTestId("kb-document-content")).toContainText("New external revision");
    await page.getByTestId("kb-document-content").fill("# Recovered and saved");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("markdown-mode-read").click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Recovered and saved");
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
  }
});
