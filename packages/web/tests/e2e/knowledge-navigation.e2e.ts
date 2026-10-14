import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

test("Knowledge has three canonical destinations and contextual collection management", async ({
  page,
}) => {
  await gotoView(page, "wiki");
  await expect(page.getByTestId("nav-wiki")).toHaveAttribute("href", /\/knowledge\/wiki/);
  await expect(page.getByTestId("section-knowledge")).toHaveAttribute("href", /\/knowledge\/base/);
  await expect(page.getByTestId("nav-memories")).toHaveAttribute("href", /\/knowledge\/memories/);
  await page.getByTestId("section-knowledge").click();
  await expect(page.getByTestId("view-title")).toHaveText("Knowledge base");
  await expect(page.getByTestId("knowledge-documents-tab")).toHaveCount(0);
  await page.getByTestId("knowledge-manage-collections").click();
  expect(new URL(page.url()).searchParams.get("view")).toBe("collections");
  await page.reload();
  await expect(page.getByTestId("add-collection-button")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("knowledge-search-input")).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId("knowledge-back-documents")).toBeVisible();
  await page.getByTestId("knowledge-back-documents").click();
  await page.getByTestId("nav-memories").click();
  expect(new URL(page.url()).pathname).toBe("/knowledge/memories");
  await expect(page.getByTestId("new-memory-button")).toBeVisible();
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
