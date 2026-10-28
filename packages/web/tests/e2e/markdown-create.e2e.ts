import { expect, test } from "@playwright/test";
import { gotoView, tid } from "./_helpers";

test("should create a skill from the expanded Markdown editor on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = tid("md-mobile-create");
  await gotoView(page, "skills");
  await page.getByTestId("new-skill-button").click();
  await page.getByTestId("skill-name-input").fill(name);
  await page
    .getByTestId("skill-content-input")
    .fill(
      `---\nname: ${name}\ndescription: Mobile Markdown creation\n---\n\n# Created on a phone\n\nReadable Markdown saved from fullscreen.`,
    );
  await page.getByTestId("markdown-expand").click();
  const dimensions = await page.getByTestId("markdown-editor").boundingBox();
  expect(dimensions?.height).toBeGreaterThan(750);
  expect(dimensions?.width).toBeLessThanOrEqual(390);
  expect(dimensions?.x).toBeGreaterThanOrEqual(0);
  expect(dimensions?.y).toBeGreaterThanOrEqual(0);
  await page.getByTestId("markdown-save").click();
  const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Created on a phone");
});
