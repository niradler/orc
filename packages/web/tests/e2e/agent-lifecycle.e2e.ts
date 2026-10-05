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
    const message = { content: [{ type: "text", text: `Hello from ${backend}` }] };
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
  const task = await apiPost<{ id: string }>(request, "/tasks", { title: `${prefix} task` });
  await gotoView(page, "sessions");
  for (const backend of agents) {
    await page.getByTestId("agent-filter").selectOption(backend);
    const row = page.locator(
      `[data-testid="live-session-row"][data-session-id="${prefix}-${backend}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row.getByTestId("live-status")).toHaveText("waiting for you");
    await row.getByTestId("link-task").selectOption(task.id);
    await expect(row.getByTestId("open-task")).toBeVisible();
    if (backend !== "cursor") await expect(row.getByTestId("open-terminal-resume")).toBeVisible();
    await row.click();
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
  await expect(page.getByTestId("live-session-row")).toHaveCount(0);
});
