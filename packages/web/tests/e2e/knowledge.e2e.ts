import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

/** Navigate to the Knowledge view and switch to the Collections tab. */
async function gotoCollections(page: Parameters<typeof gotoView>[0]): Promise<void> {
  await gotoView(page, "knowledge");
  await expect(page.getByTestId("view-title")).toHaveText(/knowledge/i);
  await page.getByTestId("knowledge-collections-tab").click();
}

test.describe("Knowledge Collections", () => {
  test("collection seeded via API appears in collections tab", async ({ page, request }) => {
    const name = tid("pw-coll");
    // Use the OS tmp dir as a path that's guaranteed to exist; pattern matches nothing
    // but the collection record is still created.
    const created = await apiPost<{ name: string; indexed: number }>(
      request,
      "/knowledge/collections",
      { name, path: tmpdir(), pattern: "**/*.pwtest_nonexistent" },
    );
    expect(created.name).toBe(name);

    try {
      await gotoCollections(page);

      const row = page.locator(`[data-testid="collection-row"][data-collection-name="${name}"]`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(name);
    } finally {
      await apiDelete(request, `/knowledge/collections/${encodeURIComponent(name)}`);
    }
  });

  test("add collection via UI then delete via UI", async ({ page }) => {
    const name = tid("pw-coll-ui");

    await gotoCollections(page);
    await page.getByTestId("add-collection-button").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("collection-name-input").fill(name);
    await dialog.getByTestId("collection-path-input").fill(tmpdir());
    await dialog.getByTestId("collection-submit").click();

    // Row appears in the table
    const row = page.locator(`[data-testid="collection-row"][data-collection-name="${name}"]`);
    await expect(row).toBeVisible();

    // Delete via UI
    await row.getByTestId("collection-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    await expect(row).toHaveCount(0);
  });

  test("delete collection via UI removes it", async ({ page, request }) => {
    const name = tid("pw-coll-del");
    await apiPost(request, "/knowledge/collections", {
      name,
      path: tmpdir(),
      pattern: "**/*.pwtest_nonexistent",
    });

    try {
      await gotoCollections(page);

      const row = page.locator(`[data-testid="collection-row"][data-collection-name="${name}"]`);
      await expect(row).toBeVisible();

      await row.getByTestId("collection-delete").click();
      await page.getByTestId("confirm-dialog-confirm").click();

      await expect(row).toHaveCount(0);
    } catch (e) {
      // best-effort cleanup if UI delete failed
      await apiDelete(request, `/knowledge/collections/${encodeURIComponent(name)}`).catch(
        () => {},
      );
      throw e;
    }
  });
});
