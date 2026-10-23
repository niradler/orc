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
  await page.getByTestId("select-all-rows").check();
  await expect(available.getByTestId("remote-skill-select")).toBeChecked();
  await page.getByTestId("skill-import-submit").click();
  const row = page.locator('[data-testid="skill-row"][data-skill-name="find-skills"]');
  await expect(row).toBeVisible({ timeout: 60000 });
  await row.click();
  await expect(page.getByTestId("skill-sync")).toBeVisible();
  await page.getByTestId("markdown-mode-edit").click();
  // The source editor stays mounted (hidden) in read mode; keys sent before edit mode renders are lost.
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  const editor = page.getByTestId("skill-file-content");
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\n\nLocal customization: consult ORC's skill library first.\n");
  await expect(editor).toContainText("Local customization:");
  await expect(page.getByTestId("document-save")).toBeEnabled();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/skills/find-skills/file") && response.request().method() === "PUT",
  );
  await page.getByTestId("document-save").click();
  expect((await saved).status()).toBe(200);
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Local customization:");
  await page.reload();
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Local customization:");
  await page.getByTestId("skill-sync").click();
  await expect(page.getByTestId("skill-sync-status")).toContainText("Local edits preserved", {
    timeout: 60000,
  });
  await page.reload();
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Local customization:");
  await gotoView(page, "skills");
  await expect(row.getByTestId("skill-select")).toBeVisible();
  await row.getByTestId("skill-select").check();
  await page.getByTestId("skills-bulk-sync").click();
  await expect(page.getByTestId("skills-bulk-result")).toContainText("1 synced; 0 need attention", {
    timeout: 60000,
  });
  await row.click();
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Local customization:");
  await page.screenshot({ path: "../../.claude/skill-github-import-browser.png" });
});

test("selects all new skills, imports in bounded batches and retains failed selections", async ({
  page,
}) => {
  const skills = Array.from({ length: 19 }, (_, index) => ({
    name: `batch-skill-${index}`,
    description: "Batch selection fixture",
    path: `skills/${index}`,
    installed: index === 0,
  }));
  await page.route("**/api/skills/discover", (route) =>
    route.fulfill({
      json: {
        repository: "acme/skills",
        ref: "HEAD",
        path: "",
        commit: "a".repeat(40),
        skills,
        issues: [],
      },
    }),
  );
  const batches: string[][] = [];
  await page.route("**/api/skills/import", (route) => {
    const { paths } = route.request().postDataJSON();
    batches.push(paths);
    if (batches.length === 2)
      return route.fulfill({ status: 400, json: { error: "Temporary import failure" } });
    return route.fulfill({ json: { skills: [] } });
  });
  await gotoView(page, "skills");
  await page.getByTestId("import-skill-button").click();
  await page.getByTestId("skill-repository-input").fill("acme/skills");
  await page.getByTestId("skill-discover").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("remote-skill")).toHaveCount(19);
  await dialog.getByTestId("select-all-rows").check();
  await expect(dialog.getByTestId("remote-skill-select").first()).toBeDisabled();
  await expect(dialog.getByTestId("remote-skill-select").first()).not.toBeChecked();
  await expect(dialog.getByTestId("skill-import-submit")).toContainText("18");
  await dialog.getByTestId("select-all-rows").uncheck();
  await expect(dialog.getByTestId("skill-import-submit")).toBeDisabled();
  await dialog.getByTestId("select-all-rows").check();
  await dialog.getByTestId("skill-import-submit").click();
  await expect(dialog.getByRole("alert")).toContainText("16 imported; 2 failed");
  expect(batches.map((batch) => batch.length)).toEqual([16, 2]);
  expect(batches.flat()).not.toContain("skills/0");
  await expect(dialog.getByTestId("skill-import-submit")).toContainText("2");
  await expect(dialog.getByTestId("remote-skill-select").nth(1)).toBeDisabled();
  await dialog.getByTestId("skill-import-submit").click();
  await expect(dialog).toHaveCount(0);
  expect(batches[2]).toEqual(batches[1]);
});

test("bulk sync selects only GitHub skills and retains conflicts without overriding", async ({
  page,
  request,
}) => {
  const prefix = tid("bulk-sync");
  const names = [`${prefix}-ok`, `${prefix}-conflict`, `${prefix}-local`];
  for (const name of names)
    await apiPost(request, "/skills", {
      name,
      content: `---\nname: ${name}\ndescription: Bulk sync fixture\n---\nInstructions`,
    });
  for (const name of names.slice(0, 2))
    await page.route(`**/api/skills/${name}/origin`, (route) =>
      route.fulfill({
        json: {
          repository: "acme/skills",
          ref: "HEAD",
          path: name,
          commit: "a".repeat(40),
          importedAt: new Date().toISOString(),
        },
      }),
    );
  const synced: string[] = [];
  for (const name of names.slice(0, 2))
    await page.route(`**/api/skills/${name}/sync`, (route) => {
      expect(route.request().postDataJSON()).toEqual({});
      synced.push(name);
      return route.fulfill({
        json: {
          applied: name === names[0],
          commit: "b".repeat(40),
          revision: "c".repeat(64),
          conflicts: name === names[0] ? [] : ["SKILL.md"],
          changed: [],
        },
      });
    });
  await gotoView(page, "skills");
  await page.getByTestId("skill-search-input").fill(prefix);
  await page.getByTestId("skill-search-submit").click();
  await expect(page.getByTestId("skill-row")).toHaveCount(3);
  await expect(page.getByTestId("skill-select")).toHaveCount(2);
  await expect(page.getByTestId("select-all-rows")).toBeEnabled();
  await page.getByTestId("select-all-rows").check();
  await page.getByTestId("skills-bulk-sync").click();
  await expect(page.getByTestId("skills-bulk-result")).toContainText("1 synced; 1 need attention");
  expect(synced.sort()).toEqual(names.slice(0, 2).sort());
  await expect(
    page
      .locator(`[data-testid="skill-row"][data-skill-name="${names[0]}"]`)
      .getByTestId("skill-select"),
  ).not.toBeChecked();
  await expect(
    page
      .locator(`[data-testid="skill-row"][data-skill-name="${names[1]}"]`)
      .getByTestId("skill-select"),
  ).toBeChecked();
  await page.screenshot({ path: "../../output/playwright/skills-bulk-sync.png", fullPage: true });
  await page.getByTestId("skill-source-builtin").click();
  await expect(page.getByTestId("skills-bulk-result")).toHaveCount(0);
  await page.getByTestId("skill-source-all").click();
  await expect(page.getByTestId("skill-select").first()).not.toBeChecked();
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
