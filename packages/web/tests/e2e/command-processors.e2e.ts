import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiPost, gotoView } from "./_helpers";

test("should save a generic command processor, preview routing without execution, and reopen its settings", async ({
  page,
  request,
}, testInfo) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-command-processor-browser-"));
  await gotoView(page, "rules");
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rules-workspace").fill(workspace);
  await page.getByTestId("rules-reason").fill("Manage my command router");
  await page.getByTestId("rules-applied-tab").click();
  await page.getByTestId("rule-new").click();
  await page.getByTestId("event-rule-id").fill("my-command-router");
  await page.getByTestId("event-rule-reason").fill("My configured check");
  await page.getByTestId("rule-filter-field").first().fill("input.command");
  await page.getByTestId("rule-agent").selectOption("claude");
  await page.getByTestId("rule-filter-operator").selectOption("equals");
  await page.getByTestId("rule-filter-value").fill("git status");
  await page.getByTestId("rule-target").selectOption("rewrite_command");
  const argv = JSON.stringify(["my-custom-router", "{command}"]);
  await page.getByTestId("rule-processor-argv").fill(argv);
  await page.getByTestId("rule-processor-timeout").fill("1200");
  await page.getByTestId("rule-processor-rewrite-codes").fill("[0]");
  await page.getByTestId("rule-processor-passthrough-codes").fill("[4]");
  await page.getByTestId("event-rule-save").click();
  const revision = page.getByTestId("rule-revision").filter({ hasText: workspace });
  await expect(revision.getByTestId("saved-event-rule")).toContainText("rewrite command");
  const preview = await apiPost<{
    command_processors: { target: { argv: string[] } }[];
    updated_input?: unknown;
  }>(request, "/rules/check", {
    id: "browser-preview",
    session_id: "browser",
    backend: "claude",
    cwd: workspace,
    phase: "pre_tool",
    tool: "Bash",
    input: { command: "git status" },
  });
  expect(preview.command_processors[0]?.target.argv).toEqual(["my-custom-router", "{command}"]);
  expect(preview.updated_input).toBeUndefined();
  await page.reload();
  await revision.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("rule-target")).toHaveValue("rewrite_command");
  await expect(page.getByTestId("rule-processor-argv")).toHaveValue(
    JSON.stringify(JSON.parse(argv), null, 2),
  );
  await expect(page.getByTestId("rule-processor-timeout")).toHaveValue("1200");
  await expect(page.getByTestId("rule-processor-rewrite-codes")).toHaveValue("[0]");
  await expect(page.getByTestId("rule-processor-passthrough-codes")).toHaveValue("[4]");
  await page.getByTestId("rule-target-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("processor-editor.png") });
  await page.getByTestId("rule-agent").selectOption("codex");
  await expect(page.getByTestId("event-rule-save")).toBeDisabled();
});
