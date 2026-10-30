import { expect, test } from "@playwright/test";
import { captureState } from "./_capture-state";
import { apiDelete, apiPost, gotoView, selectProject, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`Memory detail links respect the selected project at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const one = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("memory-scope-one"),
    });
    const two = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("memory-scope-two"),
    });
    const name = tid("scoped-memory");
    await apiPost(request, "/memories", {
      project_id: two.id,
      name,
      description: "Scope boundary",
      content: "# A second project fact",
    });
    try {
      await gotoView(page, "knowledge");
      const detail = `/knowledge/memories/${two.id}/${name}`;
      await page.goto(`${detail}?project=${one.id}`);
      await expect(page).toHaveURL(new RegExp(`/knowledge/memories\\?project=${one.id}`));
      await expect(page.getByTestId("memory-detail")).toHaveCount(0);
      await page.goto(`${detail}?project=unassigned`);
      await expect(page).toHaveURL(/\/knowledge\/memories\?project=unassigned/);
      await expect(page.getByTestId("memory-detail")).toHaveCount(0);
      await page.goto(`${detail}?project=all`);
      await expect(page.getByTestId("memory-detail")).toBeVisible();
      await expect(page.getByTestId("memory-detail-content")).toContainText(
        "A second project fact",
      );
      await page.keyboard.press("Escape");
      await page.goto(`${detail}?project=${two.id}`);
      await expect(page.getByTestId("memory-detail")).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      for (const project of [one, two]) await apiDelete(request, `/projects/${project.id}`);
    }
  });

  test(`Scratchpads follow the selected project and include shared pads at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const one = await apiPost<{ id: string }>(request, "/projects", { name: tid("pad-scope-one") });
    const two = await apiPost<{ id: string }>(request, "/projects", { name: tid("pad-scope-two") });
    const shared = await apiPost<{ id: string }>(request, "/scratchpads", {
      kind: "doc",
      title: tid("shared-pad"),
      project_id: null,
    });
    const first = await apiPost<{ id: string }>(request, "/scratchpads", {
      kind: "doc",
      title: tid("first-pad"),
      project_id: one.id,
    });
    const second = await apiPost<{ id: string }>(request, "/scratchpads", {
      kind: "doc",
      title: tid("second-pad"),
      project_id: two.id,
    });
    const row = (id: string) =>
      page.locator(`[data-testid="scratchpad-row"][data-scratchpad-id="${id}"]`);
    try {
      await gotoView(page, "scratchpads");
      await page.goto(`/scratchpad?project=${one.id}`);
      await expect(row(shared.id)).toBeVisible();
      await expect(row(first.id)).toBeVisible();
      await expect(row(second.id)).toHaveCount(0);
      await expect(row(shared.id)).toContainText("Global");
      await captureState(page, { path: testInfo.outputPath("project-and-global-pads.png") });

      await selectProject(page, "unassigned");
      await expect(row(shared.id)).toBeVisible();
      await expect(row(first.id)).toHaveCount(0);
      await expect(row(second.id)).toHaveCount(0);
      await page.reload();
      await expect(row(shared.id)).toBeVisible();
      await expect(row(first.id)).toHaveCount(0);

      await selectProject(page, "all");
      await expect(row(first.id)).toBeVisible();
      await expect(row(second.id)).toBeVisible();
      await page.goto(`/scratchpad?padProject=${two.id}`);
      await expect(page).toHaveURL(new RegExp(`project=${two.id}`));
      expect(new URL(page.url()).searchParams.has("padProject")).toBe(false);
      await expect(row(second.id)).toBeVisible();
      await expect(row(shared.id)).toBeVisible();
      await expect(row(first.id)).toHaveCount(0);
    } finally {
      for (const pad of [shared, first, second]) await apiDelete(request, `/scratchpads/${pad.id}`);
      for (const project of [one, two]) await apiDelete(request, `/projects/${project.id}`);
    }
  });

  test(`Knowledge hides unrelated bases and stale document links at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const one = await apiPost<{ id: string }>(request, "/projects", { name: tid("kb-scope-one") });
    const two = await apiPost<{ id: string }>(request, "/projects", { name: tid("kb-scope-two") });
    const shared = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
      name: tid("shared-kb"),
      project_id: null,
    });
    const first = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
      name: tid("first-kb"),
      project_id: one.id,
    });
    const second = await apiPost<{ id: string; name: string }>(request, "/kb/bases", {
      name: tid("second-kb"),
      project_id: two.id,
    });
    const firstDoc = await apiPost<{ id: string; title: string }>(
      request,
      `/kb/bases/${first.id}/documents`,
      { title: tid("first-doc"), content: "# First project\n\nVisible in its project." },
    );
    const secondDoc = await apiPost<{ id: string; title: string }>(
      request,
      `/kb/bases/${second.id}/documents`,
      { title: tid("second-doc"), content: "# Second project\n\nHidden in the first project." },
    );
    const row = (name: string) => page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`);
    async function browse() {
      const button = page.getByTestId("kb-browser-open");
      if (await button.isVisible()) await button.click();
    }
    try {
      await gotoView(page, "knowledge");
      await page.goto(`/knowledge/base?project=${one.id}&kb=${second.id}&document=${secondDoc.id}`);
      await expect.poll(() => new URL(page.url()).searchParams.get("document")).toBeNull();
      await expect(page.getByTestId("kb-document-title")).toHaveCount(0);
      await browse();
      await expect(row(shared.name)).toBeVisible();
      await expect(row(first.name)).toBeVisible();
      await expect(row(second.name)).toHaveCount(0);
      await captureState(page, { path: testInfo.outputPath("project-and-global-knowledge.png") });
      if (width < 1024) await page.keyboard.press("Escape");

      // A document in another *visible* KB still follows its own KB, rather than being dropped.
      await page.goto(`/knowledge/base?project=${one.id}&kb=${shared.id}&document=${firstDoc.id}`);
      await expect(page.getByTestId("kb-document-title")).toHaveText(firstDoc.title);
      await expect.poll(() => new URL(page.url()).searchParams.get("kb")).toBe(first.id);
      await selectProject(page, "unassigned");
      await browse();
      await expect(row(shared.name)).toBeVisible();
      await expect(row(first.name)).toHaveCount(0);
      await expect(row(second.name)).toHaveCount(0);
      if (width < 1024) await page.keyboard.press("Escape");
      await selectProject(page, "all");
      await browse();
      await expect(row(first.name)).toBeVisible();
      await expect(row(second.name)).toBeVisible();
    } finally {
      for (const kb of [shared, first, second]) await apiDelete(request, `/kb/bases/${kb.id}`);
      for (const project of [one, two]) await apiDelete(request, `/projects/${project.id}`);
    }
  });
}
