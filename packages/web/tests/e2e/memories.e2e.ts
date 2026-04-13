import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

interface Memory {
  id: string;
  content: string;
}

test.describe("Memories CRUD", () => {
  test("create via UI then delete via UI", async ({ page, request }) => {
    const marker = tid("pw-mem");
    const body = `PW_MEMORY_CONTENT ${marker} — auto-cleaned by this test`;
    await gotoView(page, "memories");
    await expect(page.getByTestId("view-title")).toHaveText(/memories/i);

    await page.getByTestId("new-memory-button").click();
    await page.getByTestId("memory-content-input").fill(body);
    await page.getByTestId("memory-submit").click();

    // Row appears — memory rows don't carry the content in dataset, so find by id via API
    const { memories } = await apiGet<{ memories: Memory[] }>(request, "/memories?limit=100");
    const created = memories.find((m) => m.content.includes(marker));
    expect(created, "API should return created memory").toBeTruthy();
    if (!created) return;

    const row = page.locator(`[data-testid="memory-row"][data-memory-id="${created.id}"]`);
    await expect(row).toBeVisible();

    await row.getByTestId("memory-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);

    const { memories: after } = await apiGet<{ memories: Memory[] }>(
      request,
      "/memories?limit=100",
    );
    expect(after.find((m) => m.content.includes(marker))).toBeUndefined();
  });

  test("seed via API reflects in UI list", async ({ page, request }) => {
    const marker = tid("pw-mem-seed");
    const created = await apiPost<Memory>(request, "/memories", {
      content: `PW seed memory ${marker}`,
      type: "fact",
      importance: "normal",
    });
    try {
      await gotoView(page, "memories");
      const row = page.locator(`[data-testid="memory-row"][data-memory-id="${created.id}"]`);
      await expect(row).toBeVisible();
    } finally {
      await apiDelete(request, `/memories/${created.id}`);
    }
  });
});
