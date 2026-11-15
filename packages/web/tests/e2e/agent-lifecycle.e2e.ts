import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LIVE_REGISTRY_DIR, writeRegistration } from "../../../core/src/live-session";
import { apiGet, apiPost, gotoView } from "./_helpers";

const agents = ["claude", "codex", "cursor", "cursor-agent", "gemini"];
const prefix = `parity-${process.pid}`;

/** Chat lists Cursor IDE and Cursor CLI under one filter. */
const filterFor = (backend: string) => (backend.startsWith("cursor") ? "cursor" : backend);

test("registered agents share idle visibility, transcripts, task links and session views", async ({
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
  const live = await apiGet<{ sessions: { id: string; session_id: string }[] }>(
    request,
    "/sessions/live?active=false",
  );
  const liveId = (backend: string) =>
    live.sessions.find((session) => session.session_id === `${prefix}-${backend}`)?.id;
  const task = await apiPost<{ id: string }>(request, "/tasks", {
    title: `${prefix} task`,
  });
  await gotoView(page, "sessions");
  for (const backend of agents) {
    await page.getByTestId("chat-session-agent").selectOption(filterFor(backend));
    const row = page.locator(
      `[data-testid="chat-history-row"][data-history-id="native:${liveId(backend)}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId("chat-session-status")).toHaveAttribute("data-state", "idle");
    await row.getByTestId("chat-session-view").click();
    const view = page.getByTestId("session-view");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("transcript-turn")).toContainText(`Hello from ${backend}`);
    await view.getByTestId("link-task").click();
    const picker = page.getByTestId("session-task-dialog");
    await picker.locator(`[data-testid="session-task-option"][data-task-id="${task.id}"]`).click();
    await expect(picker).toBeHidden();
    await expect(view.getByTestId("detail-open-task")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(view).toBeHidden();
    await expect(row.getByTestId("chat-session-status")).toHaveAttribute("data-state", "idle");
    await expect(page).not.toHaveURL(/sessionView=/);
  }
  // The bug was a 30-second cutoff: an owned idle session must survive it.
  await page.waitForTimeout(31_000);
  for (const backend of agents) {
    await page.getByTestId("chat-session-agent").selectOption(filterFor(backend));
    await expect(
      page.locator(`[data-testid="chat-history-row"][data-history-id="native:${liveId(backend)}"]`),
    ).toBeVisible();
  }
  // Ended sessions stay in the list; a stopped session reads Done until it is opened.
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
  await page.getByTestId("session-list-refresh").click();
  for (const backend of agents) {
    await page.getByTestId("chat-session-agent").selectOption(filterFor(backend));
    const row = page.locator(
      `[data-testid="chat-history-row"][data-history-id="native:${liveId(backend)}"]`,
    );
    await expect(row.getByTestId("chat-session-status")).toHaveAttribute("data-state", "done");
    await row.getByTestId("chat-session-view").click();
    await expect(page.getByTestId("transcript-unavailable")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-view")).toBeHidden();
    await expect(row.getByTestId("chat-session-status")).toHaveAttribute("data-state", "ended");
  }
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
  const listed = await apiGet<{ sessions: { id: string; session_id: string }[] }>(
    request,
    "/sessions/live?active=false",
  );
  const liveId = listed.sessions.find((session) => session.session_id === id)?.id;
  await gotoView(page, "sessions");
  await page.getByTestId("chat-session-agent").selectOption("claude");
  const row = page.locator(`[data-testid="chat-history-row"][data-history-id="native:${liveId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("native housekeeping title");

  await row.getByTestId("chat-session-view").click();
  const view = page.getByTestId("session-view");
  await view.getByTestId("rename-session").click();
  await page.getByTestId("session-rename-input").fill("Readable session name");
  await page.getByTestId("session-rename-save").click();
  await expect(view).toContainText("Readable session name");

  // A re-sync rewrites the agent title, so the rename must live on its own column.
  await page.keyboard.press("Escape");
  await expect(row).toContainText("Readable session name");
  await page.getByTestId("session-list-refresh").click();
  await expect(row).toContainText("Readable session name");

  await row.getByTestId("chat-session-view").click();
  await view.getByTestId("hide-session").click();
  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(0);

  const showHidden = page.getByTestId("chat-session-hidden");
  await showHidden.click();
  await expect(showHidden).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeVisible();
  await expect(row.getByTestId("chat-session-hidden-badge")).toBeVisible();

  // Both survive a reload, which re-reads the database instead of the list state.
  await page.reload();
  await page.getByTestId("chat-session-agent").selectOption("claude");
  const reloaded = page.locator(
    `[data-testid="chat-history-row"][data-history-id="native:${liveId}"]`,
  );
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Readable session name");
  await expect(reloaded.getByTestId("chat-session-hidden-badge")).toBeVisible();

  await reloaded.getByTestId("chat-session-view").click();
  await page.getByTestId("unhide-session").click();
  await expect(page.getByTestId("chat-session-hidden-badge")).toHaveCount(0);
});
