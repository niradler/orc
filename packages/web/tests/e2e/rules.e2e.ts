import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiPost, gotoView } from "./_helpers";

test("workspace policy, history and human revert survive browser reload", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-rules-browser-"));
  try {
    await gotoView(page, "settings");
    await expect(page.getByTestId("rules-panel")).toHaveCount(0);
    await gotoView(page, "rules");
    await expect(page.getByTestId("rules-view")).toBeVisible();
    await expect(page.getByTestId("rules-panel")).toBeVisible();
    await page.getByTestId("rules-workspace").fill(workspace);
    await page.getByTestId("rule-protection-presets").click();
    await page.getByTestId("rules-comments").check();
    await page.getByTestId("rules-reason").fill("Browser policy creation");
    await page.getByTestId("rules-save").click();
    const revision = page.getByTestId("rule-revision").filter({ hasText: workspace });
    await expect(revision).toHaveCount(1);
    await expect(revision).toContainText("2 rules");
    const decision = await apiPost<{ decision: string }>(request, "/rules/check", {
      id: "browser-check",
      session_id: "browser",
      backend: "test",
      cwd: workspace,
      phase: "pre_tool",
      tool: "Bash",
      input: { command: "anything" },
    });
    expect(decision.decision).toBe("deny");
    await page.reload();
    await expect(revision).toContainText("Browser policy creation");
    await page.getByTestId("rules-reason").fill("Human browser revert");
    await revision.getByTestId("rule-revert").click();
    await expect(revision).toHaveCount(2);
    await expect(revision.filter({ hasText: "Human browser revert" })).toContainText("disabled");
    await page.reload();
    await expect(revision).toHaveCount(2);
    const after = await apiPost<{ decision: string }>(request, "/rules/check", {
      id: "after",
      session_id: "browser",
      backend: "test",
      cwd: workspace,
      phase: "pre_tool",
      tool: "Bash",
      input: {},
    });
    expect(after.decision).toBe("abstain");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("should save an all-agent regex rule and retain its scope/filter/target after reload and editing", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-event-rule-browser-"));
  try {
    await gotoView(page, "rules");
    await page.getByTestId("rules-workspace").fill(workspace);
    await page.getByTestId("rules-reason").fill("Shared regex policy");
    await page.getByTestId("event-rule-id").fill("block-rm-rf");
    await page.getByTestId("rule-filter-operator").selectOption("regex");
    await page.getByTestId("rule-filter-value").fill("\\brm\\s+-rf\\b");
    await page.getByTestId("event-rule-save").click();
    await expect(page.getByTestId("saved-event-rule")).toContainText("block-rm-rf");
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
    await page.getByTestId("event-rule-edit").click();
    await expect(page.getByTestId("rule-agent")).toHaveValue("all");
    await expect(page.getByTestId("rule-filter-operator")).toHaveValue("regex");
    await expect(page.getByTestId("rule-filter-value")).toHaveValue("\\brm\\s+-rf\\b");
    await page.getByTestId("rules-reason").fill("Limit rule to Codex");
    await page.getByTestId("rule-agent").selectOption("codex");
    await page.getByTestId("event-rule-save").click();
    await expect(page.getByTestId("saved-event-rule")).toHaveCount(1);
    await expect(page.getByTestId("saved-event-rule")).toContainText("codex");
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
      (await apiPost<{ decision: string }>(request, "/rules/check", { ...event, backend: "codex" }))
        .decision,
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
    await page.getByTestId("rules-workspace").fill(workspace);
    await page.getByTestId("rules-reason").fill("Context rule");
    await page.getByTestId("event-rule-id").fill("shared-target");
    await page.getByTestId("rule-event").selectOption("session_start");
    await page.getByTestId("rule-filter-field").fill("session_id");
    await page.getByTestId("rule-filter-operator").selectOption("exists");
    await page.getByTestId("rule-target").selectOption("inject_context");
    await page.getByTestId("rule-context").fill("Run checks before submitting");
    await page.getByTestId("event-rule-save").click();
    await expect(savedRule).toContainText("inject_context");
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
    await page.getByTestId("rules-reason").fill("Job target with same filter");
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
      await page.getByTestId("rules-reason").fill(`${mode} script with same filter`);
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
    await expect(page.getByTestId("rule-revision").filter({ hasText: workspace })).toHaveCount(4);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
