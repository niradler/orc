import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, selectProject, tid } from "./_helpers";

test("session review saves a lesson that normal search and reopened wiki history can reuse", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: tid("wiki-project"),
  });
  const memory = await apiPost<{ id: string }>(request, "/memories", {
    project_id: project.id,
    content: "wikie2eneedle failed replacements must leave memory and audit unchanged",
    tags: ["transactions", "outcome:verified"],
    importance: "high",
  });
  const slug = tid("verified-rollback");
  const entry = {
    project_id: project.id,
    slug,
    kind: "procedure",
    title: "Verified rollback lesson",
    summary: "Keep a failed replacement atomic",
    content:
      "# Verified rollback\nBoth memory content and its audit rows must remain unchanged after a rejected supersession.",
    sources: [`memory:${memory.id}`],
    author: "codex",
    session_id: "wiki-browser-session",
    note: "Observed rollback behavior",
    expected_revision: 0,
  };
  await apiPost(request, "/wiki", entry);
  await apiPost(request, "/wiki", {
    ...entry,
    content: `${entry.content}\n\nReopen the stored result before reporting success.`,
    expected_revision: 1,
    note: "Added reopen check",
  });
  const search = await apiPost<{ result: string }>(request, "/mcp/tool", {
    name: "search",
    args: { query: "rollback", project: project.name, resources: ["wiki", "memories"] },
  });
  expect(search.result).toContain(entry.summary);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await gotoView(page, "dashboard");
  await selectProject(page, project.id);
  await page.getByTestId("nav-knowledge").click();
  await expect(page.getByTestId("nav-wiki")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("wiki-history-toggle").click();
  await expect(page.getByTestId("wiki-change").first()).toContainText("Added reopen check");
  await page.getByTestId("wiki-change").first().click();
  await expect(page.getByTestId("wiki-page-content")).toContainText("Reopen the stored result");
  await page.reload();
  await expect(page.getByTestId("wiki-page-content")).toContainText("Reopen the stored result");
  await expect(page.getByTestId("wiki-revision")).toHaveCount(2);
  await page.getByTestId("wiki-revision").last().locator("summary").click();
  await expect(page.getByTestId("wiki-revision").last()).toContainText("Both memory content");
  await page.screenshot({ path: "../../.claude/wiki-learning-browser.png", fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByTestId("wiki-history-toggle").click();
  await page.getByTestId("wiki-search-input").fill("rollback");
  await page.getByTestId("wiki-search-submit").click();
  await expect(page.getByTestId("wiki-page-row")).toContainText(entry.summary);
  await page.getByTestId("wiki-history-toggle").click();
  await page.getByTestId("wiki-technical-audit").locator("summary").first().click();
  await expect(page.getByTestId("wiki-audit-entry").first()).toContainText("wiki.updated");
  expect(errors).toEqual([]);
});

test("edited skill instructions and supporting files reopen and a human can revert with history", async ({
  page,
  request,
}) => {
  const name = tid("wiki-skill");
  const baseline = `---\nname: ${name}\ndescription: Verified reusable procedure\n---\nOriginal procedure.`;
  await apiPost(request, "/skills", {
    name,
    content: baseline,
    files: [{ path: "references/guide.md", content: "Authored guide stays intact" }],
  });
  const edited = `${baseline}\n\nCheck rollback and reopen before reporting success.`;
  const update = await request.put(`${API_BASE}/skills/${name}/instructions`, {
    headers: AUTH_HEADERS,
    data: {
      project_id: null,
      content: edited,
      expected_content: baseline,
      author: "codex",
      reason: "Verified session learning",
      wiki_pages: [],
    },
  });
  expect(update.ok()).toBe(true);
  await gotoView(page, "skills");
  await page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`).click();
  await expect(page.getByTestId("skill-mutated-label")).toContainText("codex");
  await expect(page.getByTestId("skill-file-content")).toContainText("Check rollback");
  await page.reload();
  await expect(page.getByTestId("skill-file-content")).toContainText("Check rollback");
  await page.locator('[data-testid="skill-file"][data-file-name="references/guide.md"]').click();
  await expect(page.getByTestId("skill-file-content")).toContainText("Authored guide stays intact");
  await page.getByTestId("skill-show-entry").click();
  await page.getByTestId("skill-revert-reason").fill("Prefer the original procedure after review");
  await page.getByTestId("skill-history-change").first().locator("summary").click();
  await page.getByTestId("skill-revert-change").first().click();
  await expect
    .poll(
      async () =>
        (await apiGet<{ content: string }>(request, `/skills/${name}?ref=SKILL.md`)).content,
    )
    .toBe(baseline);
  await page.reload();
  await expect(page.getByTestId("skill-file-content")).toContainText("Original procedure");
  await expect(page.getByTestId("skill-file-content")).not.toContainText("Check rollback");
  await expect(page.getByTestId("skill-history-change")).toHaveCount(2);
  await page.getByTestId("markdown-mode-edit").click();
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("skill-file-content")).toBeVisible();
  await page.getByTestId("skill-file-content").click();
  await page.getByTestId("skill-file-content").press("Control+End");
  await page.keyboard.insertText("\n\nManual refinement after review.");
  await expect(page.getByTestId("skill-file-content")).toContainText(
    "Manual refinement after review.",
  );
  await expect(page.getByTestId("document-save")).toBeEnabled();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/skills/${name}/instructions`) &&
      response.request().method() === "PUT",
  );
  await page.getByTestId("document-save").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("skill-history-change")).toHaveCount(3);
  await expect(page.getByTestId("skill-history-change").first()).toContainText("human");
  await page.reload();
  await expect(page.getByTestId("skill-file-content")).toContainText("Manual refinement");
  expect(
    (await apiGet<{ content: string }>(request, `/skills/${name}?ref=references/guide.md`)).content,
  ).toBe("Authored guide stays intact");
});

test("Wiki history self-links retain dirty drafts and conflict discard adopts current revision", async ({
  page,
  request,
}) => {
  const slug = tid("history-self");
  const base = {
    project_id: null,
    slug,
    title: "History self link",
    kind: "concept",
    summary: "Conflict recovery",
    note: "Browser validation",
  };
  await apiPost(request, "/wiki", {
    ...base,
    content: `# Original\n[[${slug}]]`,
    expected_revision: 0,
  });
  await gotoView(page, "wiki");
  await page.goto(`/knowledge/wiki?history=1&historyPage=${slug}&page=${slug}&scope=global`);
  await page.getByTestId("markdown-mode-split").click();
  await page.getByTestId("wiki-editor-content").fill(`# Dirty draft\n[[${slug}]]`);
  let dialogs = 0;
  const rejectUnexpected = async (dialog: import("@playwright/test").Dialog) => {
    dialogs++;
    await dialog.dismiss();
  };
  page.on("dialog", rejectUnexpected);
  await page.getByTestId(`wiki-link-${slug}`).click();
  expect(dialogs).toBe(0);
  await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
  page.off("dialog", rejectUnexpected);
  await apiPost(request, "/wiki", {
    ...base,
    content: "# External revision",
    expected_revision: 1,
  });
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-workspace").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("Dirty draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("document-discard").click();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("External revision");
  await page.getByTestId("wiki-editor-content").fill("# Recovered history edit");
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("Recovered history edit");
});
