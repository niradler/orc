import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

interface Memory {
  id: string;
  content: string;
  type: string;
  importance: string;
}

test.describe("Memories CRUD", () => {
  test("create via UI then delete via UI", async ({ page }) => {
    const marker = tid("pw-mem");
    const body = `PW_MEMORY_CONTENT ${marker} - auto-cleaned by this test`;
    await gotoView(page, "memories");
    await expect(page.getByTestId("view-title")).toHaveText(/memories/i);

    await page.getByTestId("new-memory-button").click();
    await page.getByTestId("memory-content-input").fill(body);
    await page.getByTestId("memory-submit").click();

    // Row appears - the title cell shows content text when no title is set
    const row = page.locator('[data-testid="memory-row"]').filter({ hasText: marker });
    await expect(row).toBeVisible();

    await row.getByTestId("memory-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);
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

  test("edit memory via detail dialog updates content in table", async ({ page, request }) => {
    const marker = tid("pw-mem-edit");
    const originalContent = `PW original memory ${marker}`;
    const updatedContent = `PW updated memory ${marker}`;

    const created = await apiPost<Memory>(request, "/memories", {
      content: originalContent,
      type: "fact",
      importance: "normal",
    });
    try {
      await gotoView(page, "memories");

      const row = page.locator(`[data-testid="memory-row"][data-memory-id="${created.id}"]`);
      await expect(row).toBeVisible();

      // Click the row to open the edit dialog
      await row.click();

      const editDialog = page.getByTestId("edit-memory-dialog");
      await expect(editDialog).toBeVisible();

      // Update the content
      const contentInput = editDialog.getByTestId("edit-memory-content-input");
      await contentInput.clear();
      await contentInput.fill(updatedContent);

      await editDialog.getByTestId("edit-memory-submit").click();

      // Dialog closes
      await expect(editDialog).toHaveCount(0);

      // Row in the table should now show the updated content
      await expect(row).toContainText(updatedContent);
    } finally {
      await apiDelete(request, `/memories/${created.id}`);
    }
  });

  test("memory search returns matching results", async ({ page, request }) => {
    const marker = tid("pw-mem-search");
    const uniqueWord = `xpwsearch${marker}`;
    const created = await apiPost<Memory>(request, "/memories", {
      content: `This is a test memory with unique word: ${uniqueWord}`,
      type: "fact",
      importance: "normal",
    });
    try {
      await gotoView(page, "memories");

      // Type the search query
      const searchInput = page.getByPlaceholder("Search memories...");
      await searchInput.fill(uniqueWord);
      await searchInput.press("Enter");

      // The created memory should appear in search results
      const row = page.locator(`[data-testid="memory-row"][data-memory-id="${created.id}"]`);
      await expect(row).toBeVisible();
    } finally {
      await apiDelete(request, `/memories/${created.id}`);
    }
  });

  test("type filter tab shows only matching memory type", async ({ page, request }) => {
    const factMarker = tid("pw-mem-fact");
    const ruleMarker = tid("pw-mem-rule");
    const factMem = await apiPost<Memory>(request, "/memories", {
      content: `Fact memory ${factMarker}`,
      type: "fact",
      importance: "normal",
    });
    const ruleMem = await apiPost<Memory>(request, "/memories", {
      content: `Rule memory ${ruleMarker}`,
      type: "rule",
      importance: "normal",
    });

    try {
      await gotoView(page, "memories");

      // Click the "Fact" filter pill
      await page.getByRole("button", { name: /^fact/i }).click();

      await expect(
        page.locator(`[data-testid="memory-row"][data-memory-id="${factMem.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="memory-row"][data-memory-id="${ruleMem.id}"]`),
      ).toHaveCount(0);

      // Click "Rule" filter
      await page.getByRole("button", { name: /^rule/i }).click();

      await expect(
        page.locator(`[data-testid="memory-row"][data-memory-id="${ruleMem.id}"]`),
      ).toBeVisible();
      await expect(
        page.locator(`[data-testid="memory-row"][data-memory-id="${factMem.id}"]`),
      ).toHaveCount(0);
    } finally {
      await apiDelete(request, `/memories/${factMem.id}`);
      await apiDelete(request, `/memories/${ruleMem.id}`);
    }
  });
});
