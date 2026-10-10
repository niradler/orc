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
    await expect(page.getByTestId("rules-panel")).toBeVisible();
    await page.getByTestId("rules-workspace").fill(workspace);
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
