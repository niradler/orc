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
