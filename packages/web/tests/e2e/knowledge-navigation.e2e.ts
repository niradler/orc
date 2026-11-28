import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

test("Knowledge has two canonical destinations and knowledge-base state is shareable", async ({
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
    await gotoView(page, "memories");
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
    // A search across every knowledge base is a shareable link.
    await page.goto("/knowledge/base?q=kbnavigationneedle&searchAll=1");
    await expect(page.getByTestId("kb-search-result").first()).toContainText("Navigation target");
    await page.getByTestId("nav-memories").click();
    expect(new URL(page.url()).pathname).toBe("/knowledge/memories");
    await expect(page.getByTestId("new-memory-button")).toBeVisible();
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
  }
});

test("choosing a knowledge base shows its documents and marks the selection", async ({
  page,
  request,
}) => {
  const bases = await Promise.all(
    ["first", "second"].map(async (which) => {
      const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
        name: tid(`pw-kb-tree-${which}`),
        project_id: null,
      });
      await apiPost(request, `/kb/bases/${kb.id}/documents`, {
        title: `Tree ${which}`,
        content: `# Tree ${which}`,
      });
      return kb;
    }),
  );
  const [first, second] = bases;
  const docRow = (title: string) =>
    page.locator(`[data-testid="kb-document-row"][data-document-title="${title}"]`);
  const kbRow = (name: string) => page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`);
  try {
    // A knowledge base opened by link lists its documents on the home pane without another click.
    await gotoView(page, "knowledge");
    await page.goto(`/knowledge/base?kb=${first.id}`);
    await expect(kbRow(first.name)).toHaveAttribute("aria-current", "page");
    await expect(docRow("Tree first")).toBeVisible();

    await kbRow(second.name).click();
    await expect(docRow("Tree second")).toBeVisible();
    await expect(docRow("Tree first")).toHaveCount(0);
    await expect(kbRow(first.name)).not.toHaveAttribute("aria-current", "page");
    await expect(kbRow(second.name)).toHaveAttribute("aria-current", "page");

    // Opening a document keeps its knowledge base selected in the rail.
    await docRow("Tree second").click();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Tree second");
    await expect(kbRow(second.name)).toHaveAttribute("aria-current", "page");
  } finally {
    await Promise.all(bases.map((kb) => apiDelete(request, `/kb/bases/${kb.id}`)));
  }
});
