import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`should open memories under Knowledge and keep detail links at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("knowledge-memory-project"),
    });
    const name = tid("knowledge-memory").toLowerCase();
    try {
      await apiPost(request, "/memories", {
        project_id: project.id,
        name,
        description: "Knowledge navigation memory",
        content: `${name} content`,
      });
      await gotoView(page, "memories");
      await expect(page.getByTestId("view-title")).toHaveText("Memories");
      await expect(page.getByTestId("nav-memories")).toHaveAttribute("aria-current", "page");
      await page.goto(`/knowledge/memories?project=${project.id}`);
      await page.reload();
      await expect(page.getByTestId("nav-memories")).toHaveAttribute("aria-current", "page");
      const row = page.locator(`[data-testid="memory-row"][data-memory-name="${name}"]`);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/knowledge/memories/${project.id}/${name}`));
      await page.reload();
      await expect(page.getByTestId("memory-detail-content")).toHaveText(`${name} content`);
      // Test the panel's Escape behavior, rather than dismissing its Close tooltip.
      await page.getByTestId("memory-edit").focus();
      await expect(page.getByTestId("action-help-content")).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("memory-detail")).toHaveCount(0);

      await page.getByTestId("section-knowledge").click();
      // On a phone the knowledge base list and search sit behind Browse.
      if (width < 1024) await page.getByRole("button", { name: "Browse", exact: true }).click();
      await expect(page.getByTestId("kb-search-input")).toBeVisible();
      if (width < 1024) await page.keyboard.press("Escape");
      await page.getByTestId("nav-memories").click();
      await expect(row).toBeVisible();

      await page.goto(`/knowledge/memories?project=${project.id}`);
      await expect(row).toBeVisible();
      const overflow = await page.getByTestId("nav-memories").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < 0 || bounds.right > window.innerWidth;
      });
      expect(overflow).toBe(false);
      await page.screenshot({ path: `../../output/playwright/knowledge-memories-${width}.png` });
    } finally {
      await apiDelete(request, `/projects/${project.id}`);
    }
  });
}
