import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

test("Knowledge bases stay separate from Wiki pages, and legacy note links open the Wiki", async ({
  page,
  request,
}) => {
  const slug = tid("kb-boundary");
  await apiPost(request, "/wiki", {
    project_id: null,
    slug,
    kind: "concept",
    title: "Authored knowledge boundary",
    summary: "Wiki page, not an imported file",
    content: "# Authored page\nSelf-built Wiki content.",
    expected_revision: 0,
    note: "Browser fixture",
  });
  await gotoView(page, "knowledge");
  await expect(page.getByTestId("section-knowledge")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("kb-search-input")).toBeVisible();
  await expect(page.getByTestId("knowledge-notebook")).toHaveCount(0);
  await page.goto(`/knowledge?tab=notebook&page=${slug}&scope=global#authored-page`);
  await expect(page).toHaveURL(/\/knowledge\/wiki\?/);
  expect(new URL(page.url()).searchParams.get("page")).toBe(slug);
  expect(new URL(page.url()).hash).toBe("#authored-page");
  await expect(page.getByTestId("notebook-document")).toContainText("Self-built Wiki content");
  await expect(page.getByTestId("nav-wiki")).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByTestId("notebook-document")).toContainText("Self-built Wiki content");
});

test("Knowledge base search and filters create history entries and reopen", async ({
  page,
  request,
}) => {
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("pw-kb-history"),
    project_id: null,
  });
  await apiPost(request, `/kb/bases/${kb.id}/documents`, {
    title: "Labelled",
    labels: ["history"],
    content: "# Labelled\n\nkbhistoryneedle",
  });
  try {
    await gotoView(page, "knowledge");
    await page.locator(`[data-testid="kb-row"][data-kb-name="${kb.name}"]`).click();
    await page.getByTestId("kb-label-filter").filter({ hasText: "history" }).click();
    await expect(page).toHaveURL(/label=history/);
    await page.getByTestId("kb-search-input").fill("kbhistoryneedle");
    await page.getByTestId("kb-search-submit").click();
    await expect(page.getByTestId("kb-search-result")).toHaveCount(1);
    const searchUrl = page.url();
    await page.getByTestId("nav-memories").click();
    await expect(page).toHaveURL(/\/knowledge\/memories/);
    await page.goBack();
    await expect(page).toHaveURL(searchUrl);
    await expect(page.getByTestId("kb-search-input")).toHaveValue("kbhistoryneedle");
    await page.goBack();
    await expect(page.getByTestId("kb-search-results")).toHaveCount(0);
    await expect(
      page.getByTestId("kb-label-filter").filter({ hasText: "history" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.goto(searchUrl);
    await page.reload();
    await expect(page.getByTestId("kb-search-result")).toContainText("Labelled");
    await page.goto("/knowledge?tab=search");
    await expect(page).toHaveURL(/\/knowledge\/base/);
    await expect(page.getByTestId("section-knowledge")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("kb-search-input")).toBeVisible();
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
  }
});

test("Wiki full-text search, graph, editor mode and page selection are shareable", async ({
  page,
  request,
}) => {
  const slug = tid("wiki-context");
  await apiPost(request, "/wiki", {
    project_id: null,
    slug,
    kind: "lesson",
    title: "Searchable lesson",
    summary: "Contextual Wiki search",
    content: "# Page\nwikibodyonlyneedle evidence.",
    expected_revision: 0,
    note: "Browser fixture",
  });
  await gotoView(page, "wiki");
  await page.getByTestId("wiki-search-input").fill("wikibodyonlyneedle");
  await page.getByTestId("wiki-search-submit").click();
  await expect(page).toHaveURL(/wikiQuery=wikibodyonlyneedle/);
  await page.locator(`[data-testid="notebook-note"][data-slug="${slug}"]`).click();
  await page.getByTestId("notebook-graph-toggle").click();
  await page.getByTestId("markdown-mode-edit").click();
  const shared = page.url();
  await page.reload();
  await expect(page.getByTestId("wiki-editor-content")).toContainText("wikibodyonlyneedle");
  await expect(page.getByTestId("notebook-graph")).toBeVisible();
  await expect(page).toHaveURL(shared);
  await page.getByTestId("wiki-history-toggle").click();
  await expect(page).toHaveURL(/history=1/);
  await page.goBack();
  await expect(page.getByTestId("wiki-editor-content")).toBeVisible();
  await expect(page.getByTestId("notebook-graph")).toBeVisible();
});

test("Projects and Rules tabs restore on Back and reload", async ({ page }) => {
  await gotoView(page, "projects");
  await page.getByRole("tab", { name: "Paused" }).click();
  await expect(page).toHaveURL(/status=paused/);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Paused" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Archived" }).click();
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Paused" })).toHaveAttribute("aria-selected", "true");
  await gotoView(page, "rules");
  await page.getByTestId("rules-settings-tab").click();
  await expect(page).toHaveURL(/tab=settings/);
  await page.reload();
  await expect(page.getByTestId("rules-settings-tab")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByTestId("rules-applied-tab")).toHaveAttribute("aria-selected", "true");
});

