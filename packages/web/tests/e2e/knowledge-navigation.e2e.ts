import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

test("Knowledge has three canonical destinations and knowledge-base state is shareable", async ({
  page,
  request,
}) => {
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("pw-kb-nav"),
    project_id: null,
  });
  const doc = await apiPost<{ id: string }>(request, `/kb/bases/${kb.id}/documents`, {
    title: "Navigation target",
    content: "# Navigation target\n\nkbnavigationneedle",
  });
  try {
    await gotoView(page, "wiki");
    await expect(page.getByTestId("nav-wiki")).toHaveAttribute("href", /\/knowledge\/wiki/);
    await expect(page.getByTestId("section-knowledge")).toHaveAttribute(
      "href",
      /\/knowledge\/base/,
    );
    await expect(page.getByTestId("nav-memories")).toHaveAttribute("href", /\/knowledge\/memories/);
    await page.getByTestId("section-knowledge").click();
    await expect(page.getByTestId("view-title")).toHaveText("Knowledge bases");
    await page.locator(`[data-testid="kb-row"][data-kb-name="${kb.name}"]`).click();
    await expect(page).toHaveURL(new RegExp(`kb=${kb.id}`));
    await page
      .locator('[data-testid="kb-document-row"][data-document-title="Navigation target"]')
      .click();
    await expect(page).toHaveURL(new RegExp(`document=${doc.id}`));
    await page.reload();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Navigation target");
    await page.goBack();
    await expect(page.getByTestId("kb-overview-name")).toHaveText(kb.name);
    await page.goForward();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Navigation target");
    // Old Knowledge search links land on the new search.
    await page.goto("/knowledge?tab=search&documentQuery=kbnavigationneedle");
    await expect(page).toHaveURL(/\/knowledge\/base\?.*q=kbnavigationneedle/);
    await expect(page.getByTestId("kb-search-result").first()).toContainText("Navigation target");
    await page.getByTestId("nav-memories").click();
    expect(new URL(page.url()).pathname).toBe("/knowledge/memories");
    await expect(page.getByTestId("new-memory-button")).toBeVisible();
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
  }
});

test("Wiki History is secondary, shareable and opens the already selected page", async ({
  page,
  request,
}) => {
  const slug = tid("history-navigation");
  await apiPost(request, "/wiki", {
    project_id: null,
    slug,
    kind: "lesson",
    title: "History navigation",
    summary: "Secondary page history",
    content: "# A lesson",
    note: "Recorded from review",
    expected_revision: 0,
  });
  await gotoView(page, "wiki");
  await page.goto(`/knowledge/wiki?project=all&page=${slug}&scope=global#section`);
  await expect(page.getByTestId("markdown-preview")).toContainText("A lesson");
  await page.getByTestId("wiki-history-toggle").click();
  await expect(page.getByTestId("wiki-history-feed")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#section");
  await expect(page.getByTestId("sheet-close")).toBeHidden();
  await page.getByTestId("wiki-change").filter({ hasText: "History navigation" }).first().click();
  await expect(page.getByTestId("wiki-page-content")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("historyPage")).toBe(slug);
  await page.reload();
  await expect(page.getByTestId("wiki-page-content")).toBeVisible();
  await page.getByTestId("sheet-close").click();
  await expect(page.getByTestId("sheet-close")).toBeHidden();
  await page.getByTestId("wiki-technical-audit").locator("summary").first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("audit")).toBe("1");
  await page.reload();
  await expect(page.getByTestId("wiki-technical-audit")).toHaveAttribute("open", "");
  await page.getByTestId("wiki-history-toggle").click();
  await expect(page.getByTestId("knowledge-notebook")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("wiki-history-feed")).toBeVisible();
});

test("legacy Wiki audit page URLs retain their exact page and audit subview", async ({
  page,
  request,
}) => {
  const slug = tid("legacy-history");
  await apiPost(request, "/wiki", {
    project_id: null,
    slug,
    kind: "concept",
    title: "Legacy history",
    summary: "A preserved deep link",
    content: "# Legacy history",
    note: "Initial revision",
    expected_revision: 0,
  });
  await gotoView(page, "wiki");
  await page.goto(`/wiki?project=all&tab=audit&page=${slug}&scope=global#legacy`);
  await expect(page.getByTestId("wiki-page-content")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/knowledge/wiki");
  expect(new URL(page.url()).hash).toBe("#legacy");
  await page.getByTestId("sheet-close").click();
  await expect(page.getByTestId("wiki-technical-audit")).toHaveAttribute("open", "");
});
