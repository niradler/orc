import { expect, test } from "@playwright/test";
import { API_SECRET, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`should manage memories under Knowledge and preserve old links at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const marker = tid("knowledge-memory");
    const memory = await apiPost<{ id: string }>(request, "/memories", {
      content: marker,
      type: "fact",
      importance: "normal",
    });
    await gotoView(page, "memories");
    await expect(page.getByTestId("view-title")).toHaveText("Knowledge");
    await expect(page.getByTestId("section-title")).toHaveText("Memories");
    await expect(page.getByTestId("nav-memories")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-memories-tab")).toHaveAttribute(
      "data-state",
      "active",
    );
    await page.reload();
    await expect(page.getByTestId("knowledge-memories-tab")).toHaveAttribute(
      "data-state",
      "active",
    );
    const row = page.locator(`[data-testid="memory-row"][data-memory-id="${memory.id}"]`);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/knowledge/memories/${memory.id}`));
    await page.reload();
    await expect(page.getByTestId("edit-memory-dialog")).toBeVisible();
    await page.getByTestId("edit-memory-content-input").fill(`${marker} updated`);
    await page.getByTestId("edit-memory-submit").click();
    await expect(row).toContainText(`${marker} updated`);
    await page.getByTestId("knowledge-collections-tab").click();
    await expect(page.getByTestId("knowledge-collections-tab")).toHaveAttribute(
      "data-state",
      "active",
    );
    await page.getByTestId("knowledge-memories-tab").click();
    await expect(row).toBeVisible();
    await page.addInitScript(
      (secret) => localStorage.setItem("orc_api_secret", secret),
      API_SECRET,
    );
    await page.goto(`/memories/${memory.id}?origin=wiki`);
    await expect(page).toHaveURL(
      new RegExp(`/knowledge/memories/${memory.id}\\?origin=wiki&tab=memories`),
    );
    await expect(page.getByTestId("edit-memory-dialog")).toBeVisible();
    await page.getByTestId("edit-memory-submit").click();
    await page.goto("/memories?origin=dashboard");
    await expect(page).toHaveURL(/\/knowledge\?origin=dashboard&tab=memories/);
    await expect(row).toBeVisible();
    const overflow = await page.getByTestId("knowledge-memories-tab").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left < 0 || bounds.right > window.innerWidth;
    });
    expect(overflow).toBe(false);
    await page.screenshot({ path: `../../output/playwright/knowledge-memories-${width}.png` });
  });
}
