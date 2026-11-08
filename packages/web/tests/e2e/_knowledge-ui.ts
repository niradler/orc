import { expect, type Page } from "@playwright/test";

export async function selectKnowledgeBase(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("kb-overview-name")).toBeVisible();
  await page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`).click();
  await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
}
