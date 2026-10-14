import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiGet, gotoView } from "./_helpers";

test("should load a catalog rule as an editable draft and retain the customized copy after reload", async ({
  page,
  request,
}) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-rule-catalog-browser-"));
  await gotoView(page, "rules");
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rules-workspace").fill(workspace);
  await page.getByTestId("rules-reason").fill("My reusable rule");
  await page.getByTestId("rules-applied-tab").click();
  await page.getByTestId("rule-new").click();
  await page.getByTestId("rule-template").selectOption("rtk-git");
  await expect(page.getByTestId("event-rule-id")).toHaveValue("rtk-git");
  await expect(page.getByTestId("rule-target")).toHaveValue("rewrite_command");
  const before = await apiGet<{ history: { workspace: string }[] }>(request, "/rules");
  expect(before.history.some((entry) => entry.workspace === workspace)).toBe(false);
  await page.getByTestId("event-rule-id").fill("my-git-router");
  await page.getByTestId("rule-processor-argv").fill('["my-router", "{command}"]');
  await page.getByTestId("event-rule-save").click();
  const revision = page.getByTestId("rule-revision").filter({ hasText: workspace });
  await expect(revision.getByTestId("saved-event-rule")).toContainText("my-git-router");
  await page.reload();
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rules-workspace").fill(workspace.split("\\").join("/"));
  await page.getByTestId("rules-applied-tab").click();
  await revision.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("event-rule-id")).toBeInViewport();
  await expect(page.getByTestId("event-rule-id")).toBeFocused();
  await expect(page.getByTestId("rule-processor-argv")).toHaveValue(
    '[\n  "my-router",\n  "{command}"\n]',
  );
  await page.getByTestId("sheet-close").click();
  await page.getByTestId("rules-applied-tab").click();
  await page.getByTestId("rule-new").click();
  await page.getByTestId("rule-template").selectOption("rtk-git");
  await expect(page.getByTestId("event-rule-id")).toHaveValue("rtk-git");
  await expect(page.getByTestId("rule-processor-argv")).toHaveValue(
    '[\n  "rtk",\n  "rewrite",\n  "{command}"\n]',
  );
});

test("should save and reopen a customized built-in memory rule", async ({ page }) => {
  const workspace = mkdtempSync(join(tmpdir(), "orc-memory-catalog-browser-"));
  const directory = join(workspace, "shared-notes");
  await gotoView(page, "rules");
  await page.getByTestId("rules-settings-tab").click();
  await page.getByTestId("rules-workspace").fill(workspace);
  await page.getByTestId("rules-reason").fill("Configured native memory sharing");
  await page.getByTestId("rules-applied-tab").click();
  await page.getByTestId("rule-new").click();
  await page.getByTestId("rule-template").selectOption("claude-share-memory");
  await expect(page.getByTestId("rule-orc-action")).toHaveValue("sync_agent_memory");
  await page.getByTestId("rule-memory-directory").fill(directory);
  await page.getByTestId("rule-orc-timeout").fill("1800");
  await page.getByTestId("event-rule-save").click();
  const revision = page.getByTestId("rule-revision").filter({ hasText: workspace });
  await expect(revision.getByTestId("saved-event-rule")).toContainText("claude-share-memory");
  await page.reload();
  await revision.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("event-rule-id")).toBeInViewport();
  await expect(page.getByTestId("event-rule-id")).toBeFocused();
  await expect(page.getByTestId("rule-orc-action")).toHaveValue("sync_agent_memory");
  await expect(page.getByTestId("rule-memory-directory")).toHaveValue(directory);
  await expect(page.getByTestId("rule-orc-timeout")).toHaveValue("1800");
  await page.keyboard.press("Escape");
  await expect(revision.getByTestId("event-rule-edit")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await revision.getByTestId("event-rule-edit").click();
  await expect(page.getByTestId("rule-editor-panel")).toBeVisible();
  await expect(page.getByTestId("event-rule-id")).toBeInViewport();
  await expect(page.getByTestId("event-rule-id")).toBeFocused();
  const panel = await page.getByTestId("rule-editor-panel").boundingBox();
  expect(panel?.x).toBeGreaterThanOrEqual(0);
  expect(panel?.width).toBeLessThanOrEqual(390);
});
