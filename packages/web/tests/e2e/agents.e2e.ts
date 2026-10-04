import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gotoView, tid } from "./_helpers";

test("shared agent creation survives reopening with metadata intact", async ({ page }) => {
  const id = tid("shared-agent");
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  await page.getByTestId("new-agent-button").click();
  await page.getByTestId("agent-id-input").fill(id);
  await page
    .getByTestId("agent-content-input")
    .fill(
      "---\nname: Reviewer\ndescription: Review across coding agents\nmodel: pinned-model\ntools:\n  Read: true\n  Bash: false\nhandoffs: [builder]\n---\nReview the working diff and cite evidence.",
    );
  await page.getByTestId("agent-submit").click();
  const row = page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("agent-content")).toContainText("Review the working diff");
  await expect(page.getByTestId("agent-fields")).toContainText("pinned-model");
  await page.reload();
  await expect(page.getByTestId("agent-content")).toContainText("cite evidence");
  await expect(page.getByTestId("agent-fields")).toContainText('"Bash": false');
  await page.screenshot({ path: "../../.claude/shared-agents-browser.png" });
});

test("APM folder import shares packaged agents and skills", async ({ page }) => {
  const name = tid("shared-package");
  const skillName = tid("shared-workflow");
  const temporary = mkdtempSync(join(tmpdir(), "orc-apm-browser-"));
  const folder = join(temporary, name);
  mkdirSync(join(folder, ".apm/agents"), { recursive: true });
  mkdirSync(join(folder, `.apm/skills/${skillName}/scripts`), { recursive: true });
  writeFileSync(
    join(folder, "apm.yml"),
    `name: ${name}\nversion: '1.0.0'\ndescription: Shared package\n`,
  );
  writeFileSync(
    join(folder, ".apm/agents/reviewer.agent.md"),
    "---\ndescription: Packaged reviewer\n---\nReview the package.",
  );
  writeFileSync(
    join(folder, `.apm/skills/${skillName}/SKILL.md`),
    `---\nname: ${skillName}\ndescription: Shared packaged workflow\n---\nUse scripts/check.py.`,
  );
  writeFileSync(
    join(folder, `.apm/skills/${skillName}/scripts/check.py`),
    "print('portable workflow')",
  );
  try {
    await gotoView(page, "skills");
    await page.getByTestId("nav-agents").click();
    await page.getByTestId("agent-package-folder").setInputFiles(folder);
    const row = page.locator(`[data-testid="agent-row"][data-agent-id="${name}/reviewer"]`);
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByTestId("agent-content")).toHaveText("Review the package.");
    await page.goto("/skills");
    const skill = page.locator(`[data-testid="skill-row"][data-skill-name="${skillName}"]`);
    await expect(skill).toBeVisible();
    await skill.click();
    await page.locator('[data-testid="skill-file"][data-file-name="scripts/check.py"]').click();
    await expect(page.getByTestId("skill-file-content")).toHaveText("print('portable workflow')");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
