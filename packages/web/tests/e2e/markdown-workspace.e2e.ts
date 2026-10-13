import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_HEADERS, apiPost, gotoView, tid } from "./_helpers";

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
    await expect(page.getByTestId("markdown-preview")).toContainText("Saved supporting Markdown");
    const overflow = await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
  });
}

test("should save Wiki revisions and retain the draft after a concurrent conflict", async ({
  page,
  request,
}) => {
  const slug = tid("md-wiki");
  const original = {
    project_id: null,
    slug,
    kind: "procedure",
    title: "Markdown wiki",
    summary: "Editor validation",
    content: "# Wiki document\nOriginal lesson.",
    note: "Created for browser validation",
    expected_revision: 0,
  };
  await apiPost(request, "/wiki", original);
  await page.addInitScript(
    (secret) => localStorage.setItem("orc_api_secret", secret),
    AUTH_HEADERS.Authorization?.slice(7) ?? "",
  );
  await page.goto(`/wiki?tab=pages&page=${slug}&scope=global`);
  await page.getByTestId("markdown-mode-edit").click();
  await page.getByTestId("wiki-editor-content").fill("# Wiki document\nSaved browser lesson.");
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("markdown-preview")).toContainText("Saved browser lesson");
  await page.getByTestId("markdown-mode-edit").click();
  await page.getByTestId("wiki-editor-content").fill("# My unsaved draft\nKeep this on conflict.");
  await apiPost(request, "/wiki", {
    ...original,
    expected_revision: 2,
    content: "# Concurrent edit\nKeep the other writer's version.",
  });
  await page.getByTestId("document-save").click();
  await expect(page.getByRole("alert")).toContainText("draft has been kept");
  await expect(page.getByTestId("wiki-editor-content")).toContainText("My unsaved draft");
});

test("should edit the actual Knowledge source and search the newly indexed content after reopening", async ({
  page,
  request,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "orc-md-browser-"));
  const collection = tid("md-collection");
  const file = join(directory, "Read Me.md");
  writeFileSync(file, "# Browser knowledge\n\nknowledgeeditororiginal evidence.");
  await apiPost(request, "/knowledge/collections", { name: collection, path: directory });
  await gotoView(page, "knowledge");
  await page.getByPlaceholder("Search knowledge base...").fill("knowledgeeditororiginal");
  await page.getByPlaceholder("Search knowledge base...").press("Enter");
  await page.getByTestId("knowledge-result").first().click();
  await page.getByTestId("markdown-mode-edit").click();
  const updated = "# Browser knowledge\n\nknowledgeeditorsaved verified source content.";
  await page.getByTestId("knowledge-file-content").fill(updated);
  await page.getByTestId("document-save").click();
  await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
  expect(readFileSync(file, "utf8")).toBe(updated);
  await page.getByTestId("sheet-close").click();
  await page.getByPlaceholder("Search knowledge base...").fill("knowledgeeditorsaved");
  await page.getByPlaceholder("Search knowledge base...").press("Enter");
  await page.getByTestId("knowledge-result").first().click();
  await expect(page.getByTestId("markdown-preview")).toContainText("knowledgeeditorsaved");
});
