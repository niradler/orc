import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

function recordRule(id: string) {
  return {
    id,
    kind: "event",
    enabled: true,
    reason: "Record shared continuity",
    scope: { agents: "all", events: ["post_tool"] },
    filter: { match: "all", conditions: [] },
    target: { type: "orc_action", action: "record_event", event_type: "auto", timeout_ms: 1000 },
  };
}

test("should show only a table by default, offer both add paths, and persist project and agent settings", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-rule-settings-browser-"));
  const first = await apiPost<{ id: string }>(request, "/projects", { name: tid("rules-first") });
  const second = await apiPost<{ id: string }>(request, "/projects", { name: tid("rules-second") });
  await apiPost(request, "/rules/activate", {
    policy: { workspace, project_id: first.id, rules: [recordRule("share-events")] },
    expected_id: null,
    reason: "Initial settings",
  });
  await gotoView(page, "rules");
  await page.getByTestId("rules-workspace-filter").selectOption(workspace);
  await expect(page.getByTestId("applied-rules-table")).toBeVisible();
  await expect(page.getByTestId("rules-workspace")).toHaveCount(0);
  await expect(page.getByTestId("rule-catalog")).toHaveCount(0);
  await expect(page.getByTestId("event-rule-editor")).toHaveCount(0);
  await page.getByTestId("rule-new").click();
  await expect(page.getByTestId("rule-template")).toHaveValue("");
  await expect(page.getByTestId("event-rule-editor")).toHaveCount(1);
  await page.getByTestId("sheet-close").click();
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rule-policy-project").selectOption(second.id);
  await page.getByTestId("rule-agent-assignment").selectOption("codex");
  await page.getByTestId("rules-settings-save").click();
  await expect(page.getByTestId("rules-message")).toContainText("Settings saved");
  await page.reload();
  await expect(page.getByTestId("rules-settings-tab")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("rules-applied-tab").click();
  const row = page.getByTestId("saved-event-rule");
  await expect(row).toContainText("codex");
  await row.getByTestId("event-rule-toggle").click();
  await expect(row).toContainText("Disabled");
  await page.reload();
  await expect(row).toContainText("Disabled");
  await row.getByTestId("event-rule-toggle").click();
  await expect(row).toContainText("Enabled");
  await page.getByTestId("rules-settings-tab").click();
  await expect(page.getByTestId("rule-policy-project")).toHaveValue(second.id);
  await expect(page.getByTestId("rule-agent-assignment")).toHaveValue("codex");
  const state = await apiGet<{
    history: { current: boolean; workspace: string; project_id: string }[];
  }>(request, "/rules");
  expect(
    state.history.find((revision) => revision.current && revision.workspace === workspace)
      ?.project_id,
  ).toBe(second.id);
});

test("should preserve a concurrent policy update and show the failed stale edit in its panel", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-rule-concurrent-browser-"));
  const initial = await apiPost<{ id: string }>(request, "/rules/activate", {
    policy: { workspace, project_id: null, rules: [recordRule("existing-rule")] },
    expected_id: null,
    reason: "Initial policy",
  });
  await gotoView(page, "rules");
  await page.getByTestId("rules-workspace-filter").selectOption(workspace);
  await page.getByTestId("event-rule-edit").click();
  await page.getByTestId("event-rule-reason").fill("My local edit");
  await apiPost(request, "/rules/activate", {
    policy: {
      workspace,
      project_id: null,
      rules: [recordRule("existing-rule"), recordRule("concurrent-rule")],
    },
    expected_id: initial.id,
    reason: "Concurrent update",
  });
  await page.getByTestId("event-rule-save").click();
  await expect(page.getByTestId("rule-save-error")).toBeVisible();
  await expect(page.getByTestId("rule-editor-panel")).toBeVisible();
  await page.getByTestId("sheet-close").click();
  await page.reload();
  await expect(page.getByTestId("saved-event-rule")).toHaveCount(2);
  await expect(page.getByTestId("applied-rules-table")).toContainText("concurrent-rule");
});
