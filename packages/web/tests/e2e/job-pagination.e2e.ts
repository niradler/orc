import { expect, test } from "@playwright/test";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`late-page enabled jobs remain listed and selectable in Rules at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const prefix = tid("job-pages");
    const jobs: { id: string; name: string }[] = [];
    try {
      for (let batch = 0; batch < 11; batch++)
        jobs.push(
          ...(await Promise.all(
            Array.from({ length: batch === 10 ? 5 : 10 }, (_, i) =>
              apiPost<{ id: string; name: string }>(request, "/jobs", {
                name: `a-${prefix}-${String(batch * 10 + i).padStart(3, "0")}`,
                command: "echo pagination-fixture",
                trigger_type: "manual",
                enabled: true,
              }),
            ),
          )),
        );
      const late = await apiPost<{ id: string; name: string }>(request, "/jobs", {
        name: `zz-${prefix}`,
        command: "echo pagination-fixture",
        trigger_type: "manual",
        enabled: true,
      });
      jobs.push(late);
      const first = await apiGet<{ jobs: { id: string }[]; next_offset: number }>(
        request,
        "/jobs?enabled=true",
      );
      expect(first.jobs).toHaveLength(50);
      expect(first.jobs.some((job) => job.id === late.id)).toBe(false);
      expect(first.next_offset).toBe(50);
      await gotoView(page, "jobs");
      await page.getByTestId("job-search").fill(late.name);
      await expect(
        page.locator(`[data-testid="job-row"][data-job-id="${late.id}"]`).filter({ visible: true }),
      ).toBeVisible();
      await gotoView(page, "rules");
      await page.getByTestId("rule-new").click();
      await page.getByTestId("rule-target").selectOption("job");
      await page.getByTestId("rule-job").selectOption(late.id);
      await expect(page.getByTestId("rule-job")).toHaveValue(late.id);
      await page.getByTestId("rule-job").scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `../../.claude/docs/channels-job-pagination-${width}.png` });
    } finally {
      for (let offset = 0; offset < jobs.length; offset += 10)
        await Promise.all(
          jobs.slice(offset, offset + 10).map((job) => apiDelete(request, `/jobs/${job.id}`)),
        );
    }
  });
}
