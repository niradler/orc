import { expect, test } from "@playwright/test";
import { apiGet, gotoView, tid } from "./_helpers";

for (const [width, theme] of [
  [1440, "dark"],
  [390, "light"],
] as const) {
  test(`job settings save/reopen with schedule, shell and write-only secrets ${width} ${theme}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem("orc_theme", value), theme);
    await gotoView(page, "jobs");
    await page.getByTestId("new-job-button").click();
    const name = tid("configured-job");
    await page.getByTestId("job-name-input").fill(name);
    await page.getByTestId("job-trigger-type").selectOption("cron");
    await page.getByLabel("Run at", { exact: true }).fill("10:45");
    await page.getByLabel("Timezone", { exact: true }).fill("Asia/Jerusalem");
    await page.getByRole("checkbox", { name: "Advanced cron" }).check();
    await expect(page.getByLabel("Cron expression", { exact: true })).toHaveValue(
      "45 10 * * 1,2,3,4,5",
    );
    await page.getByRole("checkbox", { name: "Advanced cron" }).uncheck();
    await page.screenshot({ path: info.outputPath("job-trigger.png") });
    await page.getByTestId("form-step-destination").click();
    await page.getByTestId("job-command-input").fill("echo configured");
    await page.getByTestId("job-host").selectOption("__local__");
    await page.getByTestId("job-shell").selectOption("Custom");
    await page.getByLabel("Executable or path", { exact: true }).fill("sh");
    await expect(page.getByLabel("Arguments (one per line)", { exact: true })).toBeVisible();
    await page.getByLabel("Executable or path", { exact: true }).fill("/custom/interpreter");
    await page.getByTestId("job-shell").selectOption("bash");
    await page.screenshot({ path: info.outputPath("job-destination.png") });
    await page.getByTestId("form-step-settings").click();
    await page.getByText("Environment variables", { exact: true }).click();
    await page.getByTestId("job-env-add").click();
    await page.getByLabel("Variable 1 name", { exact: true }).fill("DEMO_KEY");
    await page
      .getByLabel("Variable 1 value", { exact: true })
      .fill("fixture-value-for-secret-test");
    await page.getByRole("checkbox", { name: "Secret", exact: true }).check();
    await page.screenshot({ path: info.outputPath("job-settings.png") });
    await page.getByTestId("job-submit").click();
    await expect(page.getByTestId("form-dialog")).toHaveCount(0);
    const { jobs } = await apiGet<{
      jobs: Array<{
        id: string;
        name: string;
        cron_expr: string;
        settings: { host: string | null; timezone: string; shell: { executable: string } };
        environment: Array<{ name: string; value: string | null; secret: boolean }>;
      }>;
    }>(request, "/jobs");
    const saved = jobs.find((job) => job.name === name);
    expect(saved).toBeDefined();
    if (!saved) throw new Error("Saved job is missing");
    expect(saved.cron_expr).toBe("45 10 * * 1,2,3,4,5");
    expect(saved.settings).toMatchObject({
      host: null,
      timezone: "Asia/Jerusalem",
      shell: { executable: "bash" },
    });
    expect(saved.environment).toEqual([{ name: "DEMO_KEY", value: null, secret: true }]);
    await page.reload();
    await page
      .locator(`[data-testid="job-row"][data-job-id="${saved.id}"]`)
      .getByTestId("job-edit")
      .click();
    await expect(page.getByLabel("Run at", { exact: true })).toHaveValue("10:45");
    await page.getByTestId("form-step-settings").click();
    await page.getByText("Environment variables (1)", { exact: true }).click();
    await expect(page.getByLabel("Variable 1 value", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Variable 1 value", { exact: true })).toHaveAttribute(
      "placeholder",
      /Saved secret/,
    );
    await page.getByTestId("job-edit-submit").click();
    await expect(page.getByTestId("form-dialog")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("new agent job defaults to an isolated worktree and retains configuration across tabs", async ({
  page,
}, info) => {
  await gotoView(page, "jobs");
  await page.getByTestId("new-job-button").click();
  await page.getByTestId("job-name-input").fill(tid("agent-workspace"));
  await page.getByTestId("form-step-destination").click();
  await page.getByTestId("job-action-type").selectOption("agent");
  await expect(
    page.getByTestId("form-dialog").getByLabel("Workspace", { exact: true }),
  ).toHaveValue("worktree");
  await expect(page.getByTestId("job-cleanup")).not.toBeChecked();
  await page.getByTestId("job-cleanup").check();
  await page.getByTestId("job-base-ref").fill("origin/main");
  await page.getByTestId("job-agent-prompt").fill("Review incoming issues");
  await page.getByTestId("form-step-settings").click();
  await page.getByTestId("form-step-destination").click();
  await expect(page.getByTestId("job-cleanup")).toBeChecked();
  await expect(page.getByTestId("job-base-ref")).toHaveValue("origin/main");
  await expect(page.getByTestId("job-agent-prompt")).toHaveValue("Review incoming issues");
  await page.getByTestId("form-dialog").screenshot({ path: info.outputPath("job-agent.png") });
  await page.getByTestId("job-cleanup").scrollIntoViewIfNeeded();
  await page.getByTestId("form-dialog").screenshot({ path: info.outputPath("job-worktree.png") });
});

for (const width of [1440, 390]) {
  test(`job uses Chat agent/model menus and persists host-aware model choices ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const queriedHosts: string[] = [];
    await page.route("**/api/chat/models?**", async (route) => {
      const url = new URL(route.request().url());
      queriedHosts.push(url.searchParams.get("host") ?? "inherit");
      const agent = url.searchParams.get("agent");
      await route.fulfill({
        json: {
          models: [{ id: `${agent}-fixture`, label: `${agent} fixture model` }],
          warning: null,
        },
      });
    });
    await gotoView(page, "jobs");
    await page.getByTestId("new-job-button").click();
    const name = tid("picker-job");
    await page.getByTestId("job-name-input").fill(name);
    await page.getByTestId("form-step-destination").click();
    await page.getByTestId("job-action-type").selectOption("agent");
    await page.getByTestId("job-host").selectOption("__local__");
    await page.getByTestId("job-agent-model-button").click();
    await expect(page.getByTestId("job-agent-option-codex")).toBeVisible();
    await expect(page.getByTestId("job-model-option-codex-fixture")).toBeVisible();
    await page.getByTestId("job-agent-option-claude").click();
    await page.getByTestId("job-model-option-claude-fixture").click();
    await expect(page.getByTestId("job-model-current")).toContainText("claude fixture model");
    expect(queriedHosts).toContain("__local__");
    await page.getByTestId("job-agent-prompt").fill("Inspect the incoming event");
    await page.getByTestId("job-agent-model-button").click();
    await page.screenshot({ path: info.outputPath("job-agent-picker.png") });
    await page.keyboard.press("Escape");
    await page.getByTestId("form-step-settings").click();
    await page.getByTestId("job-submit").click();
    await expect(page.getByTestId("form-dialog")).toHaveCount(0);
    const { jobs } = await apiGet<{
      jobs: { id: string; name: string; action: { backend: string; model: string } }[];
    }>(request, "/jobs");
    const saved = jobs.find((job) => job.name === name);
    if (!saved) throw new Error("Saved job missing");
    expect(saved.action).toMatchObject({ backend: "claude", model: "claude-fixture" });
    await page.reload();
    await page
      .locator(`[data-testid="job-row"][data-job-id="${saved.id}"]`)
      .getByTestId("job-edit")
      .click();
    await page.getByTestId("form-step-destination").click();
    await expect(page.getByTestId("job-agent-current")).toHaveText("Claude Code");
    await expect(page.getByTestId("job-model-current")).toHaveText("claude fixture model");
  });
}
