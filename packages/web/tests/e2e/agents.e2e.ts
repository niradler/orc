import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

test("should create from an editable template and save tool changes after reopening", async ({
  page,
  request,
}) => {
  const id = tid("editable-reviewer");
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  await page.getByTestId("new-agent-button").click();
  await page.getByTestId("agent-template").selectOption("reviewer");
  await page.getByTestId("agent-id-input").fill(id);
  await page.getByTestId("agent-name-input").fill("My reviewer");
  await page.getByTestId("agent-tool-row").nth(1).getByTestId("agent-tool-remove").click();
  await page.getByTestId("agent-tool-add").click();
  await expect(page.getByTestId("agent-submit")).toBeDisabled();
  await page.getByTestId("agent-tool-row").last().getByTestId("agent-tool-name").fill("WebSearch");
  await page.getByTestId("agent-tool-row").last().getByTestId("agent-tool-allowed").uncheck();
  await page.getByTestId("agent-instructions-input").fill("Use this editable reviewer template.");
  await page.getByTestId("code-editor-preview-toggle").click();
  await expect(page.getByTestId("code-editor-markdown-preview")).toContainText(
    "Use this editable reviewer template.",
  );
  await page.getByTestId("code-editor-preview-toggle").click();
  await page.getByTestId("agent-editor-mode").click();
  const raw = await page.getByTestId("agent-content-input").innerText();
  const custom = raw.replace(
    "description:",
    "# Preserve this comment\ncustom-field: kept\nhandoffs: [builder]\ndescription:",
  );
  await page.getByTestId("agent-content-input").fill("---\nname: [\n---\nInstructions");
  await expect(page.getByTestId("agent-submit")).toBeDisabled();
  await page.getByTestId("agent-content-input").fill(custom);
  await page.getByTestId("agent-editor-mode").click();
  await page.getByTestId("agent-description-input").fill("A configured specialist");
  await page.getByTestId("agent-submit").click();
  const row = page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`);
  await row.click();
  await page.getByTestId("agent-edit").click();
  await expect(page.getByTestId("agent-name-input")).toHaveValue("My reviewer");
  for (const [index, name] of ["Read", "Bash", "WebSearch"].entries())
    await expect(page.getByTestId("agent-tool-name").nth(index)).toHaveValue(name);
  await page.getByTestId("agent-tool-row").last().getByTestId("agent-tool-remove").click();
  await page.getByTestId("agent-tool-add").click();
  await page.getByTestId("agent-tool-row").last().getByTestId("agent-tool-name").fill("Glob");
  await page.getByTestId("agent-submit").click();
  await expect(page.getByTestId("agent-fields")).toContainText('"Glob": true');
  await page.reload();
  await expect(page.getByTestId("agent-fields")).toContainText('"custom-field": "kept"');
  const stored = await apiGet<{
    raw: string;
    fields: { tools: Record<string, boolean>; handoffs: string[] };
  }>(request, `/agents/${id}`);
  expect(stored.raw).toContain("# Preserve this comment");
  expect(stored.fields.tools).toEqual({ Read: true, Bash: false, Glob: true });
  expect(stored.fields.handoffs).toEqual(["builder"]);
  await expect(page.getByTestId("agent-content")).toHaveAttribute("contenteditable", "false");
  await page.screenshot({ path: "../../.claude/agent-editor-saved.png" });
});

test("should retain drafts on a stale save and refresh the profile when editing again", async ({
  page,
  request,
}) => {
  const id = tid("conflicting-reviewer");
  await apiPost(request, "/agents", {
    id,
    content: "---\nname: Reviewer\ndescription: Original\n---\nOriginal instructions.",
  });
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  await page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`).click();
  await page.getByTestId("agent-edit").click();
  await page.getByTestId("agent-description-input").fill("My unsaved draft");
  const current = await apiGet<{ raw: string; path: string }>(request, `/agents/${id}`);
  const external = current.raw.replace("Original", "External update");
  const changed = await request.put(`${API_BASE}/agents/${id}`, {
    headers: AUTH_HEADERS,
    data: { content: external, expectedRaw: current.raw, expectedPath: current.path },
  });
  expect(changed.status()).toBe(200);
  await page.getByTestId("agent-submit").click();
  await expect(page.getByTestId("agent-editor-error")).toContainText("changed since you opened");
  await expect(page.getByTestId("agent-description-input")).toHaveValue("My unsaved draft");
  await page.keyboard.press("Escape");
  await page.getByTestId("agent-edit").click();
  await expect(page.getByTestId("agent-description-input")).toHaveValue("External update");
});

