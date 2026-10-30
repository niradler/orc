import { expect, test } from "@playwright/test";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import { apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

interface Job {
  id: string;
  name: string;
  command: string;
}

test.describe("Jobs CRUD", () => {
  test("create via UI then delete via UI", async ({ page, request }) => {
    const name = tid("pw-job");
    await gotoView(page, "jobs");
    await expect(page.getByTestId("view-title")).toHaveText(/jobs/i);

    await page.getByTestId("new-job-button").click();
    await revealFormField(page, page.getByTestId("job-name-input"));
    await page.getByTestId("job-name-input").fill(name);
    await revealFormField(page, page.getByTestId("job-command-input"));
    await page.getByTestId("job-command-input").fill("echo hello from pw");
    await openFinalFormStep(page);
    await page.getByTestId("job-submit").click();

    const row = page.locator(`[data-testid="job-row"][data-job-name="${name}"]`);
    await expect(row).toBeVisible();

    const id = await row.getAttribute("data-job-id");
    expect((await apiGet<Job>(request, `/jobs/${id}`)).name).toBe(name);

    await row.getByTestId("job-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(row).toHaveCount(0);

    await expect(apiGet<Job>(request, `/jobs/${id}`)).rejects.toThrow("404");
  });

  test("trigger via UI increments run count in API", async ({ page, request }) => {
    const name = tid("pw-job-run");
    const created = await apiPost<Job>(request, "/jobs", {
      name,
      command: "echo pw-trigger",
      trigger_type: "manual",
    });
    try {
      await gotoView(page, "jobs");
      const row = page.locator(`[data-testid="job-row"][data-job-id="${created.id}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId("job-trigger").click();

      await expect
        .poll(async () => {
          const result = await apiGet<{ runs: { status: string }[] }>(
            request,
            `/jobs/${created.id}/runs`,
          );
          return result.runs.some((run) => run.status === "success");
        })
        .toBe(true);
    } finally {
      await apiDelete(request, `/jobs/${created.id}`);
    }
  });
});
