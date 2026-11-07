import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

for (const width of [1440, 390]) {
  for (const theme of ["dark", "light"] as const) {
    test(`audit events are scoped, compact and disclose safe metadata in ${theme} at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("orc_theme", value), theme);
      const scopes: Array<string | null> = [];
      const snapshotModes: Array<string | null> = [];
      const entries = [
        {
          id: "audit-notification",
          created_at: 1794000000,
          action: "notification.created",
          entity_type: "notification",
          project_id: null,
          actor: null,
          session_id: null,
          subject_ids: ["notification-one"],
          result_ids: [],
          note: null,
          snapshot: {
            type: "job.finished",
            unsafe_markup: "<script>window.__auditUnsafe=true</script>",
            long_value: "a".repeat(12000),
          },
        },
        {
          id: "audit-task",
          created_at: 1793999990,
          action: "task.status_changed",
          entity_type: "task",
          project_id: "demo-project",
          actor: null,
          session_id: null,
          subject_ids: ["task-one"],
          result_ids: [],
          note: null,
          snapshot: { before: "doing", after: "done" },
        },
      ];
      await page.route("**/api/audit?**", (route) => {
        const params = new URL(route.request().url()).searchParams;
        scopes.push(params.get("scope"));
        snapshotModes.push(params.get("snapshot"));
        const type = params.get("entity_type");
        return route.fulfill({
          json: { entries: type ? entries.filter((entry) => entry.entity_type === type) : entries },
        });
      });
      await gotoView(page, "activity");
      await page.goto("/audit?project=all");
      const audit = page.getByTestId("audit-events");
      await expect(audit.getByTestId("audit-event")).toHaveCount(2);
      await expect(audit).toContainText("Up to 100 newest events");
      await expect(page.getByTestId("audit-session-history")).toHaveJSProperty("open", false);
      await expect(page.getByTestId("audit-event-metadata")).toHaveCount(0);
      await audit.getByTestId("audit-event").first().locator("summary").click();
      const metadata = page.getByTestId("audit-event-metadata");
      await expect(metadata).toContainText("<script>window.__auditUnsafe=true</script>");
      expect((await metadata.innerText()).length).toBeLessThan(1000);
      expect(await page.evaluate(() => "__auditUnsafe" in window)).toBe(false);
      if (width < 1024) await page.getByTestId("view-filters-toggle").click();
      await page.getByTestId("audit-event-filter").selectOption("notification");
      await expect(audit.getByTestId("audit-event")).toHaveCount(1);
      await expect(page).toHaveURL(/auditEntity=notification/);
      expect(scopes.every((scope) => scope === "all")).toBe(true);
      expect(snapshotModes.every((mode) => mode === "preview")).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`audit-${theme}-${width}.png`),
        animations: "disabled",
      });
      await page.goto("/audit?project=all#records");
      await expect(page.getByTestId("audit-session-history")).toHaveJSProperty("open", true);
    });
  }
}
