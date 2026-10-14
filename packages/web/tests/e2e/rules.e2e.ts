import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiPost, gotoView } from "./_helpers";

test("should save an all-agent regex rule and retain its scope/filter/target after reload and editing", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-event-rule-browser-"));
  const savedRule = page
    .getByTestId("rule-revision")
    .filter({ hasText: workspace })
    .getByTestId("saved-event-rule");
  try {
    await gotoView(page, "rules");
    await page.getByTestId("rules-settings-tab").click();
    await page.getByTestId("rules-workspace").fill(workspace);
    await page.getByTestId("rules-reason").fill("Shared regex policy");
    await expect(page.getByTestId("event-rule-editor")).toHaveCount(0);
    await page.getByTestId("rules-applied-tab").click();
    await page.getByTestId("rule-new").click();
    await page.getByTestId("event-rule-id").fill("block-rm-rf");
    await page.getByTestId("event-rule-reason").fill("My configured check");
    await page.getByTestId("rule-filter-field").first().fill("input.command");
    await page.getByTestId("rule-filter-operator").selectOption("regex");
    await page.getByTestId("rule-filter-value").fill("\\brm\\s+-rf\\b");
    await page.getByTestId("event-rule-save").click();
    await expect(savedRule).toContainText("block-rm-rf");
    for (const backend of ["claude", "cursor", "gemini", "codex"]) {
      const base = {
        id: `probe-${backend}`,
        session_id: "browser",
        backend,
        cwd: workspace,
        phase: "pre_tool",
        tool: "Bash",
      };
      expect(
        (
          await apiPost<{ decision: string }>(request, "/rules/check", {
            ...base,
            input: { command: "rm -rf build" },
          })
        ).decision,
      ).toBe("deny");
      expect(
        (
          await apiPost<{ decision: string }>(request, "/rules/check", {
            ...base,
            input: { command: "bun test" },
          })
        ).decision,
      ).toBe("abstain");
    }
    await page.reload();
    await savedRule.getByTestId("event-rule-edit").click();
    await expect(page.getByTestId("rule-agent")).toHaveValue("all");
    await expect(page.getByTestId("rule-filter-operator")).toHaveValue("regex");
    await expect(page.getByTestId("rule-filter-value")).toHaveValue("\\brm\\s+-rf\\b");
    await page.getByTestId("rule-agent").selectOption("codex");
    await page.getByTestId("event-rule-save").click();
    await expect(savedRule).toHaveCount(1);
    await expect(savedRule).toContainText("codex");
    const event = {
      id: "specific",
      session_id: "browser",
      cwd: workspace,
      phase: "pre_tool",
      tool: "Bash",
      input: { command: "rm -rf build" },
    };
    expect(
      (
        await apiPost<{ decision: string }>(request, "/rules/check", {
          ...event,
          backend: "claude",
        })
      ).decision,
    ).toBe("abstain");
    expect(
      (
        await apiPost<{ decision: string }>(request, "/rules/check", {
          ...event,
          backend: "codex",
        })
      ).decision,
    ).toBe("deny");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("should reuse filters for context, job, and both script targets while retaining policy history", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-rule-targets-browser-"));
  const policy = page.getByTestId("rule-revision").filter({ hasText: workspace });
  const savedRule = policy.getByTestId("saved-event-rule");
  try {
    const job = await apiPost<{ id: string }>(request, "/jobs", {
      name: `rule-job-${Date.now()}`,
      command: "echo validated",
      trigger_type: "manual",
    });
    await gotoView(page, "rules");
    await page.getByTestId("rules-settings-tab").click();
    await page.getByTestId("rules-workspace").fill(workspace);
    await page.getByTestId("rules-reason").fill("Context rule");
    await page.getByTestId("rules-applied-tab").click();
    await page.getByTestId("rule-new").click();
    await page.getByTestId("event-rule-id").fill("shared-target");
    await page.getByTestId("event-rule-reason").fill("My configured check");
    await page.getByTestId("rule-filter-field").first().fill("input.command");
    await page.getByTestId("rule-event").selectOption("session_start");
    await page.getByTestId("rule-filter-field").fill("session_id");
    await page.getByTestId("rule-filter-operator").selectOption("exists");
    await page.getByTestId("rule-target").selectOption("inject_context");
    await page.getByTestId("rule-context").fill("Run checks before submitting");
    await page.getByTestId("event-rule-save").click();
    await expect(savedRule).toContainText("inject context");
    const base = {
      id: "target-probe",
      session_id: "browser",
      backend: "claude",
      cwd: workspace,
      phase: "session_start",
      input: {},
    };
    expect((await apiPost<{ context: string[] }>(request, "/rules/check", base)).context).toEqual([
      "Run checks before submitting",
    ]);
    await savedRule.getByTestId("event-rule-edit").click();
    await page.getByTestId("rule-target").selectOption("job");
    await page.getByTestId("rule-job").selectOption(job.id);
    await page.getByTestId("event-rule-save").click();
    await expect(savedRule).toContainText("job");
    expect(
      (await apiPost<{ jobs: { job_id: string }[] }>(request, "/rules/check", base)).jobs[0]
        ?.job_id,
    ).toBe(job.id);
    for (const mode of ["sync", "background"]) {
      await savedRule.getByTestId("event-rule-edit").click();
      await page.getByTestId("rule-target").selectOption("script");
      await page.getByTestId("rule-script-mode").selectOption(mode);
      await page
        .getByTestId("rule-script-argv")
        .fill(JSON.stringify([process.execPath, "-e", "console.log('{}')"]));
      await page.getByTestId("event-rule-save").click();
      await expect(savedRule).toHaveCount(1);
      const check = await apiPost<{ scripts: { target: { mode: string } }[] }>(
        request,
        "/rules/check",
        base,
      );
      expect(check.scripts[0]?.target.mode).toBe(mode);
    }
    await page.reload();
    await savedRule.getByTestId("event-rule-edit").click();
    await expect(page.getByTestId("rule-script-mode")).toHaveValue("background");
    await expect(page.getByTestId("rule-filter-operator")).toHaveValue("exists");
    await page.getByTestId("sheet-close").click();
    await page.getByTestId("rules-settings-tab").click();
    await page.getByTestId("rules-history").locator("summary").first().click();
    await expect(page.getByTestId("rule-history-entry").filter({ hasText: workspace })).toHaveCount(
      4,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
