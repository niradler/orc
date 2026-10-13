import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.error(`Browser error: ${error.message}`));
  page.on("requestfailed", (request) =>
    console.error(
      `Browser request failed: ${request.url().split("?")[0]} ${request.failure()?.errorText}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.error(`Browser HTTP ${response.status()}: ${response.url().split("?")[0]}`);
  });
});

test("imports a real GitHub skill, edits it, reopens it and preserves edits on sync", async ({
  page,
}) => {
  test.setTimeout(120000);
  await gotoView(page, "skills");
  await page.getByTestId("import-skill-button").click();
  await page
    .getByTestId("skill-repository-input")
    .fill("https://skills.sh/vercel-labs/skills/find-skills");
  await page.getByTestId("skill-discover").click();
  const available = page.locator('[data-testid="remote-skill"][data-skill-name="find-skills"]');
  await expect(available).toBeVisible({ timeout: 60000 });
  await available.getByTestId("remote-skill-select").check();
  await page.getByTestId("skill-import-submit").click();
  const row = page.locator('[data-testid="skill-row"][data-skill-name="find-skills"]');
  await expect(row).toBeVisible({ timeout: 60000 });
  await row.click();
  await expect(page.getByTestId("skill-sync")).toBeVisible();
  await page.getByTestId("skill-edit-file").click();
  const editor = page.getByTestId("skill-edit-content");
  await editor.press("Control+End");
  await page.keyboard.insertText("\n\nLocal customization: consult ORC's skill library first.\n");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/skills/find-skills/file") && response.request().method() === "PUT",
  );
  await page.getByTestId("skill-save-edit").click();
  expect((await saved).status()).toBe(200);
  await page.getByTestId("code-editor-preview-toggle").click();
  await expect(page.getByTestId("code-editor-markdown-preview")).toContainText(
    "Local customization:",
  );
  await page.reload();
  await page.getByTestId("code-editor-preview-toggle").click();
  await expect(page.getByTestId("code-editor-markdown-preview")).toContainText(
    "Local customization:",
  );
  await page.getByTestId("skill-sync").click();
  await expect(page.getByTestId("skill-sync-status")).toContainText("Local edits preserved", {
    timeout: 60000,
  });
  await page.reload();
  await page.getByTestId("code-editor-preview-toggle").click();
  await expect(page.getByTestId("code-editor-markdown-preview")).toContainText(
    "Local customization:",
  );
  await page.screenshot({ path: "../../.claude/skill-github-import-browser.png" });
});

test("shows conflicts and requires confirmation before sending an override", async ({
  page,
  request,
}) => {
  const name = tid("pw-sync");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: Sync confirmation fixture\n---\nInstructions`,
  });
  let overrideRequests = 0;
  await page.route(`**/api/skills/${name}/origin`, (route) =>
    route.fulfill({
      json: {
        repository: "vercel-labs/skills",
        ref: "main",
        path: "skills/find-skills",
        commit: "a".repeat(40),
        importedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route(`**/api/skills/${name}/sync`, (route) => {
    const input = route.request().postDataJSON();
    if (input.override) {
      overrideRequests++;
      expect(input.expectedCommit).toBe("b".repeat(40));
      expect(input.expectedRevision).toBe("c".repeat(64));
    }
    return route.fulfill({
      json: {
        applied: Boolean(input.override),
        commit: "b".repeat(40),
        revision: "c".repeat(64),
        changed: ["SKILL.md"],
        conflicts: ["SKILL.md"],
      },
    });
  });
  await gotoView(page, "skills");
  await page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`).click();
  await page.getByTestId("skill-sync").click();
  await expect(page.getByTestId("skill-sync-conflicts")).toContainText("SKILL.md");
  expect(overrideRequests).toBe(0);
  await page.getByTestId("skill-sync-review-override").click();
  await expect(page.getByTestId("skill-sync-confirm-override")).toBeVisible();
  expect(overrideRequests).toBe(0);
  await page.getByTestId("skill-sync-confirm-override").click();
  await expect(page.getByTestId("skill-sync-status")).toBeVisible();
  expect(overrideRequests).toBe(1);
});
