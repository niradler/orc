import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import { apiDelete, apiGet, apiPost, gotoView, selectProject, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`projects beyond page one remain editable and selectable at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const prefix = tid("pagination");
    const projects: { id: string; name: string }[] = [];
    const offsets: number[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/projects" && request.method() === "GET")
        offsets.push(Number(url.searchParams.get("offset") ?? 0));
    });
    try {
      for (let batch = 0; batch < 11; batch++) {
        projects.push(
          ...(await Promise.all(
            Array.from({ length: batch === 10 ? 5 : 10 }, (_, i) =>
              apiPost<{ id: string; name: string }>(request, "/projects", {
                name: `${prefix}-${String(batch * 10 + i).padStart(3, "0")}`,
              }),
            ),
          )),
        );
      }
      const late = await apiPost<{ id: string; name: string }>(request, "/projects", {
        name: `zz-${prefix}`,
      });
      projects.push(late);
      const first = await apiGet<{ projects: { id: string }[]; next_offset: number }>(
        request,
        "/projects",
      );
      expect(first.projects).toHaveLength(50);
      expect(first.projects.some((project) => project.id === late.id)).toBe(false);
      expect(first.next_offset).toBe(50);

      await gotoView(page, "projects");
      const search = page.getByRole("searchbox", { name: "Search projects" });
      await search.fill(late.name);
      const row = page.locator(`[data-testid="project-row"][data-project-id="${late.id}"]`);
      await expect(row).toBeVisible();
      expect(offsets).toContain(100);
      await row.click();
      await revealFormField(page, "edit-project-name-input");
      const renamed = `${late.name}-edited`;
      await page.getByTestId("edit-project-name-input").fill(renamed);
      await openFinalFormStep(page);
      await page.getByTestId("edit-project-submit").click();
      await expect(page.getByTestId("edit-project-dialog")).toBeHidden();
      await expect(row).toContainText(renamed);
      await page.reload();
      await page.getByRole("searchbox", { name: "Search projects" }).fill(renamed);
      await expect(row).toContainText(renamed);
      await selectProject(page, late.id);
      await expect(page.getByTestId("sidebar-project-select").first()).toHaveAttribute(
        "data-project-id",
        late.id,
      );

      await gotoView(page, "rules");
      await page.getByTestId("rules-settings-tab").click();
      await page.getByTestId("rule-policy-project").selectOption(late.id);
      await expect(page.getByTestId("rule-policy-project")).toHaveValue(late.id);

      await gotoView(page, "settings");
      await settingsSection(page, "channels");
      await page.getByTestId("channel-add").click();
      const editor = page.getByTestId("channel-editor").filter({ visible: true });
      await editor
        .locator("summary")
        .filter({ hasText: /^Inbound routing/ })
        .click();
      await editor.getByRole("button", { name: "Add routing rule", exact: true }).click();
      await editor.getByTestId("channel-route-project").selectOption(late.id);
      await expect(editor.getByTestId("channel-route-project")).toHaveValue(late.id);
      await editor.getByTestId("channel-route-project").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `../../.claude/docs/channels-project-pagination-${width}.png`,
      });
    } finally {
      await Promise.all(projects.map((project) => apiDelete(request, `/projects/${project.id}`)));
    }
  });
}
