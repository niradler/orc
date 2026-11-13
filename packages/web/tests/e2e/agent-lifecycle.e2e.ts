import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LIVE_REGISTRY_DIR, writeRegistration } from "../../../core/src/live-session";
import { apiPost, gotoView } from "./_helpers";

const agents = ["claude", "codex", "cursor", "cursor-agent", "gemini"];
const prefix = `parity-${process.pid}`;

test("registered agents share idle visibility, transcripts, task links and terminal actions", async ({
  page,
  request,
}) => {
  const createdAt = Date.now() - 3_600_000;
  mkdirSync(LIVE_REGISTRY_DIR, { recursive: true });
  for (const backend of agents) {
    const transcriptPath = join(LIVE_REGISTRY_DIR, `${prefix}-${backend}.jsonl`);
    const message = {
      content: [{ type: "text", text: `Hello from ${backend}` }],
    };
    const line =
      backend === "claude"
        ? { type: "user", message }
        : backend === "codex"
          ? {
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `Hello from ${backend}` }],
              },
            }
          : { role: "user", message };
    writeFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
    writeRegistration({
      backend,
      externalId: `${prefix}-${backend}`,
      pid: process.pid,
      title: `${backend} lifecycle parity`,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      transcriptPath,
    });
  }
  await apiPost(request, "/sessions/live/sync", {});
  const task = await apiPost<{ id: string }>(request, "/tasks", {
    title: `${prefix} task`,
  });
  await gotoView(page, "sessions");
  // This lifecycle assertion concerns active sessions; archive browsing can show ended rows.
  const showEnded = page.getByTestId("show-ended");
  if (await showEnded.isChecked()) await showEnded.click();
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  for (const backend of agents) {
    await page.getByTestId("agent-filter").selectOption(backend);
    const row = page.locator(
      `[data-testid="live-session-row"][data-session-id="${prefix}-${backend}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId("live-status")).toHaveText("Idle");
    await row.getByTestId("link-task").click();
    const picker = page.getByTestId("session-task-dialog");
    await picker.locator(`[data-testid="session-task-option"][data-task-id="${task.id}"]`).click();
    await expect(picker).toBeHidden();
    await expect(row.getByTestId("open-task")).toBeVisible();
    if (backend !== "cursor") await expect(row.getByTestId("open-chat-resume")).toBeVisible();
    if (backend !== "cursor") {
      await row.getByTestId("resume-actions-menu").click();
      await expect(page.getByTestId("open-terminal-resume")).toHaveText("Terminal");
      await expect(page.getByTestId("copy-resume")).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await row.getByRole("button", { name: `${backend} lifecycle parity` }).click();
    await expect(page.getByTestId("live-session-detail")).toBeVisible();
    await expect(page.getByTestId("transcript-turn")).toContainText(`Hello from ${backend}`);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("live-session-detail")).toBeHidden();
    await expect(page).not.toHaveURL(/session=/);
  }
  // The bug was a 30-second cutoff: an owned idle session must survive it.
  await page.waitForTimeout(31_000);
  for (const backend of agents) {
    await page.getByTestId("agent-filter").selectOption(backend);
    await expect(
      page.locator(`[data-testid="live-session-row"][data-session-id="${prefix}-${backend}"]`),
    ).toBeVisible();
  }
  // Ended rows are hidden by the active-only filter; enable archive visibility
  // before checking the stopped registrations and then verify hiding them again.
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  await page.getByTestId("show-ended").click();
  await expect(page.getByTestId("show-ended")).toBeChecked();
  await expect(page).toHaveURL(/ended=1/);
  for (const backend of agents)
    writeRegistration({
      backend,
      externalId: `${prefix}-${backend}`,
      pid: process.pid,
      title: `${backend} lifecycle parity`,
      status: "stopped",
      createdAt,
      updatedAt: Date.now(),
    });
  await apiPost(request, "/sessions/live/sync", {});
  for (const backend of agents) {
    await page.getByTestId("agent-filter").selectOption(backend);
    const row = page.locator(
      `[data-testid="live-session-row"][data-session-id="${prefix}-${backend}"]`,
    );
    await expect(row.getByTestId("live-status")).toHaveText("Done");
    await row.getByRole("button", { name: `${backend} lifecycle parity` }).click();
    await expect(page.getByTestId("transcript-unavailable")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("live-session-detail")).toBeHidden();
    await expect(row.getByTestId("live-status")).toHaveText("Ended");
  }
  await page.getByTestId("show-ended").click();
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  await expect(page).toHaveURL(/ended=0/);
  await expect(page.getByTestId("live-session-row")).toHaveCount(0);
});

test("renames and hides a session and keeps both across a re-sync and reload", async ({
  page,
  request,
}) => {
  const id = `housekeeping-${process.pid}`;
  const createdAt = Date.now() - 60_000;
  mkdirSync(LIVE_REGISTRY_DIR, { recursive: true });
  const transcriptPath = join(LIVE_REGISTRY_DIR, `${id}.jsonl`);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello" }] } })}\n`,
  );
  writeRegistration({
    backend: "claude",
    externalId: id,
    pid: process.pid,
    title: "native housekeeping title",
    status: "idle",
    createdAt,
    updatedAt: createdAt,
    transcriptPath,
  });
  await apiPost(request, "/sessions/live/sync", {});
  await gotoView(page, "sessions");
  const showEnded = page.getByTestId("show-ended");
  if (await showEnded.isChecked()) await showEnded.click();
  await page.getByTestId("agent-filter").selectOption("claude");
  const row = page.locator(`[data-testid="live-session-row"][data-session-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("native housekeeping title");

  await row.getByTestId("resume-actions-menu").click();
  await page.getByTestId("rename-session").click();
  await page.getByTestId("session-rename-input").fill("Readable session name");
  await page.getByTestId("session-rename-save").click();
  await expect(row).toContainText("Readable session name");

  // A re-sync rewrites the agent title, so the rename must live on its own column.
  await page.getByTestId("sync-sessions").click();
  await expect(row).toContainText("Readable session name");

  await row.getByTestId("resume-actions-menu").click();
  await page.getByTestId("hide-session").click();
  await expect(row).toHaveCount(0);

  const showHidden = page.getByTestId("show-hidden");
  await showHidden.click();
  await expect(showHidden).toBeChecked();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("session-hidden-badge")).toBeVisible();

  // Both survive a reload, which re-reads the database instead of the list state.
  await page.reload();
  await page.getByTestId("agent-filter").selectOption("claude");
  const reloaded = page.locator(`[data-testid="live-session-row"][data-session-id="${id}"]`);
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Readable session name");
  await expect(reloaded.getByTestId("session-hidden-badge")).toBeVisible();

  await reloaded.getByTestId("resume-actions-menu").click();
  await page.getByTestId("unhide-session").click();
  await expect(reloaded.getByTestId("session-hidden-badge")).toHaveCount(0);
});
