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

test("exports a skill into a project's checkout and imports it back from the project", async ({
  page,
  request,
}) => {
  const name = tid("pw-project-skill").toLowerCase();
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: Project folder fixture\n---\n\nRun the project smoke checks before every merge.\n`,
  });
  const checkout = tempDir("orc-pw-project-");
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: tid("pw-skill-project"),
    scope: checkout,
  });
  const skillsDir = join(checkout, ".claude", "skills");
  try {
    await gotoView(page, "skills");
    await page.getByTestId("skill-import-menu").click();
    await page.getByTestId("export-skills-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("skill-export-target").selectOption(`project:${skillsDir}`);
    await expect(dialog.getByTestId("skill-export-plan")).toContainText(skillsDir);
    const item = dialog.locator(`[data-testid="skill-export-item"][data-skill-name="${name}"]`);
    await expect(item).toHaveAttribute("data-status", "new");
    await item.getByTestId("skill-export-select").check();
    await dialog.getByTestId("skill-export-submit").click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8")).toContain(`name: ${name}`);

    await page.getByTestId("skill-import-menu").click();
    await page.getByTestId("import-local-skills-button").click();
    await dialog.getByTestId("local-skill-source").selectOption(`project:${skillsDir}`);
    const row = dialog.locator(`[data-testid="local-skill"][data-skill-name="${name}"]`);
    await expect(row).toContainText("Already in ORC");
    await expect(row.getByTestId("local-skill-select")).toBeDisabled();
  } finally {
    await apiDelete(request, `/skills/${name}`);
    await apiDelete(request, `/projects/${project.id}`);
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
    await expect(dialog.getByTestId("memory-export-project")).toHaveValue(project.id);
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

    await page.goto("/knowledge/memories?project=all");
    await page.getByTestId("memory-transfer-menu").click();
    await page.getByTestId("memory-import-button").click();
    const importing = page.getByTestId("memory-import-dialog");
    await expect(importing.getByTestId("memory-import-project")).toHaveValue("");
    await expect(importing.getByTestId("memory-import-source")).toBeDisabled();
    await importing.getByTestId("memory-import-project").selectOption(project.id);
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

test("imports plain Codex notes and exports memories back as notes without an index", async ({
  page,
  request,
}) => {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome?.startsWith(tmpdir()))
    throw new Error("Run through scripts/run-e2e.ts so CODEX_HOME points at the temp home");
  const notes = join(codexHome, "memories", "extensions", "ad_hoc", "notes");
  mkdirSync(notes, { recursive: true });
  const noteName = tid("pw-codex-note").toLowerCase();
  const noteFile = join(notes, `2026-10-23T17-38-43Z-${noteName}.md`);
  writeFileSync(noteFile, "# Ask before pushing master\n\nNever push to master without consent.\n");
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("pw-codex-transfer"),
  });
  const name = tid("pw-codex-mem").toLowerCase();
  try {
    await apiPost(request, "/memories", {
      project_id: project.id,
      name,
      description: "Release protocol",
      content: "Bump every package version together before running the release script",
    });
    await gotoView(page, "memories");
    await page.goto(`/knowledge/memories?project=${encodeURIComponent(project.id)}`);
    await page.getByTestId("memory-transfer-menu").click();
    await page.getByTestId("memory-import-button").click();
    const importing = page.getByTestId("memory-import-dialog");
    await importing.getByTestId("memory-import-source").selectOption(notes);
    const note = importing.locator(
      `[data-testid="memory-import-item"][data-memory-name="${noteName}"]`,
    );
    await expect(note).toHaveAttribute("data-status", "new");
    await expect(note).toContainText("Ask before pushing master");
    await note.getByTestId("memory-import-select").check();
    await importing.getByTestId("memory-import-submit").click();
    await expect(importing).toHaveCount(0);
    await expect(page.getByText("Ask before pushing master").first()).toBeVisible();

    await page.getByTestId("memory-transfer-menu").click();
    await page.getByTestId("memory-export-button").click();
    const exporting = page.getByTestId("memory-export-dialog");
    await exporting.getByTestId("memory-export-source").selectOption(notes);
    const plan = exporting.getByTestId("memory-export-plan");
    await expect(plan).not.toContainText("MEMORY.md");
    await expect(
      exporting.locator(`[data-testid="memory-export-item"][data-memory-name="${noteName}"]`),
    ).toHaveAttribute("data-status", "identical");
    const item = exporting.locator(
      `[data-testid="memory-export-item"][data-memory-name="${name}"]`,
    );
    await expect(item).toHaveAttribute("data-status", "new");
    await item.getByTestId("memory-export-select").check();
    await exporting.getByTestId("memory-export-submit").click();
    await expect(exporting).toHaveCount(0);

    const text = readFileSync(join(notes, `${name}.md`), "utf8");
    expect(text).toContain("description: Release protocol");
    expect(text).toContain("Bump every package version together");
    expect(existsSync(join(notes, "MEMORY.md"))).toBe(false);
    expect(readFileSync(noteFile, "utf8")).toContain("Never push to master without consent.");
  } finally {
    await apiDelete(request, `/projects/${project.id}`);
    rmSync(join(notes, `${name}.md`), { force: true });
    rmSync(noteFile, { force: true });
  }
});
