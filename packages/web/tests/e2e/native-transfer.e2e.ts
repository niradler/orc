import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test.afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("exports a skill to a folder in native format and flags near copies on import", async ({
  page,
  request,
}) => {
  const name = tid("pw-export").toLowerCase();
  const body = "Run the release checklist, then tag the commit and publish the notes.";
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: Release checklist fixture\n---\n\n${body}\n`,
  });
  const dir = tempDir("orc-pw-skills-");
  try {
    await gotoView(page, "skills");
    await page.getByTestId("skill-import-menu").click();
    await page.getByTestId("export-skills-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("skill-export-target").selectOption("__folder__");
    await dialog.getByTestId("skill-export-folder").fill(dir);
    await dialog.getByTestId("skill-export-folder-apply").click();
    const item = dialog.locator(`[data-testid="skill-export-item"][data-skill-name="${name}"]`);
    await expect(item).toHaveAttribute("data-status", "new");
    await expect(dialog.getByTestId("skill-export-submit")).toBeDisabled();
    await item.getByTestId("skill-export-select").check();
    await expect(dialog.getByTestId("skill-export-submit")).toContainText("1");
    await dialog.getByTestId("skill-export-submit").click();
    await expect(dialog).toHaveCount(0);

    const skillFile = join(dir, name, "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const exported = readFileSync(skillFile, "utf8");
    expect(exported).toContain(`name: ${name}`);
    expect(exported).toContain(body);

    const copy = `${name}-copy`;
    mkdirSync(join(dir, copy));
    writeFileSync(join(dir, copy, "SKILL.md"), exported.replace(`name: ${name}`, `name: ${copy}`));
    writeFileSync(skillFile, exported.replace("publish the notes", "publish the note"));

    await page.getByTestId("skill-import-menu").click();
    await page.getByTestId("import-local-skills-button").click();
    await dialog.getByTestId("local-skill-source").selectOption("folder");
    await dialog.getByTestId("local-skill-folder").fill(dir);
    await dialog.getByTestId("local-skill-folder-scan").click();
    const copyRow = dialog.locator(`[data-testid="local-skill"][data-skill-name="${copy}"]`);
    await expect(copyRow).toContainText("Already in ORC under another name");
    await expect(copyRow.getByTestId("transfer-match")).toContainText(`${name} in ORC`);
    await expect(copyRow.getByTestId("local-skill-select")).toBeDisabled();
    const editedRow = dialog.locator(`[data-testid="local-skill"][data-skill-name="${name}"]`);
    await expect(editedRow.getByTestId("transfer-match")).toContainText(
      `Near copy of ${name} in ORC`,
    );
    await page.screenshot({ path: "../../output/playwright/skill-folder-import-dedup.png" });
  } finally {
    await apiDelete(request, `/skills/${name}`);
  }
});

test("exports project memories as Claude memory files and flags near copies on import", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("pw-mem-transfer"),
  });
  const name = tid("pw-mem").toLowerCase();
  const dir = tempDir("orc-pw-memory-");
  try {
    await apiPost(request, "/memories", {
      project_id: project.id,
      name,
      description: "Port the API listens on",
      content: "The API listens on 7700 in local development",
    });
    await gotoView(page, "memories");
    await page.goto(`/knowledge/memories?project=${encodeURIComponent(project.id)}`);
    await page.getByTestId("memory-transfer-menu").click();
    await page.getByTestId("memory-export-button").click();
    const dialog = page.getByTestId("memory-export-dialog");
    await dialog.getByTestId("memory-export-source").selectOption("__folder__");
    await dialog.getByTestId("memory-export-folder").fill(dir);
    await dialog.getByTestId("memory-export-folder-apply").click();
    const item = dialog.locator(`[data-testid="memory-export-item"][data-memory-name="${name}"]`);
    await expect(item).toHaveAttribute("data-status", "new");
    await dialog.getByTestId("memory-export-select-new").click();
    await expect(item.getByTestId("memory-export-select")).toBeChecked();
    await dialog.getByTestId("memory-export-submit").click();
    await expect(dialog).toHaveCount(0);

    const file = join(dir, `${name}.md`);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toContain(`name: ${name}`);
    expect(text).toContain("description: Port the API listens on");
    expect(text).toContain("The API listens on 7700 in local development");

    const copy = `${name}-copy`;
    writeFileSync(
      join(dir, `${copy}.md`),
      text.replace(`name: ${name}`, `name: ${copy}`).replace("development", "developmen"),
    );

    await page.getByTestId("memory-transfer-menu").click();
    await page.getByTestId("memory-import-button").click();
    const importing = page.getByTestId("memory-import-dialog");
    await importing.getByTestId("memory-import-source").selectOption("__folder__");
    await importing.getByTestId("memory-import-folder").fill(dir);
    await importing.getByTestId("memory-import-folder-apply").click();
    const same = importing.locator(
      `[data-testid="memory-import-item"][data-memory-name="${name}"]`,
    );
    await expect(same).toHaveAttribute("data-status", "installed");
    const near = importing.locator(
      `[data-testid="memory-import-item"][data-memory-name="${copy}"]`,
    );
    await expect(near).toHaveAttribute("data-status", "duplicate");
    await expect(near.getByTestId("transfer-match")).toContainText(`Near copy of ${name} in ORC`);
    await expect(near.getByTestId("memory-import-select")).toBeDisabled();
    await expect(importing.getByTestId("memory-import-submit")).toBeDisabled();
    await page.screenshot({ path: "../../output/playwright/memory-folder-import-dedup.png" });
  } finally {
    await apiDelete(request, `/projects/${project.id}`);
  }
});
