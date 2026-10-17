import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPatch, apiPost, gotoView, tid } from "./_helpers";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`should render, edit, protect drafts and reopen skills at ${viewport.width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    const name = tid("md-workspace");
    const original = `---\nname: ${name}\ndescription: Markdown workspace validation\n---\n\n# Readable document\n\nA paragraph with **bold text** and [a link](https://example.com).\n\n| Feature | Status |\n| --- | --- |\n| Markdown | Supported |\n\n- [x] Read\n- [ ] Edit\n\n\`\`\`typescript\nconst message = "hello";\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  Read --> Edit\n\`\`\`\n`;
    await apiPost(request, "/skills", {
      name,
      content: original,
      files: [
        {
          path: "references/guide.md",
          content: "# Supporting guide\nSupporting Markdown.",
          encoding: "utf8",
        },
      ],
    });
    await gotoView(page, "skills");
    await page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`).click();
    const preview = page.getByTestId("markdown-preview");
    await expect(preview).toContainText("Readable document");
    await expect(preview.locator("h1")).toHaveCSS("font-size", "30px");
    await expect(preview.locator("table")).toBeVisible();
    await expect(preview.locator("svg").first()).toBeVisible();
    await page.getByTestId("markdown-mode-split").click();
    await expect(page.getByTestId("skill-file-content")).toBeVisible();
    const updated = `${original}\nSaved through the reusable workspace.\n`;
    await page.getByTestId("skill-file-content").fill(updated);
    await expect(preview).toContainText("Saved through the reusable workspace");
    await expect(page.getByTestId("document-save-status")).toHaveText("Unsaved changes");
    page.once("dialog", (dialog) => dialog.dismiss());
    if (viewport.width < 640) {
      await page.getByTestId("document-file-picker").selectOption("references/guide.md");
      await expect(page.getByTestId("document-file-picker")).toHaveValue("SKILL.md");
    } else
      await page
        .locator('[data-testid="skill-file"][data-file-name="references/guide.md"]')
        .click();
    await expect(page.getByTestId("skill-file-content")).toContainText(
      "Saved through the reusable workspace",
    );
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId("sheet-close").click();
    await expect(page.getByTestId("document-workspace")).toBeVisible();
    await page.getByTestId("markdown-expand").click();
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("data-expanded", "true");
    const dimensions = await page.getByTestId("markdown-editor").boundingBox();
    expect(dimensions).not.toBeNull();
    expect(dimensions?.width).toBeLessThanOrEqual(viewport.width);
    expect(dimensions?.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: `../../output/playwright/markdown-${viewport.width}.png` });
    await page.getByTestId("skill-file-content").press("Control+s");
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    if (viewport.width < 640)
      await page.getByTestId("document-file-picker").selectOption("references/guide.md");
    else
      await page
        .locator('[data-testid="skill-file"][data-file-name="references/guide.md"]')
        .click();
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("data-expanded", "true");
    await page.getByTestId("skill-show-entry").click();
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("data-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("data-expanded", "false");
    await page.getByTestId("sheet-close").click();
    await page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`).click();
    await expect(page.getByTestId("markdown-preview")).toContainText(
      "Saved through the reusable workspace",
    );
    await page.locator('[data-testid="skill-file"][data-file-name="references/guide.md"]').click();
    await page.getByTestId("markdown-mode-edit").click();
    await page
      .getByTestId("skill-file-content")
      .fill("# Supporting guide\nSaved supporting Markdown.");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    await page.getByTestId("sheet-close").click();
    await page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`).click();
    await page.locator('[data-testid="skill-file"][data-file-name="references/guide.md"]').click();
    await expect(page.getByTestId("skill-file-content")).toContainText("Saved supporting Markdown");
    await page.getByTestId("markdown-mode-read").click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Saved supporting Markdown");
    const overflow = await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
  });
}

test("should save knowledge base document revisions and retain the draft after a concurrent conflict", async ({
  page,
  request,
}) => {
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("md-kb"),
    project_id: null,
  });
  const doc = await apiPost<{ id: string }>(request, `/kb/bases/${kb.id}/documents`, {
    title: "Markdown document",
    content: "# Knowledge document\nOriginal lesson.",
  });
  try {
    await gotoView(page, "knowledge");
    await page.goto(`/knowledge/base?kb=${kb.id}&document=${doc.id}`);
    await page.getByTestId("markdown-mode-edit").click();
    await page
      .getByTestId("kb-document-content")
      .fill("# Knowledge document\nSaved browser lesson.");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    await page.reload();
    await expect(page.getByTestId("kb-document-content")).toContainText("Saved browser lesson");
    await page.getByTestId("markdown-mode-read").click();
    await expect(page.getByTestId("markdown-preview")).toContainText("Saved browser lesson");
    await page.getByTestId("markdown-mode-edit").click();
    await page
      .getByTestId("kb-document-content")
      .fill("# My unsaved draft\nKeep this on conflict.");
    const current = await apiGet<{ revision: number }>(request, `/kb/documents/${doc.id}`);
    await apiPatch(request, `/kb/documents/${doc.id}`, {
      expected_revision: current.revision,
      content: "# Concurrent edit\nKeep the other writer's version.",
    });
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-workspace").getByRole("alert")).toContainText(
      "draft has been kept",
    );
    await expect(page.getByTestId("kb-document-content")).toContainText("My unsaved draft");
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
  }
});

test("should edit a copy of a registered folder file without writing it and keep the draft on a conflicting save", async ({
  page,
  request,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "orc-md-browser-"));
  const file = join(directory, "Read Me.md");
  const original = "# Browser knowledge\n\nknowledgeeditororiginal evidence.";
  writeFileSync(file, original);
  const kb = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
    name: tid("md-kb"),
    project_id: null,
  });
  try {
    await apiPost(request, `/kb/bases/${kb.id}/sources`, { root_path: directory });
    await gotoView(page, "knowledge");
    await page.locator(`[data-testid="kb-row"][data-kb-name="${kb.name}"]`).click();
    await page.getByTestId("kb-search-input").fill("knowledgeeditororiginal");
    await page.getByTestId("kb-search-input").press("Enter");
    await page.getByTestId("kb-search-passage").first().click();
    await page.getByTestId("markdown-mode-edit").click();
    const updated = "# Browser knowledge\n\nknowledgeeditorsaved verified source content.";
    await page.getByTestId("kb-document-content").fill(updated);
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    // The copy changed; the folder file did not.
    expect(readFileSync(file, "utf8")).toBe(original);
    await page.getByTestId("kb-search-input").fill("knowledgeeditorsaved");
    await page.getByTestId("kb-search-input").press("Enter");
    await expect(page.getByTestId("kb-search-result").first()).toContainText("Browser knowledge");
    await page.getByTestId("kb-search-passage").first().click();
    await page.getByTestId("markdown-mode-read").click();
    await expect(page.getByTestId("markdown-preview")).toContainText("knowledgeeditorsaved");
    await page.getByTestId("markdown-mode-edit").click();
    await page.getByTestId("kb-document-content").fill("# My protected search draft");
    // Another writer saves first.
    const { documents } = await apiGet<{ documents: { id: string; revision: number }[] }>(
      request,
      `/kb/bases/${kb.id}/documents`,
    );
    const doc = documents[0];
    if (!doc) throw new Error("folder copy missing");
    await apiPatch(request, `/kb/documents/${doc.id}`, {
      expected_revision: doc.revision,
      content: "# Latest concurrent edit",
    });
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-workspace").getByRole("alert")).toBeVisible();
    await expect(page.getByTestId("kb-document-content")).toContainText(
      "My protected search draft",
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("document-discard").click();
    await expect(page.getByTestId("kb-document-content")).toContainText("Latest concurrent edit");
    await page.getByTestId("kb-document-content").fill("# Search conflict recovered");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    await apiDelete(request, `/kb/bases/${kb.id}`);
    rmSync(directory, { recursive: true, force: true });
  }
});