test("should create an APM package from editable fields and YAML", async ({ page, request }) => {
  const name = tid("authored-package");
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  await page.getByTestId("new-agent-package-button").click();
  await page.getByTestId("package-name-input").fill(name);
  await page.getByTestId("package-version-input").fill("1.2.3");
  await page.getByTestId("package-description-input").fill("Editable package configuration");
  await page.getByTestId("package-editor-mode").click();
  const manifest = await page.getByTestId("package-yaml-input").innerText();
  await expect(page.getByTestId("package-yaml-input")).toHaveAttribute("data-language", "yaml");
  await page.getByTestId("package-yaml-input").fill(`${manifest}x-custom: retained\n`);
  await page.getByTestId("package-submit").click();
  await expect(
    page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`),
  ).toBeVisible();
  const saved = await apiGet<{ manifest: Record<string, unknown> }>(
    request,
    `/agent-packages/${name}`,
  );
  expect(saved.manifest).toMatchObject({
    name,
    version: "1.2.3",
    "x-custom": "retained",
    targets: ["claude", "codex"],
  });
});

test("shared agent creation survives reopening with metadata intact", async ({ page }) => {
  const id = tid("shared-agent");
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  await page.getByTestId("new-agent-button").click();
  await page.getByTestId("agent-id-input").fill(id);
  await page.getByTestId("agent-editor-mode").click();
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
  await page.getByTestId("agent-delete").click();
  await page.getByTestId("confirm-dialog-cancel").click();
  await expect(page.getByTestId("agent-content")).toBeVisible();
  await page.getByTestId("agent-delete").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(row).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents$/);
  await page.reload();
  await expect(row).toHaveCount(0);
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
    await expect(page.getByTestId("agent-content")).toContainText("Review the package.");
    await page.getByTestId("agent-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`),
    ).toBeVisible();
    await page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`).click();
    await expect(page.getByTestId("package-file-content")).toContainText(`name: ${name}`);
    await expect(page.getByTestId("package-file-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    await page
      .locator(
        `[data-testid="package-file"][data-file-name=".apm/skills/${skillName}/scripts/check.py"]`,
      )
      .click();
    await expect(page.getByTestId("package-file-content")).toHaveText("print('portable workflow')");
    await page.keyboard.press("Escape");
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

test("should delete one duplicate name and recover from a failed deletion", async ({
  page,
  request,
}) => {
  const firstId = tid("duplicate-reviewer");
  const secondId = tid("duplicate-reviewer");
  const content = "---\nname: Reviewer\ndescription: Duplicate display name\n---\nReview evidence.";
  await apiPost(request, "/agents", { id: firstId, content });
  await apiPost(request, "/agents", { id: secondId, content });
  await gotoView(page, "skills");
  await page.getByTestId("nav-agents").click();
  const firstRow = page.locator(`[data-testid="agent-row"][data-agent-id="${firstId}"]`);
  const secondRow = page.locator(`[data-testid="agent-row"][data-agent-id="${secondId}"]`);
  await firstRow.click();
  await page.route(`**/api/agents/${firstId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 409, json: { error: "Profile is unavailable" } });
    } else {
      await route.continue();
    }
  });
  await page.getByTestId("agent-delete").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByTestId("agent-delete")).toBeEnabled();
  await expect(page.getByTestId("agent-content")).toBeVisible();
  await expect(page.getByTestId("agent-delete-error")).toContainText("Profile is unavailable");
  await page.unroute(`**/api/agents/${firstId}`);
  await page.getByTestId("agent-delete").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(firstRow).toHaveCount(0);
  await expect(secondRow).toBeVisible();
  await page.reload();
  await expect(firstRow).toHaveCount(0);
  await expect(secondRow).toBeVisible();
});
