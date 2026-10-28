import { expect, test } from "@playwright/test";
import { API_SECRET, apiGet, apiPost, gotoView, tid } from "./_helpers";

for (const width of [390, 1440]) {
  test(`package deletion can cancel, detects stale data and persists at ${width}px`, async ({
    page,
    request,
  }) => {
    const name = tid("delete-package");
    await apiPost(request, "/agent-packages", {
      name,
      content: `name: ${name}\nversion: 1.0.0\n`,
      files: [],
    });
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "packages");
    const card = page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`);
    await card.getByTestId("package-actions-menu").click();
    await page.getByTestId("package-card-delete").click();
    const dialog = page.getByTestId("package-delete-dialog");
    await expect(dialog).toContainText(name);
    await page.getByTestId("package-delete-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toBeVisible();

    await card.getByTestId("package-inspect").click();
    await page.getByTestId("package-detail-delete").click();
    await expect(dialog).toBeVisible();
    const current = await apiGet<{ revision: string }>(request, `/agent-packages/${name}`);
    const changed = await request.put(`/api/agent-packages/${name}`, {
      headers: { Authorization: `Bearer ${API_SECRET}` },
      data: {
        expectedRevision: current.revision,
        content: `name: ${name}\nversion: 2.0.0\n`,
        files: [],
      },
    });
    expect(changed.ok()).toBe(true);
    await page.getByTestId("package-delete-confirm").click();
    await expect(page.getByTestId("package-delete-error")).toContainText("changed");
    await expect(card).toHaveCount(1);
    await page.getByTestId("package-delete-cancel").click();
    await expect(page.getByTestId("package-detail-sheet")).toBeVisible();
    await page.getByTestId("package-detail-delete").click();
    await expect(page.getByTestId("package-delete-error")).toHaveCount(0);
    await page.getByTestId("package-delete-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("package-detail-sheet")).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(card).toHaveCount(0);
    expect(
      (
        await request.get(`/api/agent-packages/${name}`, {
          headers: { Authorization: `Bearer ${API_SECRET}` },
        })
      ).status(),
    ).toBe(404);
  });
}
