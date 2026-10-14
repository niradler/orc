import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiPost, gotoView } from "./_helpers";

test("should autofill an explicit template, save unchanged, customize its pattern and retain it after reload", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-explicit-template-"));
  await gotoView(page, "rules");
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rules-workspace").fill(workspace);
  await expect(page.getByTestId("rule-protection-presets")).toHaveCount(0);
  await page.getByTestId("rules-applied-tab").click();
  await page.getByTestId("rule-new").click();
  await expect(page.getByTestId("event-rule-reason")).toHaveValue("");
  await page.getByTestId("rule-template").selectOption("block-command-pattern");
  await expect(page.getByTestId("rule-filter-value").nth(0)).toHaveValue("Bash");
  await expect(page.getByTestId("rule-filter-value").nth(1)).toHaveValue("\\brm\\s+-rf\\b");
  await expect(page.getByTestId("rule-template-limits")).toContainText("does not cover rm -fr");
  await page.getByTestId("event-rule-save").click();
  const row = page.getByTestId("saved-event-rule");
  await expect(row).toContainText("block-command-pattern");
  async function check(command: string): Promise<string> {
    return (
      await apiPost<{ decision: string }>(request, "/rules/check", {
        id: "probe",
        session_id: "browser",
        backend: "claude",
        cwd: workspace,
        phase: "pre_tool",
        tool: "Bash",
        input: { command },
      })
    ).decision;
  }
  expect(await check("rm -rf build")).toBe("deny");
  expect(await check("rm -fr build")).toBe("abstain");
  expect(await check("python delete.py")).toBe("abstain");
  await row.getByTestId("event-rule-edit").click();
  await page.getByTestId("rule-filter-value").nth(1).fill("\\brm\\s+-(?:rf|fr)\\b");
  await page.getByTestId("event-rule-save").click();
  await expect(page.getByTestId("rule-editor-panel")).toHaveCount(0);
  expect(await check("rm -fr build")).toBe("deny");
  await page.reload();
  await row.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("rule-filter-value").nth(1)).toHaveValue("\\brm\\s+-(?:rf|fr)\\b");
});
