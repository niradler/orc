import { expect, type Page } from "@playwright/test";

export async function selectKnowledgeBase(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("kb-overview-name")).toBeVisible();
  await page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`).click();
  await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
}

/** The context rail starts closed; setup (folders, digest, access) lives inside it. */
export async function openKbContext(page: Page): Promise<void> {
  const toggle = page.getByTestId("kb-context-toggle");
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(page.getByTestId("kb-context-rail")).toBeVisible();
}