test("package import methods and new package tabs reopen without executing an import", async ({
  page,
}) => {
  await gotoView(page, "packages");
  await page.getByTestId("package-import-button").click();
  await page.getByTestId("package-import-zip").click();
  const importUrl = page.url();
  expect(importUrl).toContain("packageAction=import");
  expect(importUrl).toContain("importMethod=zip");
  await page.reload();
  await expect(page.getByTestId("package-zip-input")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("package-import-git")).toHaveAttribute("aria-selected", "true");
});

test("package edit identity and safe tabs copy/reload while Back/Forward retains unsaved source in memory", async ({
  page,
  request,
}) => {
  const name = tid("package-view-draft");
  await apiPost(request, "/agent-packages", {
    name,
    format: "apm",
    content: `name: ${name}\nversion: 1.0.0\ndescription: Original saved description\n`,
    files: [{ path: "guide.md", content: "# Supporting file", encoding: "utf8" }],
  });
  await gotoView(page, "packages");
  await page
    .locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`)
    .getByTestId("package-card-edit")
    .click();
  await expect(page).toHaveURL(new RegExp(`/packages/item/${name}`));
  expect(new URL(page.url()).searchParams.get("packageAction")).toBe("edit");
  await page.getByTestId("package-editor-configuration").click();
  const configurationUrl = page.url();
  await page.reload();
  await expect(page.getByTestId("package-description-input")).toHaveValue(
    "Original saved description",
  );
  await expect(page).toHaveURL(configurationUrl);
  await page
    .getByTestId("package-description-input")
    .fill("Unsaved description retained within this session");
  await page.goBack();
  await expect(page.getByTestId("package-editor-files")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByTestId("package-editor-files")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("package-editor-files")).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByTestId("package-description-input")).toHaveValue(
    "Unsaved description retained within this session",
  );
  const shared = page.url();
  expect(shared).not.toContain("Unsaved");
  expect(shared).not.toContain("description");
  await page.getByTestId("package-submit").click();
  await expect(page.getByTestId("package-edit")).toBeVisible();
  await page.reload();
  await page.getByTestId("package-edit").click();
  await page.getByTestId("package-editor-configuration").click();
  await expect(page.getByTestId("package-description-input")).toHaveValue(
    "Unsaved description retained within this session",
  );
});

test("Back to package type choice cannot overwrite a dirty source without an explicit discard", async ({
  page,
}) => {
  await gotoView(page, "packages");
  await page.getByTestId("new-agent-package-button").click();
  await page.getByTestId("package-type-apm").click();
  await page.getByTestId("package-description-input").fill("Protected unsaved type draft");
  await page.goBack();
  await expect(page.getByTestId("package-type-choice")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByTestId("package-type-agent-plugin").click();
  await expect(page.getByTestId("package-type-choice")).toBeVisible();
  await page.getByTestId("package-type-apm").click();
  await expect(page.getByTestId("package-description-input")).toHaveValue(
    "Protected unsaved type draft",
  );
  await page.goBack();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("package-type-agent-plugin").click();
  await expect(page.getByTestId("package-description-input")).not.toHaveValue(
    "Protected unsaved type draft",
  );
});
