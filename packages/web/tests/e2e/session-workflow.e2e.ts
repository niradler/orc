import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LIVE_REGISTRY_DIR, writeRegistration } from "../../../core/src/live-session";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

for (const width of [1440, 390]) {
  test(`agent journey preserves scope, task association and resume actions at ${width}px`, async ({
    page,
    request,
    context,
  }, testInfo) => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-session-workflow-"));
    const projectName = tid("session-workflow");
    execFileSync("git", ["init", cwd], { timeout: 10000, stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", cwd, "remote", "add", "origin", `https://example.invalid/${projectName}.git`],
      { timeout: 10000 },
    );
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: projectName,
      scope: cwd,
    });
    const task = await apiPost<{ id: string; title: string }>(request, "/tasks", {
      title: tid("Review terminal continuity"),
      project_id: project.id,
      status: "blocked",
    });
    const externalId = crypto.randomUUID();
    const title = tid("Native conversation");
    const transcript = join(cwd, "session.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the terminal workflow" }] } })}\n`,
    );
    mkdirSync(LIVE_REGISTRY_DIR, { recursive: true });
    const registration = {
      backend: "codex",
      externalId,
      pid: process.pid,
      title,
      cwd,
      transcriptPath: transcript,
      status: "running" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeRegistration(registration);
    await apiPost(request, "/sessions/live/sync", {});
    const live = await apiGet<{ sessions: { id: string; session_id: string }[] }>(
      request,
      "/sessions/live?active=false",
    );
    const session = live.sessions.find((item) => item.session_id === externalId);
    expect(session).toBeDefined();
    await page.setViewportSize({ width, height: 950 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await gotoView(page, "activity");
    await page.goto(`/activity?project=${project.id}`);
    await page
      .locator(`[data-testid="activity-session-link"][data-session-id="${session?.id}"]`)
      .click();
    await expect(page).toHaveURL(new RegExp(`session=${session?.id}.*project=${project.id}`));
    const detail = page.getByTestId("live-session-detail");
    await expect(detail.getByTestId("transcript-turn")).toContainText(
      "Inspect the terminal workflow",
    );
    await expect(detail.getByTestId("open-chat-resume")).toHaveText("Resume");
    await expect(page.getByTestId("copy-resume")).toHaveCount(0);
    await detail.getByTestId("resume-actions-menu").press("Enter");
    await page.getByTestId("copy-resume").click();
    await expect(page.getByTestId("resume-actions-dropdown")).toHaveCount(0);
    await expect(detail.getByTestId("resume-feedback")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      `codex resume ${externalId}`,
    );
    await detail.getByTestId("link-task").click();
    const picker = page.getByTestId("session-task-dialog");
    await picker.getByTestId("session-task-search").fill(task.title);
    await picker.getByTestId("session-task-option").click();
    await expect(picker).toBeHidden();
    await expect(detail.getByTestId("detail-open-task")).toHaveText(task.title);
    await expect(detail).toContainText("Blocked");
    await page.keyboard.press("Escape");
    await page.getByTestId("session-search").fill(title);
    const row = page.locator(`[data-testid="live-session-row"][data-session-id="${externalId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator("select[data-testid='link-task']")).toHaveCount(0);
    await row.getByTestId("open-task").click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}.*project=${project.id}`));
    const taskSession = page.getByTestId("task-session-row").filter({ hasText: title });
    await expect(taskSession).toBeVisible();
    await taskSession.getByTestId("task-session-link").click();
    await expect(page).toHaveURL(new RegExp(`session=${session?.id}.*project=${project.id}`));
    await expect(detail.getByTestId("transcript-turn")).toContainText(
      "Inspect the terminal workflow",
    );
    await page.keyboard.press("Escape");
    await row.getByTestId("link-task").click();
    await picker.getByTestId("session-task-unlink").click();
    await expect(picker).toBeHidden();
    await expect(row.getByTestId("open-task")).toHaveCount(0);
    await page.reload();
    await expect(row.getByTestId("open-task")).toHaveCount(0);
    await row.getByTestId("resume-actions-menu").click();
    await expect(page.getByTestId("copy-resume")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row.getByTestId("resume-actions-menu")).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`session-workflow-${width}.png`),
      fullPage: true,
    });
    writeRegistration({ ...registration, status: "stopped", updatedAt: Date.now() });
    await apiPost(request, "/sessions/live/sync", {});
    await expect(page.getByTestId("show-ended")).toBeChecked();
    await expect(row).toBeVisible();
    if (width < 1024) await page.getByTestId("view-filters-toggle").click();
    await page.getByTestId("show-ended").click();
    await expect(row).toHaveCount(0);
    await page.getByTestId("show-ended").click();
    await expect(page.getByTestId("show-ended")).toBeChecked();
    await expect(row).toBeVisible();
    await row.getByTestId("resume-actions-menu").click();
    await expect(page.getByTestId("copy-resume")).toBeVisible();
  });
}
