import { expect, test } from "@playwright/test";
import { apiDelete, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390, 320]) {
  test(`job results show output and open the exact native conversation ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const job = await apiPost<{ id: string }>(request, "/jobs", {
      name: tid("job-results"),
      trigger_type: "manual",
      action: { type: "agent", backend: "codex-cli", prompt: "Inspect the change" },
    });
    const now = new Date().toISOString();
    await page.route(`**/api/jobs/${job.id}/runs**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/logs"))
        return route.fulfill({
          json: {
            logs: [
              {
                id: 1,
                run_id: "result-run",
                ts: now,
                stream: "stdout",
                line: "Job inspection completed successfully",
              },
            ],
          },
        });
      if (path.endsWith("/session"))
        return route.fulfill({ json: { session_id: "job-native-conversation" } });
      return route.fulfill({
        json: {
          runs: [
            {
              id: "result-run",
              job_id: job.id,
              session_id: "job-audit-record",
              native_session_id: "provider-runtime-id",
              status: "success",
              trigger_by: "cron",
              started_at: now,
              ended_at: now,
              created_at: now,
              exit_code: 0,
              error_msg: null,
              retry_num: 0,
            },
          ],
        },
      });
    });
    await page.route("**/api/sessions/live**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/transcript"))
        return route.fulfill({
          json: {
            total: 1,
            offset: 0,
            matches: [],
            turns: [
              {
                index: 0,
                role: "assistant",
                time: now,
                blocks: [
                  { type: "text", text: "This is the exact conversation created by the job" },
                ],
              },
            ],
          },
        });
      if (path.endsWith("/usage")) return route.fulfill({ json: { latest: null, totals: null } });
      return route.fulfill({
        json: {
          sessions: [
            {
              id: "job-native-conversation",
              agent: "codex",
              session_id: "provider-runtime-id",
              name: "Job inspection",
              status: "stopped",
              cwd: "/demo/project",
              host: null,
              summary: "Inspection result",
              project_id: null,
              task: null,
              handoff: null,
              tokens_used: null,
              tokens_estimated: false,
              pid: null,
              created_at: now,
              last_activity_at: now,
              waiting_for_human: false,
            },
          ],
        },
      });
    });
    try {
      await gotoView(page, "jobs");
      await page
        .locator(`[data-testid="job-row"][data-job-id="${job.id}"]`)
        .getByTestId("job-open-detail")
        .click();
      await page.getByTestId("job-run-result").click();
      await expect(
        page.getByText("Job inspection completed successfully", { exact: true }),
      ).toBeVisible();
      await expect(page.getByTestId("job-run-session-link")).toHaveText("Session summary");
      const result = page.getByTestId("job-run-result");
      await expect(result).toBeInViewport();
      expect(await result.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expect(page.getByTestId("job-run-open-session")).toBeInViewport();
      await page.screenshot({ path: info.outputPath("job-run-results.png") });
      await page.getByTestId("job-run-open-session").click();
      await expect(page).toHaveURL(/\/sessions\?project=all&session=job-native-conversation/);
      await expect(page.getByTestId("live-session-detail")).toBeVisible();
      await expect(
        page.getByText("This is the exact conversation created by the job", { exact: true }),
      ).toBeVisible();
    } finally {
      await apiDelete(request, `/jobs/${job.id}`);
    }
  });
}
