import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, gotoView, tid } from "./_helpers";

interface SkillMeta {
  name: string;
  description: string;
  source: "builtin" | "user";
}

test.describe("Skills", () => {
  test("multi-file skill creation and saved resources survive reopening", async ({ page }) => {
    const name = tid("pw-bundle");
    await gotoView(page, "skills");
    await page.getByTestId("new-skill-button").click();
    await page.getByTestId("skill-name-input").fill(name);
    await page
      .getByTestId("skill-content-input")
      .fill(
        `---\nname: ${name}\ndescription: Multi-file browser workflow\n---\nRead references/deep/guide.md and run scripts/check.py.`,
      );
    const resources = [
      { path: "references/deep/guide.md", content: "# Detailed workflow\nRead only when needed." },
      { path: "scripts/check.py", content: "print('bundle verified')" },
    ];
    for (const resource of resources) {
      await page.getByTestId("skill-add-file").click();
      const row = page.getByTestId("skill-supporting-file").last();
      await row.getByTestId("skill-file-path-input").fill(resource.path);
      await row.getByTestId("skill-file-content-input").fill(resource.content);
    }
    await page.getByTestId("skill-submit").click();
    const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
    await expect(row).toBeVisible();
    await row.click();
    for (const resource of resources) {
      await page.locator(`[data-testid="skill-file"][data-file-name="${resource.path}"]`).click();
      await expect(page.getByTestId("skill-file-content")).toHaveText(resource.content);
    }
    await page.reload();
    await expect(page.getByTestId("skill-file-content")).toContainText(
      "Read references/deep/guide.md",
    );
    await page.locator('[data-testid="skill-file"][data-file-name="scripts/check.py"]').click();
    await expect(page.getByTestId("skill-file-content")).toHaveText(resources[1].content);
    await page.getByTestId("skill-show-entry").click();
    await expect(page.getByTestId("skill-file-content")).toContainText(
      "Read references/deep/guide.md",
    );
    await page.screenshot({ path: "../../.claude/multi-file-skills-browser.png" });
  });

  test("imports a skill folder with nested documentation and a binary asset", async ({ page }) => {
    const name = tid("pw-import");
    const temporary = mkdtempSync(join(tmpdir(), "orc-folder-import-"));
    const folder = join(temporary, name);
    mkdirSync(join(folder, "references/deep"), { recursive: true });
    mkdirSync(join(folder, "assets"));
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: Imported workflow\n---\nUse references/deep/guide.md.`,
    );
    writeFileSync(join(folder, "references/deep/guide.md"), "Imported nested guide");
    writeFileSync(join(folder, "assets/sample.bin"), Buffer.from([0, 255]));
    try {
      await gotoView(page, "skills");
      await page.getByTestId("new-skill-button").click();
      await page.getByTestId("skill-folder-input").setInputFiles(folder);
      await expect(page.getByTestId("skill-name-input")).toHaveValue(name);
      await expect(page.getByTestId("skill-supporting-file")).toHaveCount(2);
      await page.getByTestId("skill-submit").click();
      const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
      await expect(row).toBeVisible();
      await row.click();
      await page
        .locator('[data-testid="skill-file"][data-file-name="references/deep/guide.md"]')
        .click();
      await expect(page.getByTestId("skill-file-content")).toHaveText("Imported nested guide");
      await page.locator('[data-testid="skill-file"][data-file-name="assets/sample.bin"]').click();
      await expect(page.getByTestId("skill-file-content")).toHaveText("AP8=");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
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
