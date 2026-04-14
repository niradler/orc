import { expect, test } from "@playwright/test";
import { apiGet, gotoView, tid } from "./_helpers";

interface SkillMeta {
  name: string;
  description: string;
  source: "builtin" | "user";
}

test.describe("Skills", () => {
  test("builtin skills list loads and rows are visible", async ({ page }) => {
    await gotoView(page, "skills");
    await expect(page.getByTestId("view-title")).toHaveText(/skills/i);

    // At least one skill row should be visible
    const rows = page.locator('[data-testid="skill-row"]');
    await expect(rows.first()).toBeVisible();
  });

  test("create user skill via UI then row and source badge appear", async ({ page }) => {
    const name = tid("pw-skill");
    const content = `---
name: ${name}
description: Playwright test skill
---

# ${name}

Playwright test skill auto-created by e2e suite.`;

    await gotoView(page, "skills");
    await page.getByTestId("new-skill-button").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByTestId("skill-name-input").fill(name);
    await dialog.getByTestId("skill-content-input").fill(content);
    await dialog.getByTestId("skill-submit").click();

    // Row appears in the table with the "user" source badge
    const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("user");
  });

  test("clicking a skill row opens the detail sheet", async ({ page, request }) => {
    const { skills } = await apiGet<{ skills: SkillMeta[] }>(request, "/skills");
    if (skills.length === 0) test.skip(true, "no skills in the test environment");

    const skill = skills[0];
    await gotoView(page, "skills");

    const row = page.locator(`[data-testid="skill-row"][data-skill-name="${skill.name}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // Detail sheet opens as a dialog
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(skill.name);
  });

  test("source filter 'User' pill shows only user skills", async ({ page }) => {
    await gotoView(page, "skills");

    // Click the "User" filter pill
    await page.getByRole("button", { name: /^user$/i }).click();

    // Every visible row must carry the "user" source badge
    const rows = page.locator('[data-testid="skill-row"]');
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText("user");
    }
  });
});
