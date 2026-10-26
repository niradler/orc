import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

test("mermaid fullscreen controls work inside a modal panel", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = tid("md-fullscreen");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: Fullscreen diagram\n---\n\n\`\`\`mermaid\nflowchart LR\n  Read --> Edit\n\`\`\`\n`,
  });
  try {
    await gotoView(page, "skills");
    await page
      .locator(`[data-testid="skill-row"][data-skill-name="${name}"]`)
      .getByTestId("skill-open")
      .click();
    const preview = page.getByTestId("markdown-preview");
    await expect(preview.locator("svg").first()).toBeVisible();
    await preview.getByRole("button", { name: "View fullscreen" }).click();
    const overlay = page.locator('[data-streamdown="mermaid-fullscreen"]');
    await expect(overlay).toBeVisible();

    await page.evaluate(() => navigator.clipboard.writeText(""));
    await overlay.getByRole("button", { name: "Copy Code" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("Read --> Edit");
    await overlay.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect(overlay).toHaveCount(0);
    await expect(preview).toBeVisible();

    await preview.getByRole("button", { name: "View fullscreen" }).click();
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(preview).toBeVisible();
  } finally {
    await apiDelete(request, `/skills/${name}`);
  }
});
