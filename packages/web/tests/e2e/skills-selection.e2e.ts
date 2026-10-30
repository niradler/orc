import { expect, test } from "@playwright/test";
import { captureState } from "./_capture-state";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, selectProject, tid } from "./_helpers";

for (const width of [1440, 390, 320]) {
  test(`skills show scope and enter multiselect explicitly at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
      name: tid("scope-project"),
    });
    const skills = [
      { name: "global-guidance", description: "Available across projects", project_ids: [] },
      {
        name: "scoped-guidance",
        description: "Instructions for the selected project",
        project_ids: [project.id],
      },
    ].map((skill) => ({
      ...skill,
      source: "builtin",
      path: skill.name,
      metadata: {},
      discovery_hidden: false,
    }));
    await page.route("**/api/skills?**", async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") ?? "";
      const displayed = skills.filter((skill) => skill.name.includes(q));
      await route.fulfill({
        json: {
          skills: displayed,
          total: displayed.length,
          offset: 0,
          limit: 30,
          next_offset: null,
          broken: [],
          warnings: [],
        },
      });
    });
    let release = () => {};
    let writes = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/skills/settings/visibility", async (route) => {
      if (route.request().method() === "PUT") {
        writes += 1;
        await pending;
        await route.fulfill({ json: route.request().postDataJSON() });
      } else await route.fulfill({ json: { hidden_skills: [], hidden_builtins: [] } });
    });
    await gotoView(page, "skills");
    const global = page.locator('[data-testid="skill-row"][data-skill-name="global-guidance"]');
    const scoped = page.locator('[data-testid="skill-row"][data-skill-name="scoped-guidance"]');
    await expect(global.getByTestId("skill-scope-cell")).toHaveText(/Global/);
    await expect(scoped.getByTestId("skill-scope-cell")).toHaveText(new RegExp(project.name));
    if (width === 1440)
      await expect(page.getByRole("columnheader", { name: "Scope", exact: true })).toBeVisible();
    await expect(page.getByTestId("skill-select")).toHaveCount(0);
    await expect(page.getByTestId("bulk-actions")).toHaveCount(0);
    expect(
      (await page.getByTestId("skill-search-input").boundingBox())?.width,
    ).toBeGreaterThanOrEqual(160);
    await captureState(page, { path: info.outputPath("skills-default.png") });
    await page.getByTestId("skills-multiselect").click();
    await expect(page.getByTestId("skills-multiselect")).toHaveCount(0);
    await expect(page.getByTestId("skill-select")).toHaveCount(2);
    if (width < 640) {
      const search = await page.getByTestId("skill-search-input").boundingBox();
      const selectDisplayed = await page.getByTestId("skills-select-displayed").boundingBox();
      expect(search?.width).toBeGreaterThanOrEqual(160);
      expect(selectDisplayed?.y).toBeGreaterThanOrEqual((search?.y ?? 0) + (search?.height ?? 0));
      const selectionTarget = await global
        .getByTestId("skill-select")
        .evaluate((input) => input.closest("label")?.getBoundingClientRect().height);
      expect(selectionTarget).toBeGreaterThanOrEqual(44);
      expect(
        (await page.getByTestId("skills-select-displayed").boundingBox())?.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId("skills-select-displayed").click();
    await expect(page.getByTestId("bulk-actions")).toContainText("2 selected");
    await page.getByTestId("clear-selection").click();
    await expect(page.getByTestId("bulk-actions")).toHaveCount(0);
    await global.getByTestId("skill-select").check();
    await page.getByTestId("skill-search-input").fill("scoped");
    await expect(page.getByTestId("skill-row")).toHaveCount(1);
    await expect(page.getByTestId("bulk-actions")).toHaveCount(0);
    await expect(scoped.getByTestId("skill-select")).not.toBeChecked();
    // An empty search result must not strand the user in selection mode without an exit.
    await page.getByTestId("skill-search-input").fill("no-matching-skill");
    await expect(page.getByTestId("skill-row")).toHaveCount(0);
    await page.getByTestId("skills-multiselect-exit").click();
    await page.getByTestId("skill-search-input").fill("");
    await expect(page.getByTestId("skill-row")).toHaveCount(2);
    await expect(page.getByTestId("skill-select")).toHaveCount(0);
    await page.getByTestId("skills-multiselect").click();
    await expect(page.getByTestId("clear-selection")).toBeDisabled();
    expect(writes).toBe(0);
    await page.getByTestId("skills-select-displayed").click();
    await selectProject(page, project.id);
    await expect(page.getByTestId("bulk-actions")).toHaveCount(0);
    await expect(page.getByTestId("skill-select").first()).not.toBeChecked();
    await page.getByTestId("skills-select-displayed").click();
    await captureState(page, { path: info.outputPath("skills-multiselect.png") });
    if (width === 390) {
      const toggle = page.getByTestId("theme-toggle");
      const wasDark = (await toggle.getAttribute("aria-label")) === "Switch to light theme";
      if (!wasDark) {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
      }
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-label", "Switch to dark theme");
      await page.mouse.move(0, 0);
      await captureState(page, {
        path: info.outputPath("skills-multiselect-light.png"),
        animations: "disabled",
      });
      if (wasDark) {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
      }
    }
    await page.getByTestId("skills-bulk-hide").click();
    await expect(page.getByTestId("skills-select-displayed")).toBeDisabled();
    await expect(page.getByTestId("clear-selection")).toBeDisabled();
    await expect(page.getByTestId("skills-multiselect-exit")).toBeDisabled();
    await expect(global.getByTestId("skill-select")).toBeDisabled();
    release();
    await expect(page.getByTestId("skills-bulk-result")).toContainText("2 hidden.");
    expect(writes).toBe(1);
    await expect(page.getByTestId("skill-select").first()).not.toBeChecked();
    await page.getByTestId("skills-multiselect-exit").click();
    await expect(page.getByTestId("skill-select")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [1440, 390]) {
  test(`All projects opens assigned skill instructions and guards context switches at ${width}px`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const projectOne = await apiPost<{ id: string; name: string }>(request, "/projects", {
      name: tid("first-instructions"),
    });
    const projectTwo = await apiPost<{ id: string; name: string }>(request, "/projects", {
      name: tid("second-instructions"),
    });
    const [first, second] = [projectOne, projectTwo].sort((left, right) =>
      left.id < right.id ? -1 : 1,
    );
    const name = tid("assigned-instructions");
    await apiPost(request, "/skills", {
      name,
      content: `---\nname: ${name}\ndescription: Project instruction contexts\n---\nBaseline instructions.`,
    });
    const assigned = await request.put(`${API_BASE}/skills/${name}/projects`, {
      headers: AUTH_HEADERS,
      data: { project_ids: [second.id, first.id] },
    });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    for (const [project, marker] of [
      [first, "First project instructions"],
      [second, "Second project instructions"],
    ] as const) {
      // SkillFull.content is the body; audited instruction edits require the complete source file.
      const original = await apiGet<{ content: string }>(
        request,
        `/skills/${name}?project_id=${project.id}&ref=SKILL.md`,
      );
      const updated = await request.put(`${API_BASE}/skills/${name}/instructions`, {
        headers: AUTH_HEADERS,
        data: {
          project_id: project.id,
          content: `${original.content}\n${marker}`,
          expected_content: original.content,
          reason: "Browser scope fixture",
          author: "human",
        },
      });
      expect(updated.ok(), await updated.text()).toBe(true);
    }
    const reads: string[] = [];
    const missing: string[] = [];
    let writes = 0;
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.pathname === `/api/skills/${name}` && req.method() === "GET") {
        expect(url.searchParams.get("scope")).not.toBe("all");
        reads.push(url.searchParams.get("project_id") ?? "global");
      }
      if (url.pathname.startsWith(`/api/skills/${name}`) && req.method() !== "GET") writes += 1;
    });
    page.on("response", (response) => {
      if (response.status() === 404 && response.url().includes(`/api/skills/${name}`))
        missing.push(response.url());
    });
    await gotoView(page, "skills");
    await selectProject(page, "all");
    await page.getByTestId("skill-search-input").fill(name);
    const row = page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("skill-scope-cell")).toContainText(first.name);
    await expect(row.getByTestId("skill-scope-cell")).toContainText(second.name);
    await row.getByTestId("skill-open").click();
    const context = page.getByTestId("skill-instruction-project");
    await expect(context).toHaveValue(first.id);
    await expect(page.getByTestId("markdown-preview")).toContainText("First project instructions");
    await context.selectOption(second.id);
    await expect(page).toHaveURL(new RegExp(`skillProject=${second.id}`));
    await expect(page.getByTestId("markdown-preview")).toContainText("Second project instructions");
    await page.reload();
    await expect(context).toHaveValue(second.id);
    await expect(page.getByTestId("markdown-preview")).toContainText("Second project instructions");
    await page.getByTestId("markdown-mode-edit").click();
    const editor = page.getByTestId("skill-file-content");
    await editor.click();
    await editor.press("Control+End");
    await page.keyboard.insertText("\nUnsaved project draft");
    await expect(editor).toContainText("Unsaved project draft");
    page.once("dialog", (dialog) => dialog.dismiss());
    await context.selectOption(first.id);
    await expect(context).toHaveValue(second.id);
    await expect(editor).toContainText("Unsaved project draft");
    page.once("dialog", (dialog) => dialog.accept());
    await context.selectOption(first.id);
    await expect(context).toHaveValue(first.id);
    await expect(editor).toContainText("First project instructions");
    await expect(editor).not.toContainText("Unsaved project draft");
    // A stale or unrelated skillProject URL may never become a read context.
    const url = new URL(page.url());
    url.searchParams.set("skillProject", "unrelated-project");
    await page.goto(url.toString());
    await expect(context).toHaveValue(first.id);
    await expect(page.getByTestId("skill-file-content")).toContainText(
      "First project instructions",
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((id) => id === first.id || id === second.id)).toBe(true);
    expect(missing).toEqual([]);
    expect(writes).toBe(0);
    await captureState(page, { path: info.outputPath("skills-assigned-instructions.png") });
  });
}
